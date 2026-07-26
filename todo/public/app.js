import { h, render } from "https://esm.sh/preact@10";
import { useState, useEffect, useRef } from "https://esm.sh/preact@10/hooks";
import htm from "https://esm.sh/htm@3";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const html = htm.bind(h);

const SUPABASE_URL = "https://qcsezegptoblkpvwhtzx.supabase.co";
const SUPABASE_KEY = "sb_publishable_PkA4IRR8xTrug-JgY-vN5g_EsH34zNB";

// Jeder Netzwerk-Aufruf (Auth-Refresh, Datenabfragen) bekommt hier ein kurzes
// eigenes Zeitlimit. Ohne das wartet der Client bei totalem Verbindungsverlust
// (z. B. Flugmodus) auf das systemeigene Timeout des Betriebssystems - das kann
// 30-40+ Sekunden dauern, bevor überhaupt auf den Offline-Cache zurückgefallen wird.
function fetchWithTimeout(url, options, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  global: { fetch: (url, options) => fetchWithTimeout(url, options, 8000) },
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
    const res = await fetchWithTimeout(BROKER_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
    }, 6000);
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

// Bei komplettem Verbindungsverlust (z. B. Flugmodus) NIE versuchen, die Sitzung
// übers Netz zu bestätigen/erneuern - das kann trotz Zeitlimit mehrfach intern
// wiederholt werden und dadurch weiterhin sehr lange dauern. Stattdessen sofort
// und synchron die zuletzt bekannte Sitzung direkt aus dem Speicher lesen.
function readLocalSession() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !/^sb-.*-auth-token$/.test(key)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const session = parsed && (parsed.currentSession || parsed);
      if (session && session.access_token && session.user) return session;
    }
  } catch (e) {}
  return null;
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
const pad = (n) => String(n).padStart(2, "0");
const localYmd = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const localHm = (d) => pad(d.getHours()) + ":" + pad(d.getMinutes());
const today = () => localYmd(new Date());
function dayLabel(ymd) {
  if (!ymd) return "";
  const t = today();
  if (ymd === t) return "Heute";
  if (ymd === localYmd(new Date(Date.now() + 864e5))) return "Morgen";
  if (ymd === localYmd(new Date(Date.now() - 864e5))) return "Gestern";
  return new Date(ymd + "T00:00:00").toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "short" });
}
const fmtDay = dayLabel;
const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : "";
function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return dayLabel(localYmd(d)) + ", " + fmtTime(iso) + " Uhr";
}
// Kompakte Datumsanzeige für die Listenzeile (klein)
const fmtDueShort = (iso) => iso ? dayLabel(localYmd(new Date(iso))) : "";
// Gruppiert erledigte Aufgaben nach Erledigungs-Datum (neueste zuerst)
function groupDone(done) {
  const map = {};
  for (const d of done) { const day = (d.done_at || "").slice(0, 10) || "—"; (map[day] ||= []).push(d); }
  return Object.keys(map).sort((a, b) => b.localeCompare(a)).map((k) => [k, map[k]]);
}
// Baut aus flacher Liste einen {top:[], subs:{parentId:[]}} Baum
function buildTree(rows) {
  const top = [], subs = {};
  for (const r of rows) {
    if (r.parent_id) (subs[r.parent_id] ||= []).push(r);
    else top.push(r);
  }
  return { top, subs };
}

/* ---------- Einkaufs-Kategorien + Auto-Einsortierung ---------- */
const CATEGORIES = ["Obst", "Gemüse", "Milchprodukte", "Fleisch & Fisch", "Brot & Backwaren",
  "Tiefkühl", "Vorräte", "Getränke", "Süßes & Snacks", "Drogerie", "Haushalt", "Sonstiges"];
const CAT_ICON = {
  "Obst": "🍎", "Gemüse": "🥕", "Milchprodukte": "🧀", "Fleisch & Fisch": "🍖", "Brot & Backwaren": "🍞",
  "Tiefkühl": "🧊", "Vorräte": "🥫", "Getränke": "🥤", "Süßes & Snacks": "🍫", "Drogerie": "🧴",
  "Haushalt": "🧻", "Sonstiges": "📦",
};
const CAT_RULES = [
  ["Obst", ["apfel", "äpfel", "banane", "birne", "traube", "beere", "erdbeer", "heidelbeer", "himbeer", "brombeer", "orange", "mandarine", "clementine", "zitrone", "limette", "kiwi", "mango", "ananas", "pfirsich", "nektarine", "melone", "pflaume", "kirsche", "avocado", "feige", "granatapfel", "datteln"]],
  ["Gemüse", ["tomate", "gurke", "salat", "paprika", "zwiebel", "knoblauch", "kartoffel", "möhre", "karotte", "brokkoli", "blumenkohl", "spinat", "zucchini", "aubergine", "pilz", "champignon", "lauch", "sellerie", "rettich", "radieschen", "kürbis", "mais", "bohne", "erbse", "ingwer", "rucola", "kohl", "spargel", "fenchel", "kräuter", "petersilie", "basilikum"]],
  ["Milchprodukte", ["milch", "joghurt", "jogurt", "quark", "käse", "butter", "sahne", "frischkäse", "mozzarella", "feta", "skyr", "buttermilch", "schmand", "creme fraiche", "pudding", "ei", "eier"]],
  ["Fleisch & Fisch", ["fleisch", "hähnchen", "hühnchen", "hack", "wurst", "schinken", "salami", "lachs", "fisch", "thunfisch", "garnele", "rind", "schwein", "pute", "speck", "aufschnitt", "frikadelle", "steak"]],
  ["Brot & Backwaren", ["brot", "brötchen", "toast", "baguette", "croissant", "kuchen", "semmel", "brezel", "knäcke"]],
  ["Tiefkühl", ["tiefkühl", "tk ", "eis", "pizza", "pommes"]],
  ["Vorräte", ["nudel", "pasta", "spaghetti", "reis", "mehl", "zucker", "salz", "pfeffer", "öl", "essig", "konserve", "dose", "tomatenmark", "passata", "müsli", "haferflocken", "cornflakes", "honig", "marmelade", "nutella", "gewürz", "brühe", "linse", "couscous", "senf", "ketchup", "mayo"]],
  ["Getränke", ["wasser", "saft", "cola", "limo", "bier", "wein", "kaffee", "tee", "sprudel", "schorle", "getränk"]],
  ["Süßes & Snacks", ["schokolade", "schoko", "keks", "chips", "gummibär", "bonbon", "riegel", "nüsse", "snack", "süßigkeit", "waffel", "müsliriegel"]],
  ["Drogerie", ["shampoo", "duschgel", "seife", "zahnpasta", "zahnbürste", "deo", "creme", "windel", "tampon", "binde", "rasier", "watte", "toilettenpapier", "klopapier", "taschentuch", "sonnencreme", "pflaster"]],
  ["Haushalt", ["spülmittel", "waschmittel", "weichspüler", "müllbeutel", "müllsack", "putz", "reiniger", "schwamm", "alufolie", "frischhalte", "backpapier", "batterie", "kerze", "serviette", "spültab"]],
];
function guessCategory(name) {
  const n = (name || "").toLowerCase();
  for (const [cat, words] of CAT_RULES) if (words.some((w) => n.includes(w))) return cat;
  return "Sonstiges";
}
const catOrder = (c) => { const i = CATEGORIES.indexOf(c); return i < 0 ? CATEGORIES.length : i; };

