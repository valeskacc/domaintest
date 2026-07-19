import { h, render } from "https://esm.sh/preact@10";
import { useState, useEffect, useRef } from "https://esm.sh/preact@10/hooks";
import htm from "https://esm.sh/htm@3";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const html = htm.bind(h);

const SUPABASE_URL = "https://qcsezegptoblkpvwhtzx.supabase.co";
const SUPABASE_KEY = "sb_publishable_PkA4IRR8xTrug-JgY-vN5g_EsH34zNB";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/* Offline: App-Hülle + CDN-Module per Service Worker cachen, damit die App auch ganz ohne Netz öffnet */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  // Sobald eine aktualisierte Service-Worker-Version übernimmt, einmal neu laden,
  // damit ein zuvor fehlerhafter Stand nicht hängen bleibt.
  let swReloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (swReloaded) return;
    swReloaded = true;
    location.reload();
  });
}

/* Aufräumen: früher gesetzte, zu große Login-Cookies auf .valeska.cc entfernen –
   sie ließen Cloudflare Anfragen mit HTTP 403 ablehnen. Die Anmeldung bleibt pro
   App über den localStorage erhalten. */
(function clearLegacyAuthCookies() {
  try {
    if (!location.hostname.endsWith("valeska.cc")) return;
    for (const c of (document.cookie ? document.cookie.split("; ") : [])) {
      const name = c.slice(0, c.indexOf("="));
      if (!name || !name.startsWith("sb-")) continue;
      document.cookie = name + "=; path=/; max-age=0; SameSite=Lax; Secure; domain=.valeska.cc";
      document.cookie = name + "=; path=/; max-age=0; SameSite=Lax; Secure";
    }
  } catch (e) {}
})();

/* ---------- Cross-App SSO über einen Session-Vermittler (Edge Function) ----------
   Ein zufälliger, bedeutungsloser Broker-Token (keine echten Zugangsdaten!) liegt in
   einem kleinen Cookie auf .valeska.cc. Öffnet eine andere *.valeska.cc-App frisch
   (neuer Tab, eigenes Home-Bildschirm-Icon), löst sie den Token bei der Edge Function
   ein und meldet sich damit automatisch an – inkl. bereits bestätigtem 2FA-Status. */
const BROKER_URL = "https://qcsezegptoblkpvwhtzx.supabase.co/functions/v1/session-broker";
const BROKER_COOKIE = "vsk-sso";
function brokerCookieGet() {
  const m = document.cookie.match(new RegExp("(?:^|; )" + BROKER_COOKIE + "=([^;]+)"));
  return m ? m[1] : null;
}
function brokerCookieSet(id) {
  const domain = location.hostname.endsWith("valeska.cc") ? "; domain=.valeska.cc" : "";
  document.cookie = BROKER_COOKIE + "=" + id + "; path=/; max-age=" + (60 * 86400) + "; SameSite=Lax; Secure" + domain;
}
function brokerCookieClear() {
  const domain = location.hostname.endsWith("valeska.cc") ? "; domain=.valeska.cc" : "";
  document.cookie = BROKER_COOKIE + "=; path=/; max-age=0; SameSite=Lax; Secure" + domain;
}
async function brokerCall(action, payload) {
  try {
    const res = await fetch(BROKER_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
    });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, body };
  } catch (e) { return { ok: false, networkError: true }; }
}
async function brokerMint(session) {
  if (!session) return;
  const r = await brokerCall("mint", { access_token: session.access_token, refresh_token: session.refresh_token });
  if (r.ok && r.body && r.body.broker_id) brokerCookieSet(r.body.broker_id);
}
async function brokerRedeem() {
  const id = brokerCookieGet();
  if (!id) return null;
  const r = await brokerCall("redeem", { broker_id: id });
  // Netzfehler (z. B. offline): Cookie unangetastet lassen, es beim nächsten Mal erneut
  // versuchen. Nur eine echte "ungültig"-Antwort vom Server löscht ihn wirklich.
  if (r.networkError) return null;
  if (!r.ok || !r.body || !r.body.refresh_token) { brokerCookieClear(); return null; }
  const { data, error } = await sb.auth.refreshSession({ refresh_token: r.body.refresh_token });
  if (error || !data.session) { brokerCookieClear(); return null; }
  brokerMint(data.session);
  return data.session;
}
async function brokerRevoke() {
  const id = brokerCookieGet();
  brokerCookieClear();
  if (id) brokerCall("revoke", { broker_id: id });
}
async function signOutEverywhere() {
  await brokerRevoke();
  await sb.auth.signOut();
}

