import { h, render } from "https://esm.sh/preact@10";
import { useState, useEffect, useRef } from "https://esm.sh/preact@10/hooks";
import htm from "https://esm.sh/htm@3";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const html = htm.bind(h);

const SUPABASE_URL = "https://qcsezegptoblkpvwhtzx.supabase.co";
const SUPABASE_KEY = "sb_publishable_PkA4IRR8xTrug-JgY-vN5g_EsH34zNB";

/* Session dauerhaft speichern und über alle *.valeska.cc-Apps teilen (SSO) */
const COOKIE_DOMAIN = location.hostname.endsWith("valeska.cc") ? "; domain=.valeska.cc" : "";
const COOKIE_SET = "; path=/; max-age=34560000; SameSite=Lax; Secure" + COOKIE_DOMAIN;
const COOKIE_DEL = "; path=/; max-age=0; SameSite=Lax; Secure" + COOKIE_DOMAIN;
const CHUNK = 3200;
function readCookies() {
  const o = {};
  for (const c of (document.cookie ? document.cookie.split("; ") : [])) {
    const i = c.indexOf("=");
    if (i > 0) o[c.slice(0, i)] = c.slice(i + 1);
  }
  return o;
}
const cookieStorage = {
  getItem(key) {
    const c = readCookies();
    if (c[key] != null) return decodeURIComponent(c[key]);
    if (c[key + ".0"] != null) {
      let i = 0, out = "";
      while (c[key + "." + i] != null) { out += c[key + "." + i]; i++; }
      return decodeURIComponent(out);
    }
    try { return localStorage.getItem(key); } catch (e) { return null; }
  },
  setItem(key, value) {
    this.removeItem(key, true);
    const enc = encodeURIComponent(value);
    if (enc.length <= CHUNK) document.cookie = key + "=" + enc + COOKIE_SET;
    else for (let i = 0, n = Math.ceil(enc.length / CHUNK); i < n; i++)
      document.cookie = key + "." + i + "=" + enc.slice(i * CHUNK, (i + 1) * CHUNK) + COOKIE_SET;
    try { localStorage.setItem(key, value); } catch (e) {}
  },
  removeItem(key, keepLocal) {
    const c = readCookies();
    if (c[key] != null) document.cookie = key + "=" + COOKIE_DEL;
    let i = 0;
    while (c[key + "." + i] != null) { document.cookie = key + "." + i + "=" + COOKIE_DEL; i++; }
    if (!keepLocal) { try { localStorage.removeItem(key); } catch (e) {} }
  },
};
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { storage: cookieStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

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
    sb.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);
  useEffect(() => { if (session) refreshAal(); else setAal(null); }, [session]);

  if (session === undefined) return html`<div class="spinner"></div>`;
  if (!session) return html`<${Login} />`;
  if (aal === null) return html`<div class="spinner"></div>`;
  if (aal.currentLevel === "aal1" && aal.nextLevel === "aal2")
    return html`<${MfaChallenge} onDone=${refreshAal} onLogout=${() => sb.auth.signOut()} />`;

  return html`
    <header class="appbar">
      <div class="title">♻️ Kauf → 2 raus</div>
      <a href="https://home.valeska.cc" style="text-decoration:none"><button>⌂ Home</button></a>
      <button onClick=${() => sb.auth.signOut()}>Logout</button>
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
  const [tab, setTab] = useState("open");
  const [editor, setEditor] = useState(false);
  const [confirm, setConfirm] = useState(null);

  async function load() {
    const [{ data: p }, { data: g }] = await Promise.all([
      sb.from("purchases").select("*").order("created_at", { ascending: false }),
      sb.from("give_ups").select("*").order("created_at"),
    ]);
    const gmap = {};
    (g || []).forEach((x) => { (gmap[x.purchase_id] ||= []).push(x); });
    setData({ purchases: p || [], gmap });
  }
  useEffect(() => { load(); }, []);

  async function addGive(p, name) {
    const n = name.trim(); if (!n) return;
    const cnt = (data.gmap[p.id] || []).length;
    await sb.from("give_ups").insert({ purchase_id: p.id, name: n });
    if (cnt + 1 >= 2 && !p.resolved_at)
      await sb.from("purchases").update({ resolved_at: new Date().toISOString() }).eq("id", p.id);
    load();
  }
  async function removeGive(p, id) {
    const cnt = (data.gmap[p.id] || []).length;
    await sb.from("give_ups").delete().eq("id", id);
    if (cnt - 1 < 2 && p.resolved_at)
      await sb.from("purchases").update({ resolved_at: null }).eq("id", p.id);
    load();
  }
  function askDelete(p) {
    setConfirm({
      text: `„${p.name}" löschen?`, yes: "Löschen", danger: true,
      onYes: async () => { await sb.from("purchases").delete().eq("id", p.id); setConfirm(null); load(); },
    });
  }

  if (data === null) return html`<div class="spinner"></div>`;
  const open = data.purchases.filter((p) => (data.gmap[p.id] || []).length < 2);
  const done = data.purchases
    .filter((p) => (data.gmap[p.id] || []).length >= 2)
    .sort((a, b) => (b.resolved_at || b.created_at).localeCompare(a.resolved_at || a.created_at));
  const listShown = tab === "open" ? open : done;

  return html`
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

    ${editor && html`<${Editor} onClose=${() => setEditor(false)} onSaved=${() => { setEditor(false); load(); }} />`}
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
    const { data: p } = await sb.from("purchases")
      .insert({ name: nm, note: note.trim() || null }).select().single();
    const gs = [g1, g2].map((s) => s.trim()).filter(Boolean);
    if (p && gs.length) await sb.from("give_ups").insert(gs.map((n) => ({ purchase_id: p.id, name: n })));
    if (p && gs.length >= 2) await sb.from("purchases").update({ resolved_at: new Date().toISOString() }).eq("id", p.id);
    setBusy(false);
    onSaved();
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
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setMsg("");
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
          <input type="email" name="email" autocomplete="username" required value=${email} onInput=${(e) => setEmail(e.target.value)} />
          <label>Passwort</label>
          <input type="password" name="password" autocomplete="current-password" required value=${pw} onInput=${(e) => setPw(e.target.value)} />
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