/* ---------- Drag & Drop (Zeiger-basiert, funktioniert auch mobil) ---------- */
function Sortable({ ids, render, onCommit, movedRef }) {
  const [order, setOrder] = useState(ids);
  const orderRef = useRef(ids);
  const commitRef = useRef(onCommit);
  const dragId = useRef(null);
  const moved = useRef(false);
  const contRef = useRef(null);
  commitRef.current = onCommit;
  orderRef.current = order;
  useEffect(() => { setOrder(ids); orderRef.current = ids; }, [ids.join("|")]);

  useEffect(() => {
    function onMove(e) {
      if (dragId.current == null) return;
      e.preventDefault();
      const cont = contRef.current; if (!cont) return;
      const rows = Array.from(cont.querySelectorAll("[data-sid]"));
      const y = e.clientY;
      let beforeId = null;
      for (const r of rows) {
        const b = r.getBoundingClientRect();
        if (y < b.top + b.height / 2) { beforeId = r.getAttribute("data-sid"); break; }
      }
      setOrder((cur) => {
        const id = dragId.current;
        const at = cur.indexOf(id);
        const without = cur.filter((x) => x !== id);
        let idx = beforeId == null ? without.length : without.indexOf(beforeId);
        if (idx < 0) idx = without.length;
        without.splice(idx, 0, id);
        if (without.indexOf(id) !== at) moved.current = true;
        return without;
      });
    }
    function onUp() {
      if (dragId.current == null) return;
      dragId.current = null;
      document.body.style.userSelect = "";
      if (moved.current) { if (movedRef) movedRef.current = Date.now(); commitRef.current(orderRef.current); }
      moved.current = false;
    }
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  function start(e, id) {
    e.preventDefault();
    dragId.current = id; moved.current = false;
    document.body.style.userSelect = "none";
  }

  return html`
    <div ref=${contRef}>
      ${order.map((id) => render(id, (e) => start(e, id), dragId.current === id))}
    </div>`;
}

/* ---------- Offline: letzten Datenstand cachen + Änderungen puffern ----------
   Beim Laden wird der Erfolg im localStorage gesichert; schlägt ein Ladevorgang
   (kein Netz) fehl, zeigen wir stattdessen den letzten bekannten Stand. Schreibende
   Aktionen (anlegen/abhaken/löschen), die offline oder wegen eines Netzfehlers
   scheitern, landen in einer kleinen Warteschlange und werden automatisch
   nachgeholt, sobald wieder Netz da ist. */
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
  // Eigenes Ereignis nur bei echter Synchronisierung – nicht beim bloßen Einreihen
  // offline –, sonst würde ein Neu-Laden den gerade optimistisch gezeigten Stand
  // sofort wieder mit dem (noch alten) Cache überschreiben.
  if (ok > 0) window.dispatchEvent(new Event("outbox-flushed"));
  return ok;
}
// Schreibt sofort; bei Fehler/offline wird die Aktion optimistisch lokal übernommen und gepuffert.
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

/* ---------- Aufgabe/Artikel in eine andere Liste verschieben ---------- */
function MoveListModal({ task, currentListId, onClose, onMoved }) {
  const [lists, setLists] = useState(null);
  useEffect(() => {
    sb.from("todo_lists").select("id,name,kind").neq("id", currentListId).order("name")
      .then(({ data }) => setLists(data || []));
  }, []);
  async function move(listId) {
    await sb.from("todos").update({ list_id: listId }).or(`id.eq.${task.id},parent_id.eq.${task.id}`);
    onMoved();
  }
  return html`
    <div class="overlay" onClick=${onClose}>
      <div class="modal" onClick=${(e) => e.stopPropagation()}>
        <div class="editbar">
          <button class="ghost" style="width:auto" onClick=${onClose}>Abbrechen</button>
          <strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">„${task.title}" verschieben</strong>
          <span style="width:1px"></span>
        </div>
        ${lists === null
          ? html`<div class="spinner"></div>`
          : lists.length === 0
            ? html`<div class="emptyhint">Keine andere Liste vorhanden.</div>`
            : html`<div class="picklist">
                ${lists.map((l) => html`
                  <button class="pickrow" key=${l.id} onClick=${() => move(l.id)}>
                    <span>${l.kind === "shopping" ? "🛒" : "📝"}</span>
                    <span style="flex:1;text-align:left">${l.name}</span>
                  </button>`)}
              </div>`}
      </div>
    </div>
  `;
}

/* ---------- Bestätigungs-Dialog im App-Stil ---------- */
function ConfirmModal({ text, sub, yes = "OK", danger, onYes, onClose }) {
  return html`
    <div class="overlay" onClick=${onClose}>
      <div class="modal confirm" onClick=${(e) => e.stopPropagation()}>
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
  const [view, setView] = useState({ name: "home" });
  const [tab, setTab] = useState("lists"); // lists | all
  const [shareList, setShareList] = useState(null);

  async function refreshAal() {
    const { data } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    setAal(data || { currentLevel: "aal1", nextLevel: "aal1" });
  }
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!navigator.onLine) {
        const local = readLocalSession();
        if (local) { if (!cancelled) setSession(local); return; }
        // Kein erkennbares lokales Sitzungsformat gefunden - sicherheitshalber den
        // normalen (ggf. langsameren) Weg versuchen statt fälschlich abzumelden.
      }
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

  const go = (v) => setView(v);
  return html`
    <header class="appbar">
      ${view.name === "list"
        ? html`<button onClick=${() => go({ name: "home" })}>‹</button>`
        : ""}
      <div class="title" style="cursor:pointer" onClick=${() => go({ name: "home" })}>
        ${view.name === "list" ? view.list.name : "✅ To-Do"}
      </div>
      ${view.name === "list" && html`<button title="Liste teilen" onClick=${() => setShareList(view.list)}>🔗</button>`}
      <a href="https://home.valeska.cc" style="text-decoration:none"><button>⌂ Home</button></a>
      <button onClick=${signOutEverywhere}>Logout</button>
    </header>
    <main>
      ${view.name === "home"
        ? html`<${Home} tab=${tab} setTab=${setTab} go=${go} />`
        : view.list.kind === "shopping"
          ? html`<${ShoppingView} list=${view.list} />`
          : html`<${ListView} list=${view.list} />`}
      <${Footer} current="todo" />
    </main>
    ${shareList && html`<${ShareModal} list=${shareList} onClose=${() => setShareList(null)} />`}
  `;
}

/* ---------- Liste per Link teilen (ohne Login, nur diese eine Liste) ---------- */
function ShareModal({ list, onClose }) {
  const [token, setToken] = useState(undefined); // undefined=lädt, null=nicht freigegeben, string=Link aktiv
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    sb.from("todo_lists").select("share_token").eq("id", list.id).single()
      .then(({ data }) => setToken(data ? data.share_token : null));
  }, [list.id]);

  const link = token ? `${location.origin}/share/${token}` : "";

  async function enable() {
    setBusy(true);
    const { data, error } = await sb.rpc("enable_share", { p_list_id: list.id });
    setBusy(false);
    if (!error) setToken(data);
  }
  async function disable() {
    setBusy(true);
    await sb.rpc("disable_share", { p_list_id: list.id });
    setBusy(false);
    setToken(null);
  }
  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (e) {}
  }

  return html`
    <div class="overlay" onClick=${onClose}>
      <div class="modal" onClick=${(e) => e.stopPropagation()}>
        <div class="editbar">
          <button class="ghost" style="width:auto" onClick=${onClose}>Schließen</button>
          <strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">„${list.name}" teilen</strong>
          <span style="width:1px"></span>
        </div>
        ${token === undefined
          ? html`<div class="spinner"></div>`
          : token
            ? html`
              <p class="muted" style="margin-top:0">Wer diesen Link öffnet, kann Einträge in <strong>genau dieser Liste</strong> hinzufügen, ändern und löschen – ohne Login. Der Rest der App bleibt geschlossen.</p>
              <div style="word-break:break-all;background:#0a1413;border:1px solid var(--border);border-radius:10px;padding:12px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.85rem">${link}</div>
              <button class="primary block" style="margin-top:12px" onClick=${copy}>${copied ? "✓ Kopiert" : "🔗 Link kopieren"}</button>
              <button class="ghost block" style="margin-top:10px;color:var(--danger)" disabled=${busy} onClick=${disable}>${busy ? "…" : "Freigabe beenden"}</button>`
            : html`
              <p class="muted" style="margin-top:0">Erzeuge einen Link, mit dem andere – ohne eigenes Konto – nur diese Liste sehen und bearbeiten können.</p>
              <button class="primary block" disabled=${busy} onClick=${enable}>${busy ? "…" : "Freigabe aktivieren"}</button>`}
      </div>
    </div>
  `;
}

/* ---------- Startseite: Tabs Listen / Alle ---------- */
function Home({ tab, setTab, go }) {
  return html`
    <div class="tabs">
      <button class=${tab === "lists" ? "active" : ""} onClick=${() => setTab("lists")}>Listen</button>
      <button class=${tab === "shopping" ? "active" : ""} onClick=${() => setTab("shopping")}>🛒 Einkaufen</button>
      <button class=${tab === "all" ? "active" : ""} onClick=${() => setTab("all")}>Alle Aufgaben</button>
    </div>
    ${tab === "lists" ? html`<${ListsTab} go=${go} />`
      : tab === "shopping" ? html`<${ShoppingHub} />`
      : html`<${AllTab} go=${go} />`}
  `;
}

/* ---------- Tab: Listenübersicht (Drag & Drop) ---------- */
function ListsTab({ go }) {
  const [lists, setLists] = useState(null);
  const [counts, setCounts] = useState({});
  const [offline, setOffline] = useState(false);
  const [offlineAt, setOfflineAt] = useState(null);
  const pending = useOutbox();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("todo");
  const [confirm, setConfirm] = useState(null);
  const movedRef = useRef(0);

  async function load() {
    const r = await loadWithCache("todo_lists", async () => {
      const { data, error } = await sb.from("todo_lists").select("*").order("sort").order("created_at");
      if (error) throw error;
      return data || [];
    });
    setLists(r.data || []); setOffline(r.offline); setOfflineAt(r.at);
    if (!r.offline) {
      const { data: t } = await sb.from("todos").select("list_id").eq("done", false).is("parent_id", null);
      const c = {};
      (t || []).forEach((row) => { c[row.list_id] = (c[row.list_id] || 0) + 1; });
      setCounts(c);
    }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const onFlushed = () => load();
    window.addEventListener("outbox-flushed", onFlushed);
    return () => window.removeEventListener("outbox-flushed", onFlushed);
  }, []);

  async function create() {
    const nm = name.trim();
    if (!nm) return;
    setName(""); setAdding(false);
    const row = { id: crypto.randomUUID(), name: nm, kind, sort: Date.now(), created_at: new Date().toISOString() };
    setLists((cur) => [...(cur || []), row]);
    await trySb(sb.from("todo_lists").insert(row), { type: "insert", table: "todo_lists", payload: row });
    setKind("todo");
  }
  function askDel(l) {
    setConfirm({
      text: `Liste „${l.name}" löschen?`,
      sub: "Alle Aufgaben dieser Liste werden mitgelöscht.",
      yes: "Löschen", danger: true,
      onYes: async () => {
        setLists((cur) => (cur || []).filter((x) => x.id !== l.id));
        await trySb(sb.from("todo_lists").delete().eq("id", l.id), { type: "delete", table: "todo_lists", match: { id: l.id } });
        setConfirm(null);
      },
    });
  }
  async function commit(ids) {
    await Promise.all(ids.map((id, i) => sb.from("todo_lists").update({ sort: i }).eq("id", id)));
    load();
  }

  if (lists === null) return html`<div class="spinner"></div>`;
  const byId = {}; lists.forEach((l) => (byId[l.id] = l));

  return html`
    <${OfflineBanner} offline=${offline} at=${offlineAt} pending=${pending} />
    ${adding
      ? html`
        <div class="card" style="margin-bottom:14px">
          <label>Name der Liste</label>
          <input autofocus placeholder="z. B. Einkauf, Arbeit, Umzug …" value=${name}
                 onInput=${(e) => setName(e.target.value)}
                 onKeyDown=${(e) => e.key === "Enter" && create()} />
          <label>Typ</label>
          <div class="seg">
            <button class=${kind === "todo" ? "on" : ""} onClick=${() => setKind("todo")}>📝 To-Do</button>
            <button class=${kind === "shopping" ? "on" : ""} onClick=${() => setKind("shopping")}>🛒 Einkauf</button>
          </div>
          <div class="row2">
            <button class="ghost" onClick=${() => { setAdding(false); setName(""); setKind("todo"); }}>Abbrechen</button>
            <button class="primary" onClick=${create}>Anlegen</button>
          </div>
        </div>`
      : html`<button class="primary block" style="margin-bottom:14px" onClick=${() => setAdding(true)}>+ Neue Liste</button>`}

    ${lists.length === 0 && !adding
      ? html`<div class="emptyhint">Noch keine Listen. Leg deine erste Liste an. 📝</div>`
      : html`<${Sortable} ids=${lists.map((l) => l.id)} movedRef=${movedRef} onCommit=${commit}
          render=${(id, onDown, dragging) => {
            const l = byId[id]; if (!l) return null;
            return html`
              <div class=${"card listcard" + (dragging ? " dragging" : "")} data-sid=${id} key=${id}
                   onClick=${() => { if (Date.now() - movedRef.current < 250) return; go({ name: "list", list: l }); }}>
                <span class="drag" title="Ziehen zum Sortieren" onPointerDown=${onDown}>⋮⋮</span>
                <div class="nm">${l.kind === "shopping" ? "🛒 " : ""}${l.name}</div>
                <div class="cnt">${counts[id] || 0}</div>
                <button class="del" title="Löschen" onClick=${(e) => { e.stopPropagation(); askDel(l); }}>🗑</button>
              </div>`;
          }} />`}

    ${confirm && html`<${ConfirmModal} text=${confirm.text} sub=${confirm.sub} yes=${confirm.yes}
        danger=${confirm.danger} onYes=${confirm.onYes} onClose=${() => setConfirm(null)} />`}
  `;
}