/* „Diesem Gerät vertrauen" – 60 Tage kein 2FA-Code nötig */
const TRUST_KEY = "sb-mfa-trust";
function deviceTrusted() { try { return Number(localStorage.getItem(TRUST_KEY) || 0) > Date.now(); } catch (e) { return false; } }
function setDeviceTrust(on) { try { on ? localStorage.setItem(TRUST_KEY, String(Date.now() + 60 * 864e5)) : localStorage.removeItem(TRUST_KEY); } catch (e) {} }

/* Footer-Navigation zwischen den Apps */
function Footer({ current }) {
  const apps = [
    { k: "home", i: "⌂", l: "Home", u: "https://home.valeska.cc" },
    { k: "travel", i: "🧳", l: "Reisen", u: "https://travel.valeska.cc" },
    { k: "todo", i: "✅", l: "To-Do", u: "https://todo.valeska.cc" },
    { k: "kauf", i: "♻️", l: "Kauf", u: "https://kauf.valeska.cc" },
  ];
  return html`
    <nav class="appnav">
      ${apps.map((a) => html`
        <a class=${a.k === current ? "active" : ""} href=${a.u}>
          <span class="i">${a.i}</span><span>${a.l}</span>
        </a>`)}
    </nav>`;
}

/* ---------- Helfer ---------- */
function fmtDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "numeric" });
}

/* ---------- Offline: letzten Datenstand cachen + Änderungen puffern ----------
   Beim Laden wird der Erfolg im localStorage gesichert; schlägt ein Ladevorgang
   (kein Netz) fehl, zeigen wir stattdessen den letzten bekannten Stand. Schreibende
   Aktionen, die offline oder wegen eines Netzfehlers scheitern, landen in einer
   kleinen Warteschlange und werden automatisch nachgeholt, sobald wieder Netz da ist. */