/* ---------- Tab: Alle Aufgaben (gruppiert) ---------- */
function AllTab({ go }) {
  const [data, setData] = useState(null); // {tree, listMap}
  const [open, setOpen] = useState({});

  async function load() {
    const { data: lists } = await sb.from("todo_lists").select("id,name,kind");
    const listMap = {}, shop = {};
    (lists || []).forEach((l) => { listMap[l.id] = l; if (l.kind === "shopping") shop[l.id] = true; });
    const { data: rows } = await sb.from("todos").select("*").eq("done", false);
    // Einkaufslisten-Artikel gehören nicht in die Aufgaben-Übersicht
    const filtered = (rows || []).filter((r) => !shop[r.list_id]);
    setData({ tree: buildTree(filtered), listMap });
  }
  useEffect(() => { load(); }, []);

  if (data === null) return html`<div class="spinner"></div>`;
  const { top, subs } = data.tree;
  const withDue = top.filter((t) => t.due_at).sort((a, b) => a.due_at.localeCompare(b.due_at));
  const withPrio = top.filter((t) => !t.due_at && t.priority).sort((a, b) => a.priority - b.priority);
  const rest = top.filter((t) => !t.due_at && !t.priority);
  const openTask = (t) => go({ name: "list", list: data.listMap[t.list_id] || { id: t.list_id, name: "Liste" } });

  if (top.length === 0)
    return html`<div class="emptyhint">Keine offenen Aufgaben. Alles erledigt! 🎉</div>`;

  const section = (title, items) => items.length > 0 && html`
    <h2>${title}</h2>
    ${items.map((t) => html`
      <${TaskRow} key=${t.id} task=${t} subs=${subs[t.id] || []}
        open=${!!open[t.id]} toggleOpen=${() => setOpen((o) => ({ ...o, [t.id]: !o[t.id] }))}
        listName=${data.listMap[t.list_id]} onChange=${load} onOpen=${openTask} showSub=${true} />`)}
  `;

  return html`
    ${section("📅 Mit Zieldatum", withDue)}
    ${section("⭐ Nach Priorität", withPrio)}
    ${section("Ohne Datum / Priorität", rest)}
  `;
}

/* ---------- Listenansicht ---------- */
function ListView({ list }) {
  const [rows, setRows] = useState(null);
  const [offline, setOffline] = useState(false);
  const [offlineAt, setOfflineAt] = useState(null);
  const pending = useOutbox();
  const [open, setOpen] = useState({});
  const [editor, setEditor] = useState(null);   // null | {task} | {task:null}
  const [detailId, setDetailId] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [moveTask, setMoveTask] = useState(null);
  const movedRef = useRef(0);

  async function load() {
    const r = await loadWithCache("todos:" + list.id, async () => {
      const { data, error } = await sb.from("todos").select("*").eq("list_id", list.id).order("created_at");
      if (error) throw error;
      return data || [];
    });
    setRows(r.data || []); setOffline(r.offline); setOfflineAt(r.at);
  }
  useEffect(() => { load(); }, [list.id]);
  useEffect(() => {
    const onFlushed = () => load();
    window.addEventListener("outbox-flushed", onFlushed);
    return () => window.removeEventListener("outbox-flushed", onFlushed);
  }, [list.id]);

  async function complete(t) {
    const done_at = new Date().toISOString();
    setRows((cur) => (cur || []).map((r) => (r.id === t.id || r.parent_id === t.id) ? { ...r, done: true, done_at } : r));
    await trySb(
      sb.from("todos").update({ done: true, done_at }).or(`id.eq.${t.id},parent_id.eq.${t.id}`),
      { type: "update", table: "todos", payload: { done: true, done_at }, matchOr: `id.eq.${t.id},parent_id.eq.${t.id}` });
  }
  async function restore(id) {
    setRows((cur) => (cur || []).map((r) => (r.id === id ? { ...r, done: false, done_at: null } : r)));
    await trySb(sb.from("todos").update({ done: false, done_at: null }).eq("id", id),
      { type: "update", table: "todos", payload: { done: false, done_at: null }, match: { id } });
  }
  function askDelPerm(d) {
    setConfirm({ text: `„${d.title}" endgültig löschen?`, yes: "Löschen", danger: true,
      onYes: async () => {
        setRows((cur) => (cur || []).filter((r) => r.id !== d.id));
        await trySb(sb.from("todos").delete().eq("id", d.id), { type: "delete", table: "todos", match: { id: d.id } });
        setConfirm(null);
      } });
  }
  function askDelTask(t, after) {
    setConfirm({ text: `Aufgabe „${t.title}" löschen?`, yes: "Löschen", danger: true,
      onYes: async () => {
        setRows((cur) => (cur || []).filter((r) => r.id !== t.id && r.parent_id !== t.id));
        await trySb(sb.from("todos").delete().or(`id.eq.${t.id},parent_id.eq.${t.id}`),
          { type: "delete", table: "todos", matchOr: `id.eq.${t.id},parent_id.eq.${t.id}` });
        setConfirm(null); if (after) after();
      } });
  }
  async function commit(ids) {
    await Promise.all(ids.map((id, i) => sb.from("todos").update({ sort: i }).eq("id", id)));
    load();
  }
  const openDetail = (t) => { if (Date.now() - movedRef.current < 250) return; setDetailId(t.id); };

  if (rows === null) return html`<div class="spinner"></div>`;
  const active = rows.filter((r) => !r.done);
  const done = rows.filter((r) => r.done).sort((a, b) => (b.done_at || "").localeCompare(a.done_at || ""));
  const { top, subs } = buildTree(active);
  const detailTask = detailId ? rows.find((r) => r.id === detailId && !r.done) : null;

  // In einer Liste sind alle Aufgaben frei per Drag & Drop sortierbar.
  // Reihenfolge = manuelle Sortierung (sort), dann Datum, dann Erstellzeit.
  const ordered = top.slice().sort((a, b) =>
    ((a.sort || 0) - (b.sort || 0)) ||
    ((a.due_at || "9999").localeCompare(b.due_at || "9999")) ||
    ((a.created_at || "").localeCompare(b.created_at || "")));
  const byId = {}; ordered.forEach((t) => (byId[t.id] = t));

  const overlays = html`
    ${editor && html`<${TaskEditor} listId=${list.id} task=${editor.task}
        onClose=${() => setEditor(null)}
        onSaved=${(row, isUpdate) => {
          setEditor(null);
          setRows((cur) => {
            const c = cur || [];
            return isUpdate ? c.map((x) => (x.id === row.id ? { ...x, ...row } : x)) : [...c, row];
          });
        }} />`}
    ${confirm && html`<${ConfirmModal} text=${confirm.text} sub=${confirm.sub} yes=${confirm.yes}
        danger=${confirm.danger} onYes=${confirm.onYes} onClose=${() => setConfirm(null)} />`}
    ${moveTask && html`<${MoveListModal} task=${moveTask} currentListId=${list.id}
        onClose=${() => setMoveTask(null)} onMoved=${() => { setMoveTask(null); setDetailId(null); load(); }} />`}`;

  if (detailTask) return html`
    <${TaskDetail} task=${detailTask} subs=${subs[detailTask.id] || []}
      onBack=${() => setDetailId(null)} onChange=${load}
      onEdit=${() => setEditor({ task: detailTask })}
      onMove=${() => setMoveTask(detailTask)}
      onDelete=${() => askDelTask(detailTask, () => setDetailId(null))} />
    ${overlays}`;

  return html`
    <${OfflineBanner} offline=${offline} at=${offlineAt} pending=${pending} />
    ${top.length === 0
      ? html`<div class="emptyhint">Noch keine offenen Aufgaben in „${list.name}".<br/>Tippe unten auf <strong>+ Aufgabe</strong>.</div>`
      : html`<${Sortable} ids=${ordered.map((t) => t.id)} movedRef=${movedRef} onCommit=${commit}
          render=${(id, onDown, dragging) => {
            const t = byId[id]; if (!t) return null;
            return html`
              <${TaskRow} key=${id} task=${t} subs=${subs[id] || []}
                open=${!!open[id]} toggleOpen=${() => setOpen((o) => ({ ...o, [id]: !o[id] }))}
                onChange=${load} onOpen=${openDetail} onDelete=${() => askDelTask(t)}
                onMove=${() => setMoveTask(t)} onComplete=${complete}
                dragHandle=${onDown} dragging=${dragging} showSub=${true} />`;
          }} />`}

    ${done.length > 0 && html`
      <div style="margin-top:26px">
        <button class="ghost block" style="text-align:left;display:flex;align-items:center;gap:8px"
                onClick=${() => setShowDone((s) => !s)}>
          <span class=${"caret" + (showDone ? " open" : "")}>▸</span> ✓ Erledigt (${done.length})
        </button>
        ${showDone && groupDone(done).map(([day, items]) => html`
          <h2 key=${day}>${fmtDay(day)}</h2>
          ${items.map((d) => html`
            <div class="task done" key=${d.id}>
              <button class="check" style="background:var(--primary);border-color:transparent" title="Wiederherstellen"
                      onClick=${() => restore(d.id)}>✓</button>
              <div class="body">
                <div class="ttl">${d.title}</div>
                <div class="meta"><span class="chip">${fmtTime(d.done_at)} Uhr</span></div>
              </div>
              <div class="tools">
                <button title="Wiederherstellen" onClick=${() => restore(d.id)}>↩</button>
                <button title="Endgültig löschen" onClick=${() => askDelPerm(d)}>🗑</button>
              </div>
            </div>`)}
        `)}
      </div>`}

    <button class="fab" onClick=${() => setEditor({ task: null })}>+ Aufgabe</button>
    ${overlays}
  `;
}

/* ---------- Tab: Einkaufen (Reiter zwischen Läden/Geschäftstypen) ----------
   Jeder Reiter ist technisch eine eigene Einkaufsliste (kind="shopping") –
   nur direkt nebeneinander erreichbar statt einzeln über "Listen". */
function ShoppingHub() {
  const [lists, setLists] = useState(null);
  const [activeId, setActiveId] = useState(() => {
    try { return localStorage.getItem("todo-shopping-active") || null; } catch (e) { return null; }
  });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  async function load() {
    const { data } = await sb.from("todo_lists").select("*").eq("kind", "shopping")
      .order("sort").order("created_at");
    const ls = data || [];
    setLists(ls);
    setActiveId((cur) => (cur && ls.some((l) => l.id === cur)) ? cur : (ls[0]?.id || null));
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const onFlushed = () => load();
    window.addEventListener("outbox-flushed", onFlushed);
    return () => window.removeEventListener("outbox-flushed", onFlushed);
  }, []);

  function selectTab(id) {
    setActiveId(id);
    try { localStorage.setItem("todo-shopping-active", id); } catch (e) {}
  }

  async function createShop() {
    const nm = name.trim();
    if (!nm) return;
    setName(""); setAdding(false);
    const row = { id: crypto.randomUUID(), name: nm, kind: "shopping", sort: Date.now(), created_at: new Date().toISOString() };
    setLists((cur) => [...(cur || []), row]);
    selectTab(row.id);
    await trySb(sb.from("todo_lists").insert(row), { type: "insert", table: "todo_lists", payload: row });
  }

  if (lists === null) return html`<div class="spinner"></div>`;
  const active = lists.find((l) => l.id === activeId) || null;

  return html`
    <div class="shoptabs">
      ${lists.map((l) => html`
        <button class=${"shoptab" + (l.id === activeId ? " on" : "")} key=${l.id} onClick=${() => selectTab(l.id)}>${l.name}</button>`)}
      <button class="shoptab addshop" onClick=${() => setAdding(true)}>+ Liste/Laden</button>
    </div>
    ${adding && html`
      <div class="card" style="margin-bottom:14px">
        <label>Name des Ladens</label>
        <input autofocus placeholder="z. B. Drogerie, Baumarkt …" value=${name}
               onInput=${(e) => setName(e.target.value)}
               onKeyDown=${(e) => e.key === "Enter" && createShop()} />
        <div class="row2">
          <button class="ghost" onClick=${() => { setAdding(false); setName(""); }}>Abbrechen</button>
          <button class="primary" onClick=${createShop}>Anlegen</button>
        </div>
      </div>`}
    ${lists.length === 0 && !adding
      ? html`<div class="emptyhint">Noch keine Einkaufsliste.<br/>Tippe oben auf <strong>+ Liste/Laden</strong>, um loszulegen (z. B. „Lebensmittel").</div>`
      : active && html`<${ShoppingView} list=${active} />`}
  `;
}

/* ---------- Einkaufsliste: Artikel gruppiert nach Kategorie ---------- */
function ShoppingView({ list }) {
  const [rows, setRows] = useState(null);
  const [offline, setOffline] = useState(false);
  const [offlineAt, setOfflineAt] = useState(null);
  const pending = useOutbox();
  const [showDone, setShowDone] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [moveTask, setMoveTask] = useState(null);

  async function load() {
    const r = await loadWithCache("todos:" + list.id, async () => {
      const { data, error } = await sb.from("todos").select("*").eq("list_id", list.id).order("created_at");
      if (error) throw error;
      return data || [];
    });
    setRows(r.data || []); setOffline(r.offline); setOfflineAt(r.at);
  }
  useEffect(() => { load(); }, [list.id]);
  useEffect(() => {
    const onFlushed = () => load();
    window.addEventListener("outbox-flushed", onFlushed);
    return () => window.removeEventListener("outbox-flushed", onFlushed);
  }, [list.id]);

  async function complete(t) {
    const done_at = new Date().toISOString();
    setRows((cur) => (cur || []).map((r) => (r.id === t.id ? { ...r, done: true, done_at } : r)));
    await trySb(sb.from("todos").update({ done: true, done_at }).eq("id", t.id),
      { type: "update", table: "todos", payload: { done: true, done_at }, match: { id: t.id } });
  }
  async function restore(t) {
    setRows((cur) => (cur || []).map((r) => (r.id === t.id ? { ...r, done: false, done_at: null } : r)));
    await trySb(sb.from("todos").update({ done: false, done_at: null }).eq("id", t.id),
      { type: "update", table: "todos", payload: { done: false, done_at: null }, match: { id: t.id } });
  }
  function askDelete(t) {
    setConfirm({ text: `„${t.title}" löschen?`, yes: "Löschen", danger: true,
      onYes: async () => {
        setRows((cur) => (cur || []).filter((r) => r.id !== t.id));
        await trySb(sb.from("todos").delete().eq("id", t.id), { type: "delete", table: "todos", match: { id: t.id } });
        setConfirm(null);
      } });
  }

  if (rows === null) return html`<div class="spinner"></div>`;
  const active = rows.filter((r) => !r.done);
  const done = rows.filter((r) => r.done).sort((a, b) => (b.done_at || "").localeCompare(a.done_at || ""));

  const groups = {};
  active.forEach((t) => { const c = t.category || "Sonstiges"; (groups[c] ||= []).push(t); });
  const catKeys = Object.keys(groups).sort((a, b) => catOrder(a) - catOrder(b));

  const overlays = html`
    ${adding && html`<${ShoppingAdder} listId=${list.id}
        onClose=${() => setAdding(false)}
        onSaved=${(row) => { setAdding(false); setRows((cur) => [...(cur || []), row]); }} />`}
    ${moveTask && html`<${MoveListModal} task=${moveTask} currentListId=${list.id}
        onClose=${() => setMoveTask(null)} onMoved=${() => { setMoveTask(null); load(); }} />`}
    ${confirm && html`<${ConfirmModal} text=${confirm.text} sub=${confirm.sub} yes=${confirm.yes}
        danger=${confirm.danger} onYes=${confirm.onYes} onClose=${() => setConfirm(null)} />`}`;

  return html`
    <${OfflineBanner} offline=${offline} at=${offlineAt} pending=${pending} />
    ${active.length === 0
      ? html`<div class="emptyhint">Einkaufsliste ist leer.<br/>Tippe unten auf <strong>+ Artikel</strong>.</div>`
      : catKeys.map((cat) => html`
          <h2 key=${cat}>${CAT_ICON[cat] || "📦"} ${cat}</h2>
          ${groups[cat].sort((a, b) => a.title.localeCompare(b.title, "de")).map((t) => html`
            <div class="task" key=${t.id}>
              <button class="check" title="Erledigt" onClick=${() => complete(t)}></button>
              <div class="body"><div class="ttl">${t.title}</div></div>
              <div class="tools">
                <button title="In andere Liste verschieben" onClick=${() => setMoveTask(t)}>↔</button>
                <button title="Löschen" onClick=${() => askDelete(t)}>🗑</button>
              </div>
            </div>`)}
        `)}

    ${done.length > 0 && html`
      <div style="margin-top:26px">
        <button class="ghost block" style="text-align:left;display:flex;align-items:center;gap:8px"
                onClick=${() => setShowDone((s) => !s)}>
          <span class=${"caret" + (showDone ? " open" : "")}>▸</span> ✓ Erledigt (${done.length})
        </button>
        ${showDone && groupDone(done).map(([day, items]) => html`
          <h2 key=${day}>${fmtDay(day)}</h2>
          ${items.map((d) => html`
            <div class="task done" key=${d.id}>
              <button class="check" style="background:var(--primary);border-color:transparent" title="Wiederherstellen"
                      onClick=${() => restore(d)}>✓</button>
              <div class="body">
                <div class="ttl">${d.title}</div>
                <div class="meta">
                  <span class="chip">${CAT_ICON[d.category] || "📦"} ${d.category || "Sonstiges"}</span>
                  <span class="chip">${fmtTime(d.done_at)} Uhr</span>
                </div>
              </div>
              <div class="tools">
                <button title="Wiederherstellen" onClick=${() => restore(d)}>↩</button>
                <button title="Endgültig löschen" onClick=${() => askDelete(d)}>🗑</button>
              </div>
            </div>`)}
        `)}
      </div>`}

    <button class="fab" onClick=${() => setAdding(true)}>+ Artikel</button>
    ${overlays}
  `;
}