function cacheGet(key) {
  try { const raw = localStorage.getItem("cache:" + key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
function cacheSet(key, data) {
  try { localStorage.setItem("cache:" + key, JSON.stringify({ data, at: Date.now() })); } catch (e) {}
}
async function loadWithCache(key, loader) {
  try {
    if (!navigator.onLine) throw new Error("offline");
    const data = await loader();
    cacheSet(key, data);
    return { data, offline: false };
  } catch (e) {
    const cached = cacheGet(key);
    return { data: cached ? cached.data : null, offline: true, at: cached ? cached.at : null };
  }
}

const OUTBOX_KEY = "cache:outbox";
function outboxGet() { try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]"); } catch (e) { return []; } }
function outboxSet(q) { try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(q)); } catch (e) {} }
function outboxPush(op) { const q = outboxGet(); q.push(op); outboxSet(q); window.dispatchEvent(new Event("outbox-changed")); }
function applyMatch(query, op) {
  if (op.matchOr) return query.or(op.matchOr);
  Object.entries(op.match || {}).forEach(([k, v]) => { query = query.eq(k, v); });
  return query;
}
async function outboxFlush() {
  const q = outboxGet();
  if (!q.length || !navigator.onLine) return 0;
  let ok = 0; const remaining = [];
  for (const op of q) {
    try {
      let query = sb.from(op.table);
      if (op.type === "insert") query = query.insert(op.payload);
      else if (op.type === "update") query = applyMatch(query.update(op.payload), op);
      else if (op.type === "delete") query = applyMatch(query.delete(), op);
      const { error } = await query;
      if (error) remaining.push(op); else ok++;
    } catch (e) { remaining.push(op); }
  }
  outboxSet(remaining);
  window.dispatchEvent(new Event("outbox-changed"));
  if (ok > 0) window.dispatchEvent(new Event("outbox-flushed"));
  return ok;
}
async function trySb(promise, queueOp) {
  if (!navigator.onLine) { outboxPush(queueOp); return { queued: true }; }
  try {
    const { error } = await promise;
    if (error) { outboxPush(queueOp); return { queued: true, error }; }
    return { queued: false };
  } catch (e) { outboxPush(queueOp); return { queued: true, error: e }; }
}
function useOutbox() {
  const [n, setN] = useState(outboxGet().length);
  useEffect(() => {
    function refresh() { setN(outboxGet().length); }
    async function tryFlush() { await outboxFlush(); refresh(); }
    window.addEventListener("outbox-changed", refresh);
    window.addEventListener("online", tryFlush);
    tryFlush();
    return () => { window.removeEventListener("outbox-changed", refresh); window.removeEventListener("online", tryFlush); };
  }, []);
  return n;
}
function OfflineBanner({ offline, at, pending }) {
  if (!offline && !pending) return "";
  return html`
    <div class="offlinebar">
      ${offline
        ? html`🔌 Offline${at ? " – Stand " + new Date(at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) + " Uhr" : ""}`
        : html`🔄 ${pending} Änderung${pending === 1 ? "" : "en"} werden synchronisiert …`}
    </div>`;
}

/* ---------- Bestätigungs-Dialog ---------- */
function ConfirmModal({ text, sub, yes = "OK", danger, onYes, onClose }) {
  return html`
    <div class="overlay" onClick=${onClose}>
      <div class="modal" onClick=${(e) => e.stopPropagation()}>
        <h3>${text}</h3>
        ${sub && html`<p class="muted" style="margin:6px 0 0">${sub}</p>`}
        <div class="row2">
          <button class="ghost" onClick=${onClose}>Abbrechen</button>
          <button class=${danger ? "danger-solid" : "primary"} onClick=${onYes}>${yes}</button>
        </div>
      </div>
    </div>`;
}

/* ---------- App ---------- */
function App() {
  const [session, setSession] = useState(undefined);
  const [aal, setAal] = useState(null);

  async function refreshAal() {
    const { data } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    setAal(data || { currentLevel: "aal1", nextLevel: "aal1" });
  }
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await sb.auth.getSession();
      if (data.session) { if (!cancelled) setSession(data.session); return; }
      const s = await brokerRedeem();
      if (!cancelled) setSession(s || null);
    })();
    const { data: sub } = sb.auth.onAuthStateChange((event, s) => {
      setSession(s ?? null);
      if (s && (event === "SIGNED_IN" || event === "TOKEN_REFRESHED")) brokerMint(s);
    });
    return () => { cancelled = true; sub.subscription.unsubscribe(); };
  }, []);
  useEffect(() => { if (session) refreshAal(); else setAal(null); }, [session]);

  if (session === undefined) return html`<div class="spinner"></div>`;
  if (!session) return html`<${Login} />`;
  if (aal === null) return html`<div class="spinner"></div>`;
  if (aal.currentLevel === "aal1" && aal.nextLevel === "aal2" && !deviceTrusted())
    return html`<${MfaChallenge} onDone=${refreshAal} onLogout=${signOutEverywhere} />`;

  return html`
    <header class="appbar">
      <div class="title">♻️ Kauf → 2 raus</div>
      <a href="https://home.valeska.cc" style="text-decoration:none"><button>⌂ Home</button></a>
      <button onClick=${signOutEverywhere}>Logout</button>
    </header>
    <main>
      <${Board} />
      <${Footer} current="kauf" />
    </main>
  `;
}