/* ---------- Einkaufsliste: Artikel hinzufügen (neu oder aus Katalog) ---------- */
function ShoppingAdder({ listId, onClose, onSaved }) {
  const [text, setText] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current && inputRef.current.focus(); }, []);

  useEffect(() => {
    const q = text.trim();
    if (q.length < 1) { setSuggestions([]); return; }
    let cancelled = false;
    sb.from("shopping_catalog").select("*").ilike("name", `%${q}%`)
      .order("use_count", { ascending: false }).limit(6)
      .then(({ data }) => { if (!cancelled) setSuggestions(data || []); });
    return () => { cancelled = true; };
  }, [text]);

  async function upsertCatalog(name, category) {
    const { data: existing } = await sb.from("shopping_catalog").select("id,use_count")
      .ilike("name", name).maybeSingle();
    if (existing) {
      await sb.from("shopping_catalog")
        .update({ use_count: existing.use_count + 1, last_used: new Date().toISOString(), category })
        .eq("id", existing.id);
    } else {
      await sb.from("shopping_catalog").insert({ name, category, use_count: 1, last_used: new Date().toISOString() });
    }
  }

  async function addItem(name, category) {
    const nm = (name || "").trim();
    if (!nm || busy) return;
    setBusy(true);
    const cat = category || guessCategory(nm);
    const row = { id: crypto.randomUUID(), list_id: listId, title: nm, category: cat, sort: Date.now(),
      done: false, created_at: new Date().toISOString(), parent_id: null, due_at: null, priority: null };
    await trySb(sb.from("todos").insert(row), { type: "insert", table: "todos", payload: row });
    if (navigator.onLine) upsertCatalog(nm, cat).catch(() => {});
    setBusy(false);
    onSaved(row);
  }

  return html`
    <div class="overlay" onClick=${onClose}>
      <div class="modal" onClick=${(e) => e.stopPropagation()}>
        <div class="editbar">
          <button class="ghost" style="width:auto" onClick=${onClose}>Abbrechen</button>
          <strong>Artikel hinzufügen</strong>
          <span style="width:1px"></span>
        </div>
        <label>Neu eintragen</label>
        <input ref=${inputRef} placeholder="z. B. Heidelbeeren" value=${text}
               onInput=${(e) => setText(e.target.value)}
               onKeyDown=${(e) => e.key === "Enter" && addItem(text)} />
        ${suggestions.length > 0 && html`
          <div class="suggest">
            ${suggestions.map((s) => html`
              <button class="sugrow" key=${s.id} onClick=${() => addItem(s.name, s.category)}>
                <span>${CAT_ICON[s.category] || "📦"}</span>
                <span style="flex:1">${s.name}</span>
              </button>`)}
          </div>`}
        <button class="primary block" style="margin-top:14px" disabled=${busy || !text.trim()} onClick=${() => addItem(text)}>
          ${busy ? "…" : `+ „${text.trim() || "…"}" hinzufügen`}
        </button>
        <button class="ghost block" style="margin-top:10px" onClick=${() => setPicker(true)}>📋 Aus Liste wählen</button>
      </div>
    </div>
    ${picker && html`<${CatalogPicker}
        onPick=${(item) => { setPicker(false); addItem(item.name, item.category); }}
        onClose=${() => setPicker(false)} />`}
  `;
}

/* ---------- Einkaufsliste: gespeicherte Artikel wählen ---------- */
function CatalogPicker({ onPick, onClose }) {
  const [items, setItems] = useState(null);
  const [mode, setMode] = useState("category"); // category | frequency
  const [openCat, setOpenCat] = useState(null);

  useEffect(() => {
    sb.from("shopping_catalog").select("*").order("use_count", { ascending: false })
      .then(({ data }) => setItems(data || []));
  }, []);

  return html`
    <div class="overlay" onClick=${onClose}>
      <div class="modal" onClick=${(e) => e.stopPropagation()}>
        <div class="editbar">
          <button class="ghost" style="width:auto" onClick=${onClose}>‹ Zurück</button>
          <strong>Aus Liste wählen</strong>
          <span style="width:1px"></span>
        </div>
        <div class="seg" style="margin-bottom:12px">
          <button class=${mode === "category" ? "on" : ""} onClick=${() => setMode("category")}>Nach Kategorie</button>
          <button class=${mode === "frequency" ? "on" : ""} onClick=${() => setMode("frequency")}>Nach Häufigkeit</button>
        </div>
        ${items === null
          ? html`<div class="spinner"></div>`
          : items.length === 0
            ? html`<div class="emptyhint">Noch keine gespeicherten Artikel.<br/>Trage welche neu ein – sie erscheinen danach hier.</div>`
            : mode === "frequency"
              ? html`<div class="picklist">
                  ${items.map((it) => html`
                    <button class="pickrow" key=${it.id} onClick=${() => onPick(it)}>
                      <span>${CAT_ICON[it.category] || "📦"}</span>
                      <span style="flex:1;text-align:left">${it.name}</span>
                      <span class="muted" style="font-size:.75rem">${it.use_count}×</span>
                    </button>`)}
                </div>`
              : html`<div class="picklist">
                  ${CATEGORIES.filter((cat) => items.some((it) => (it.category || "Sonstiges") === cat)).map((cat) => {
                    const catItems = items.filter((it) => (it.category || "Sonstiges") === cat)
                      .sort((a, b) => a.name.localeCompare(b.name, "de"));
                    return html`
                      <div key=${cat}>
                        <button class="catrow" onClick=${() => setOpenCat(openCat === cat ? null : cat)}>
                          <span class=${"caret" + (openCat === cat ? " open" : "")}>▸</span>
                          <span style="flex:1;text-align:left">${CAT_ICON[cat] || "📦"} ${cat}</span>
                          <span class="muted" style="font-size:.75rem">${catItems.length}</span>
                        </button>
                        ${openCat === cat && catItems.map((it) => html`
                          <button class="pickrow sub" key=${it.id} onClick=${() => onPick(it)}>
                            <span style="flex:1;text-align:left">${it.name}</span>
                          </button>`)}
                      </div>`;
                  })}
                </div>`}
      </div>
    </div>
  `;
}

/* ---------- Unteraufgaben-Liste (in Zeile & Detailseite) ---------- */
function SubList({ task, subs, onChange, editable }) {
  const [newSub, setNewSub] = useState("");
  async function addSub() {
    const t = newSub.trim(); if (!t) return;
    setNewSub("");
    await sb.from("todos").insert({ list_id: task.list_id, parent_id: task.id, title: t });
    onChange();
  }
  async function completeSub(id) {
    await sb.from("todos").update({ done: true, done_at: new Date().toISOString() }).eq("id", id);
    onChange();
  }
  async function delSub(id) { await sb.from("todos").delete().eq("id", id); onChange(); }

  return html`
    <div class="subwrap">
      ${subs.map((s) => html`
        <div class="sub" key=${s.id}>
          <button class="check" title="Erledigt" onClick=${() => completeSub(s.id)}></button>
          <div class="ttl">${s.title}</div>
          ${editable && html`<button class="del" onClick=${() => delSub(s.id)}>🗑</button>`}
        </div>`)}
      ${editable && html`
        <div class="addsub">
          <input placeholder="Unteraufgabe hinzufügen …" value=${newSub}
                 onInput=${(e) => setNewSub(e.target.value)}
                 onKeyDown=${(e) => e.key === "Enter" && addSub()} />
          <button class="ghost" style="width:auto;min-height:40px" onClick=${addSub}>+</button>
        </div>`}
    </div>`;
}

/* ---------- Eine Aufgabe (ohne Datum in der Liste) ---------- */
function TaskRow({ task, subs, open, toggleOpen, onChange, onOpen, onDelete, onMove, onComplete, listName, dragHandle, dragging, showSub }) {
  async function complete() {
    if (onComplete) { onComplete(task); return; }
    await sb.from("todos").update({ done: true, done_at: new Date().toISOString() })
      .or(`id.eq.${task.id},parent_id.eq.${task.id}`);
    onChange();
  }
  const hasToggle = subs.length > 0 || open;
  return html`
    <div class=${"task" + (dragging ? " dragging" : "")} data-sid=${task.id}>
      <button class=${"check" + (task.priority === 1 ? " p1" : "")} title="Erledigt" onClick=${complete}></button>
      <div class="body" style=${onOpen ? "cursor:pointer" : ""} onClick=${() => onOpen && onOpen(task)}>
        <div class="ttl">${task.title}</div>
        ${(task.due_at || listName || task.priority || subs.length > 0) && html`
          <div class="meta">
            ${task.due_at && html`<span class=${"chip due" + (task.due_at < new Date().toISOString() ? " over" : "")}>📅 ${fmtDueShort(task.due_at)}</span>`}
            ${listName && html`<span class="chip">🗂 ${listName}</span>`}
            ${task.priority && html`<span class="chip prio">⭐ P${task.priority}</span>`}
            ${subs.length > 0 && html`<span class="chip" style="cursor:pointer"
              onClick=${(e) => { e.stopPropagation(); toggleOpen(); }}>
              <span class=${"caret" + (open ? " open" : "")}>▸</span> ${subs.length} Unteraufg.</span>`}
          </div>`}
      </div>
      <div class="tools">
        ${hasToggle && html`<button title="Unteraufgaben" onClick=${toggleOpen}>${open ? "▾" : "▸"}</button>`}
        ${onMove && html`<button title="In andere Liste verschieben" onClick=${onMove}>↔</button>`}
        ${onDelete && html`<button title="Löschen" onClick=${onDelete}>🗑</button>`}
        ${dragHandle && html`<span class="drag" title="Ziehen zum Sortieren" onPointerDown=${dragHandle}>⋮⋮</span>`}
      </div>
    </div>
    ${open && showSub && html`<${SubList} task=${task} subs=${subs} onChange=${onChange} editable=${true} />`}
  `;
}

/* ---------- Detailseite einer Aufgabe ---------- */
function TaskDetail({ task, subs, onBack, onChange, onEdit, onDelete, onMove }) {
  const over = task.due_at && task.due_at < new Date().toISOString();
  return html`
    <div class="detailbar">
      <button class="ghost" style="width:auto" onClick=${onBack}>‹ Zurück</button>
      <button class="ghost" style="width:auto" onClick=${onEdit}>✎ Bearbeiten</button>
    </div>
    <h1 style="margin:12px 0 6px">${task.title}</h1>
    <div class="meta" style="margin-bottom:8px">
      ${task.due_at
        ? html`<span class=${"chip due" + (over ? " over" : "")}>📅 ${fmtDateTime(task.due_at)}</span>`
        : html`<span class="chip">Kein Zieldatum</span>`}
      ${task.priority
        ? html`<span class="chip prio">⭐ Priorität ${task.priority}</span>`
        : html`<span class="chip">Keine Priorität</span>`}
    </div>
    <h2>Unteraufgaben</h2>
    <${SubList} task=${task} subs=${subs} onChange=${onChange} editable=${true} />
    <button class="ghost block" style="margin-top:24px" onClick=${onMove}>↔ In andere Liste verschieben</button>
    <button class="ghost block" style="color:var(--danger);margin-top:10px" onClick=${onDelete}>🗑 Aufgabe löschen</button>
  `;
}

/* ---------- Aufgabe anlegen / bearbeiten (Modal) ---------- */
function TaskEditor({ listId, task, onClose, onSaved }) {
  const init = task?.due_at ? new Date(task.due_at) : null;
  const [title, setTitle] = useState(task?.title || "");
  const [date, setDate] = useState(init ? localYmd(init) : "");
  const [time, setTime] = useState(init ? localHm(init) : "");
  const [prio, setPrio] = useState(task?.priority || null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    const el = inputRef.current;
    if (el) { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch (_) {} }
  }, []);

  async function save() {
    const t = title.trim();
    if (!t) return;
    setBusy(true);
    let due_at = null;
    if (date) { const d = new Date(`${date}T${time || "09:00"}`); due_at = isNaN(d.getTime()) ? null : d.toISOString(); }
    const payload = { title: t, due_at, priority: prio || null };
    if (task) {
      await trySb(sb.from("todos").update(payload).eq("id", task.id),
        { type: "update", table: "todos", payload, match: { id: task.id } });
      setBusy(false);
      onSaved({ id: task.id, ...payload }, true);
    } else {
      const row = { id: crypto.randomUUID(), list_id: listId, sort: Date.now(), done: false,
        created_at: new Date().toISOString(), parent_id: null, category: null, ...payload };
      await trySb(sb.from("todos").insert(row), { type: "insert", table: "todos", payload: row });
      setBusy(false);
      onSaved(row, false);
    }
  }

  return html`
    <div class="overlay" onClick=${onClose}>
      <div class="modal" onClick=${(e) => e.stopPropagation()}>
        <div class="editbar">
          <button class="ghost" style="width:auto" onClick=${onClose}>Abbrechen</button>
          <strong>${task ? "Aufgabe bearbeiten" : "Neue Aufgabe"}</strong>
          <button class="primary" style="width:auto" disabled=${busy || !title.trim()} onClick=${save}>${busy ? "…" : "Speichern"}</button>
        </div>
        <label>Aufgabe</label>
        <textarea ref=${inputRef} placeholder="Was ist zu tun?" value=${title}
                  onInput=${(e) => setTitle(e.target.value)}
                  onKeyDown=${(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save(); }}></textarea>

        <label>Zieldatum & Uhrzeit (optional)</label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input type="date" style="flex:1;min-width:140px" value=${date} onInput=${(e) => setDate(e.target.value)} />
          <input type="time" style="flex:1;min-width:110px" value=${time} disabled=${!date} onInput=${(e) => setTime(e.target.value)} />
          ${(date || time) && html`<button class="ghost" style="width:auto" onClick=${() => { setDate(""); setTime(""); }}>✕</button>`}
        </div>

        <label>Priorität (optional)</label>
        <div class="prios">
          ${[1, 2, 3, 4, 5, 6].map((p) => html`
            <button class=${prio === p ? "sel" : ""} onClick=${() => setPrio(prio === p ? null : p)}>${p}</button>`)}
          <button class=${"none" + (prio ? "" : " sel")} onClick=${() => setPrio(null)}>keine Priorität</button>
        </div>
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
      <h1 class="center">✅ To-Do</h1>
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

/* ---------- Öffentliche Ansicht einer geteilten Liste (kein Login) ---------- */
function SharedApp({ token }) {
  const [info, setInfo] = useState(undefined); // undefined=lädt, null=ungültig, {id,name,kind}
  useEffect(() => {
    sb.rpc("shared_list_info", { p_token: token }).then(({ data, error }) => {
      setInfo(error || !data || data.length === 0 ? null : data[0]);
    });
  }, [token]);

  if (info === undefined) return html`<div class="spinner"></div>`;
  if (info === null) return html`
    <main>
      <h1 class="center">🔗 Geteilte Liste</h1>
      <p class="muted center">Dieser Link ist ungültig oder die Freigabe wurde beendet.</p>
    </main>`;

  return html`
    <header class="appbar">
      <div class="title">${info.kind === "shopping" ? "🛒" : "📝"} ${info.name}</div>
      <span class="muted" style="font-size:.72rem">Geteilte Liste</span>
    </header>
    <main>
      <${SharedListView} token=${token} kind=${info.kind} />
    </main>
  `;
}

function doneSection(done, restore, askDelete, showDone, setShowDone, isShopping) {
  if (done.length === 0) return "";
  return html`
    <div style="margin-top:26px">
      <button class="ghost block" style="text-align:left;display:flex;align-items:center;gap:8px"
              onClick=${() => setShowDone((s) => !s)}>
        <span class=${"caret" + (showDone ? " open" : "")}>▸</span> ✓ Erledigt (${done.length})
      </button>
      ${showDone && groupDone(done).map(([day, items]) => html`
        <h2 key=${day}>${fmtDay(day)}</h2>
        ${items.map((d) => html`
          <div class="task done" key=${d.id}>
            <button class="check" style="background:var(--primary);border-color:transparent" title="Wiederherstellen"
                    onClick=${() => restore(d)}>✓</button>
            <div class="body">
              <div class="ttl">${d.title}</div>
              <div class="meta">
                ${isShopping && html`<span class="chip">${CAT_ICON[d.category] || "📦"} ${d.category || "Sonstiges"}</span>`}
                <span class="chip">${fmtTime(d.done_at)} Uhr</span>
              </div>
            </div>
            <div class="tools">
              <button title="Wiederherstellen" onClick=${() => restore(d)}>↩</button>
              <button title="Endgültig löschen" onClick=${() => askDelete(d)}>🗑</button>
            </div>
          </div>`)}
      `)}
    </div>`;
}