/* ---------- Board ---------- */
function Board() {
  const [data, setData] = useState(null); // { purchases, gmap }
  const [offline, setOffline] = useState(false);
  const [offlineAt, setOfflineAt] = useState(null);
  const pending = useOutbox();
  const [tab, setTab] = useState("open");
  const [editor, setEditor] = useState(false);
  const [confirm, setConfirm] = useState(null);

  function buildData(purchases, gives) {
    const gmap = {};
    (gives || []).forEach((x) => { (gmap[x.purchase_id] ||= []).push(x); });
    return { purchases: purchases || [], gmap };
  }

  async function load() {
    const r = await loadWithCache("kauf_data", async () => {
      const [{ data: p, error: pe }, { data: g, error: ge }] = await Promise.all([
        sb.from("purchases").select("*").order("created_at", { ascending: false }),
        sb.from("give_ups").select("*").order("created_at"),
      ]);
      if (pe || ge) throw (pe || ge);
      return { purchases: p || [], gives: g || [] };
    });
    const raw = r.data || { purchases: [], gives: [] };
    setData(buildData(raw.purchases, raw.gives));
    setOffline(r.offline); setOfflineAt(r.at);
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const onFlushed = () => load();
    window.addEventListener("outbox-flushed", onFlushed);
    return () => window.removeEventListener("outbox-flushed", onFlushed);
  }, []);

  async function addGive(p, name) {
    const n = name.trim(); if (!n) return;
    const cnt = (data.gmap[p.id] || []).length;
    const give = { id: crypto.randomUUID(), purchase_id: p.id, name: n, created_at: new Date().toISOString() };
    const willResolve = cnt + 1 >= 2 && !p.resolved_at;
    setData((cur) => ({
      gmap: { ...cur.gmap, [p.id]: [...(cur.gmap[p.id] || []), give] },
      purchases: willResolve
        ? cur.purchases.map((x) => (x.id === p.id ? { ...x, resolved_at: give.created_at } : x))
        : cur.purchases,
    }));
    await trySb(sb.from("give_ups").insert(give), { type: "insert", table: "give_ups", payload: give });
    if (willResolve) {
      await trySb(sb.from("purchases").update({ resolved_at: give.created_at }).eq("id", p.id),
        { type: "update", table: "purchases", payload: { resolved_at: give.created_at }, match: { id: p.id } });
    }
  }
  async function removeGive(p, id) {
    const cnt = (data.gmap[p.id] || []).length;
    const willReopen = cnt - 1 < 2 && p.resolved_at;
    setData((cur) => ({
      gmap: { ...cur.gmap, [p.id]: (cur.gmap[p.id] || []).filter((g) => g.id !== id) },
      purchases: willReopen ? cur.purchases.map((x) => (x.id === p.id ? { ...x, resolved_at: null } : x)) : cur.purchases,
    }));
    await trySb(sb.from("give_ups").delete().eq("id", id), { type: "delete", table: "give_ups", match: { id } });
    if (willReopen) {
      await trySb(sb.from("purchases").update({ resolved_at: null }).eq("id", p.id),
        { type: "update", table: "purchases", payload: { resolved_at: null }, match: { id: p.id } });
    }
  }
  function askDelete(p) {
    setConfirm({
      text: `„${p.name}" löschen?`, yes: "Löschen", danger: true,
      onYes: async () => {
        setData((cur) => ({ purchases: cur.purchases.filter((x) => x.id !== p.id), gmap: cur.gmap }));
        await trySb(sb.from("purchases").delete().eq("id", p.id), { type: "delete", table: "purchases", match: { id: p.id } });
        setConfirm(null);
      },
    });
  }

  if (data === null) return html`<div class="spinner"></div>`;
  const open = data.purchases.filter((p) => (data.gmap[p.id] || []).length < 2);
  const done = data.purchases
    .filter((p) => (data.gmap[p.id] || []).length >= 2)
    .sort((a, b) => (b.resolved_at || b.created_at).localeCompare(a.resolved_at || a.created_at));
  const listShown = tab === "open" ? open : done;

  return html`
    <${OfflineBanner} offline=${offline} at=${offlineAt} pending=${pending} />
    <div class="tabs">
      <button class=${tab === "open" ? "active" : ""} onClick=${() => setTab("open")}>Offen (${open.length})</button>
      <button class=${tab === "done" ? "active" : ""} onClick=${() => setTab("done")}>Erledigt (${done.length})</button>
    </div>

    ${listShown.length === 0
      ? html`<div class="emptyhint">${tab === "open"
          ? "Nichts offen. Etwas gekauft? Tippe unten auf „+ Gekauft"."
          : "Noch nichts abgeschlossen."}</div>`
      : listShown.map((p) => html`
          <${PurchaseCard} key=${p.id} purchase=${p} gives=${data.gmap[p.id] || []}
            onAdd=${addGive} onRemove=${removeGive} onDelete=${() => askDelete(p)} />`)}

    <button class="fab" onClick=${() => setEditor(true)}>+ Gekauft</button>

    ${editor && html`<${Editor} onClose=${() => setEditor(false)}
        onSaved=${(purchase, gives) => {
          setEditor(false);
          setData((cur) => ({
            purchases: [purchase, ...cur.purchases],
            gmap: gives.length ? { ...cur.gmap, [purchase.id]: gives } : cur.gmap,
          }));
        }} />`}
    ${confirm && html`<${ConfirmModal} text=${confirm.text} sub=${confirm.sub} yes=${confirm.yes}
        danger=${confirm.danger} onYes=${confirm.onYes} onClose=${() => setConfirm(null)} />`}
  `;
}