function SharedListView({ token, kind }) {
  const [rows, setRows] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [err, setErr] = useState("");

  async function load() {
    const { data, error } = await sb.rpc("shared_todos", { p_token: token });
    if (error) { setErr("Freigabe nicht mehr gültig."); setRows([]); return; }
    setRows(data || []);
  }
  useEffect(() => { load(); }, [token]);

  async function complete(t) { await sb.rpc("shared_todo_set_done", { p_token: token, p_todo_id: t.id, p_done: true }); load(); }
  async function restore(t) { await sb.rpc("shared_todo_set_done", { p_token: token, p_todo_id: t.id, p_done: false }); load(); }
  function askDelete(t) {
    setConfirm({ text: `„${t.title}" löschen?`, yes: "Löschen", danger: true,
      onYes: async () => { await sb.rpc("shared_todo_delete", { p_token: token, p_todo_id: t.id }); setConfirm(null); load(); } });
  }

  if (rows === null) return html`<div class="spinner"></div>`;
  if (err) return html`<p class="error">${err}</p>`;

  const active = rows.filter((r) => !r.done && !r.parent_id);
  const done = rows.filter((r) => r.done && !r.parent_id).sort((a, b) => (b.done_at || "").localeCompare(a.done_at || ""));

  const overlays = html`
    ${adding && html`<${SharedAdder} token=${token} kind=${kind}
        onClose=${() => setAdding(false)} onSaved=${() => { setAdding(false); load(); }} />`}
    ${confirm && html`<${ConfirmModal} text=${confirm.text} sub=${confirm.sub} yes=${confirm.yes}
        danger=${confirm.danger} onYes=${confirm.onYes} onClose=${() => setConfirm(null)} />`}`;

  if (kind === "shopping") {
    const groups = {};
    active.forEach((t) => { const c = t.category || "Sonstiges"; (groups[c] ||= []).push(t); });
    const catKeys = Object.keys(groups).sort((a, b) => catOrder(a) - catOrder(b));
    return html`
      ${active.length === 0
        ? html`<div class="emptyhint">Einkaufsliste ist leer.<br/>Tippe unten auf <strong>+ Artikel</strong>.</div>`
        : catKeys.map((cat) => html`
            <h2 key=${cat}>${CAT_ICON[cat] || "📦"} ${cat}</h2>
            ${groups[cat].sort((a, b) => a.title.localeCompare(b.title, "de")).map((t) => html`
              <div class="task" key=${t.id}>
                <button class="check" title="Erledigt" onClick=${() => complete(t)}></button>
                <div class="body"><div class="ttl">${t.title}</div></div>
                <div class="tools"><button title="Löschen" onClick=${() => askDelete(t)}>🗑</button></div>
              </div>`)}
          `)}
      ${doneSection(done, restore, askDelete, showDone, setShowDone, true)}
      <button class="fab" onClick=${() => setAdding(true)}>+ Artikel</button>
      ${overlays}
    `;
  }

  const ordered = active.slice().sort((a, b) =>
    ((a.sort || 0) - (b.sort || 0)) || ((a.due_at || "9999").localeCompare(b.due_at || "9999")));

  return html`
    ${ordered.length === 0
      ? html`<div class="emptyhint">Noch keine offenen Aufgaben.<br/>Tippe unten auf <strong>+ Aufgabe</strong>.</div>`
      : ordered.map((t) => html`
          <div class="task" key=${t.id}>
            <button class=${"check" + (t.priority === 1 ? " p1" : "")} title="Erledigt" onClick=${() => complete(t)}></button>
            <div class="body">
              <div class="ttl">${t.title}</div>
              ${(t.due_at || t.priority) && html`
                <div class="meta">
                  ${t.due_at && html`<span class="chip due">📅 ${fmtDueShort(t.due_at)}</span>`}
                  ${t.priority && html`<span class="chip prio">⭐ P${t.priority}</span>`}
                </div>`}
            </div>
            <div class="tools"><button title="Löschen" onClick=${() => askDelete(t)}>🗑</button></div>
          </div>`)}
    ${doneSection(done, restore, askDelete, showDone, setShowDone, false)}
    <button class="fab" onClick=${() => setAdding(true)}>+ Aufgabe</button>
    ${overlays}
  `;
}