/* ---------- Eine Kauf-Karte ---------- */
function PurchaseCard({ purchase, gives, onAdd, onRemove, onDelete }) {
  const [val, setVal] = useState("");
  const count = gives.length;
  const remaining = Math.max(0, 2 - count);
  const full = count >= 2;

  function submit() { if (val.trim()) { onAdd(purchase, val); setVal(""); } }

  return html`
    <div class="card pcard">
      <div class="top">
        <div style="flex:1">
          <div class="nm">${full ? "✅ " : "🛒 "}${purchase.name}</div>
          ${purchase.note && html`<div class="note">${purchase.note}</div>`}
        </div>
        <button class="del" title="Löschen" onClick=${onDelete}>🗑</button>
      </div>

      <span class=${"prog" + (full ? " full" : "")}>
        <span class="dots">
          <span class=${"dot" + (count >= 1 ? " on" : "")}></span>
          <span class=${"dot" + (count >= 2 ? " on" : "")}></span>
        </span>
        ${full ? "erledigt" : `${count}/2 abgegeben`}
      </span>

      ${count > 0 && html`
        <div class="glist">
          ${gives.map((g) => html`
            <div class="grow" key=${g.id}>
              <span class="gi">↝</span>
              <span class="gn">${g.name}</span>
              <button class="x" title="Entfernen" onClick=${() => onRemove(purchase, g.id)}>🗑</button>
            </div>`)}
        </div>`}

      ${!full
        ? html`
          <div class="addg">
            <input placeholder=${remaining === 2 ? "Was gibst du dafür ab?" : "Und das zweite Ding?"}
                   value=${val} onInput=${(e) => setVal(e.target.value)}
                   onKeyDown=${(e) => e.key === "Enter" && submit()} />
            <button class="ghost" style="width:auto;min-height:42px" onClick=${submit}>+</button>
          </div>
          <div class="hint">Noch ${remaining} ${remaining === 1 ? "Sache" : "Sachen"} abgeben, dann ist es erledigt.</div>`
        : html`<div class="done-badge">2 Dinge abgegeben – erledigt${purchase.resolved_at ? " am " + fmtDate(purchase.resolved_at) : ""}. 🎉</div>`}
    </div>
  `;
}

/* ---------- Neuer Kauf ---------- */
function Editor({ onClose, onSaved }) {
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [g1, setG1] = useState("");
  const [g2, setG2] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  useEffect(() => { const el = ref.current; if (el) el.focus(); }, []);

  async function save() {
    const nm = name.trim(); if (!nm) return;
    setBusy(true);
    const gs = [g1, g2].map((s) => s.trim()).filter(Boolean);
    const resolved_at = gs.length >= 2 ? new Date().toISOString() : null;
    const purchase = { id: crypto.randomUUID(), name: nm, note: note.trim() || null,
      resolved_at, created_at: new Date().toISOString() };
    await trySb(sb.from("purchases").insert(purchase), { type: "insert", table: "purchases", payload: purchase });
    const gives = gs.map((n) => ({ id: crypto.randomUUID(), purchase_id: purchase.id, name: n, created_at: new Date().toISOString() }));
    for (const give of gives) {
      await trySb(sb.from("give_ups").insert(give), { type: "insert", table: "give_ups", payload: give });
    }
    setBusy(false);
    onSaved(purchase, gives);
  }

  return html`
    <div class="overlay" onClick=${onClose}>
      <div class="modal" onClick=${(e) => e.stopPropagation()}>
        <div class="editbar">
          <button class="ghost" style="width:auto" onClick=${onClose}>Abbrechen</button>
          <strong>Neuer Kauf</strong>
          <button class="primary" style="width:auto" disabled=${busy || !name.trim()} onClick=${save}>${busy ? "…" : "Speichern"}</button>
        </div>
        <label>Was hast du gekauft?</label>
        <input ref=${ref} placeholder="z. B. Toaster" value=${name} onInput=${(e) => setName(e.target.value)} />
        <label>Notiz (optional)</label>
        <textarea placeholder="Details, Grund …" value=${note} onInput=${(e) => setNote(e.target.value)}></textarea>
        <label>Dafür gebe ich ab (optional – geht auch später)</label>
        <input style="margin-bottom:8px" placeholder="1. Ding" value=${g1} onInput=${(e) => setG1(e.target.value)} />
        <input placeholder="2. Ding" value=${g2} onInput=${(e) => setG2(e.target.value)} />
        <div class="hint">Trage jetzt oder später zwei Dinge ein, die dafür gehen – dann gilt der Kauf als „ausgeglichen".</div>
      </div>
    </div>
  `;
}