function SharedAdder({ token, kind, onClose, onSaved }) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [prio, setPrio] = useState(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  useEffect(() => { ref.current && ref.current.focus(); }, []);

  async function save() {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    if (kind === "shopping") {
      await sb.rpc("shared_todo_add", { p_token: token, p_title: t, p_category: guessCategory(t) });
    } else {
      let due_at = null;
      if (date) { const d = new Date(`${date}T${time || "09:00"}`); due_at = isNaN(d.getTime()) ? null : d.toISOString(); }
      await sb.rpc("shared_todo_add", { p_token: token, p_title: t, p_due_at: due_at, p_priority: prio });
    }
    setBusy(false);
    onSaved();
  }

  return html`
    <div class="overlay" onClick=${onClose}>
      <div class="modal" onClick=${(e) => e.stopPropagation()}>
        <div class="editbar">
          <button class="ghost" style="width:auto" onClick=${onClose}>Abbrechen</button>
          <strong>${kind === "shopping" ? "Artikel hinzufügen" : "Neue Aufgabe"}</strong>
          <button class="primary" style="width:auto" disabled=${busy || !title.trim()} onClick=${save}>${busy ? "…" : "Speichern"}</button>
        </div>
        <label>${kind === "shopping" ? "Artikel" : "Aufgabe"}</label>
        <input ref=${ref} placeholder=${kind === "shopping" ? "z. B. Heidelbeeren" : "Was ist zu tun?"} value=${title}
               onInput=${(e) => setTitle(e.target.value)}
               onKeyDown=${(e) => e.key === "Enter" && save()} />
        ${kind !== "shopping" && html`
          <label>Zieldatum & Uhrzeit (optional)</label>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input type="date" style="flex:1;min-width:140px" value=${date} onInput=${(e) => setDate(e.target.value)} />
            <input type="time" style="flex:1;min-width:110px" value=${time} disabled=${!date} onInput=${(e) => setTime(e.target.value)} />
          </div>
          <label>Priorität (optional)</label>
          <div class="prios">
            ${[1, 2, 3, 4, 5, 6].map((p) => html`
              <button class=${prio === p ? "sel" : ""} onClick=${() => setPrio(prio === p ? null : p)}>${p}</button>`)}
            <button class=${"none" + (prio ? "" : " sel")} onClick=${() => setPrio(null)}>keine Priorität</button>
          </div>`}
      </div>
    </div>
  `;
}

/* ---------- Router: geteilter Link vs. normale App ---------- */
const shareMatch = location.pathname.match(/^\/share\/([A-Za-z0-9]+)/);
if (shareMatch) render(html`<${SharedApp} token=${shareMatch[1]} />`, document.getElementById("app"));
else render(html`<${App} />`, document.getElementById("app"));