/* ---------- Login ---------- */
function Login() {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [stay, setStay] = useState(true);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setMsg("");
    try { localStorage.setItem("sb-stay-pref", stay ? "1" : "0"); } catch (e) {}
    try {
      const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password: pw });
      if (error) setMsg(error.message);
    } catch (err) { setMsg("Fehler: " + (err?.message || String(err))); }
    finally { setBusy(false); }
  }
  return html`
    <main>
      <h1 class="center">♻️ Kauf → 2 raus</h1>
      <p class="muted center">Bitte anmelden.</p>
      <div class="card" style="max-width:380px;margin:0 auto">
        <form onSubmit=${submit}>
          <label>E-Mail</label>
          <input type="email" id="email" name="email" autocomplete="username" required value=${email} onInput=${(e) => setEmail(e.target.value)} />
          <label>Passwort</label>
          <input type="password" id="current-password" name="password" autocomplete="current-password" required value=${pw} onInput=${(e) => setPw(e.target.value)} />
          <label class="checkrow">
            <input type="checkbox" checked=${stay} onChange=${(e) => setStay(e.target.checked)} />
            60 Tage auf diesem Gerät angemeldet bleiben (kein 2FA)
          </label>
          ${msg && html`<p class="error" style="margin-top:12px">${msg}</p>`}
          <button class="primary block" style="margin-top:16px" disabled=${busy}>${busy ? "…" : "Anmelden"}</button>
        </form>
      </div>
    </main>
  `;
}

/* ---------- 2FA-Abfrage beim Login ---------- */
function MfaChallenge({ onDone, onLogout }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const { data: f } = await sb.auth.mfa.listFactors();
      const totp = (f?.totp || []).find((x) => x.status === "verified");
      if (!totp) { setErr("Kein 2FA-Faktor gefunden."); setBusy(false); return; }
      const { data: ch, error: e1 } = await sb.auth.mfa.challenge({ factorId: totp.id });
      if (e1) { setErr(e1.message); setBusy(false); return; }
      const { error: e2 } = await sb.auth.mfa.verify({ factorId: totp.id, challengeId: ch.id, code: code.trim() });
      if (e2) { setErr(e2.message); setBusy(false); return; }
      try { setDeviceTrust(localStorage.getItem("sb-stay-pref") !== "0"); } catch (e) {}
      setBusy(false); onDone();
    } catch (err) { setErr(err?.message || String(err)); setBusy(false); }
  }
  return html`
    <main>
      <h1 class="center">🔐 2-Faktor</h1>
      <p class="muted center">Code aus deiner Authenticator-App eingeben.</p>
      <div class="card" style="max-width:380px;margin:0 auto">
        <form onSubmit=${submit}>
          <label>6-stelliger Code</label>
          <input inputmode="numeric" autocomplete="one-time-code" placeholder="123456"
                 value=${code} onInput=${(e) => setCode(e.target.value)} />
          ${err && html`<p class="error" style="margin-top:12px">${err}</p>`}
          <button class="primary block" style="margin-top:16px" disabled=${busy}>${busy ? "…" : "Bestätigen"}</button>
        </form>
        <button class="ghost block" style="margin-top:10px" onClick=${onLogout}>Abbrechen / Logout</button>
      </div>
    </main>
  `;
}

render(html`<${App} />`, document.getElementById("app"));
