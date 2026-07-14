import { h, render } from "https://esm.sh/preact@10";
import { useState, useEffect } from "https://esm.sh/preact@10/hooks";
import htm from "https://esm.sh/htm@3";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const html = htm.bind(h);

const SUPABASE_URL = "https://qcsezegptoblkpvwhtzx.supabase.co";
const SUPABASE_KEY = "sb_publishable_PkA4IRR8xTrug-JgY-vN5g_EsH34zNB";
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ---------- Stammdaten für die Eingabe ---------- */
const TRANSPORT = [
  { v: "flug", l: "✈️ Flugzeug" },
  { v: "auto", l: "🚗 Auto" },
  { v: "bahn", l: "🚆 Bahn" },
];
const ACCOMMODATION = ["Hotel", "Airbnb / Ferienwohnung", "Zelt", "Hütte", "Camper", "Bei Freunden"];
const ACTIVITIES = [
  { tag: "strand", l: "Strand / Baden" },
  { tag: "kite", l: "Kitesurfen" },
  { tag: "wassersport", l: "Wassersport" },
  { tag: "wandern", l: "Wandern" },
  { tag: "winter", l: "Winter / Ski" },
  { tag: "camping", l: "Camping" },
  { tag: "sport", l: "Sport / Fitness" },
  { tag: "business", l: "Business" },
];

/* ---------- Helfer ---------- */
function daysBetween(a, b) {
  if (!a || !b) return 1;
  const d = Math.round((new Date(b) - new Date(a)) / 86400000) + 1;
  return Math.min(Math.max(d, 1), 60);
}
function accommodationTags(acc) {
  return /zelt|camper|hütte|huette/i.test(acc || "") ? ["camping"] : [];
}
function computeQty(item, days) {
  if (item.qty_per_days) return Math.max(item.default_qty || 1, Math.ceil(item.qty_per_days * days));
  return item.default_qty || 1;
}

/* Regel-Engine: aus Reise + Etappen die passenden Katalog-Items wählen */
function generateList(items, trip, legs) {
  const tags = new Set(["basis"]);
  if (trip.purpose === "business") tags.add("business");
  let flugHandOnly = false;
  for (const leg of legs) {
    if (leg.transport) tags.add(leg.transport);
    for (const t of accommodationTags(leg.accommodation)) tags.add(t);
    for (const a of leg.activities || []) tags.add(a);
    if (leg.transport === "flug" && leg.hand_luggage_only) flugHandOnly = true;
  }
  const days = daysBetween(trip.start_date, trip.end_date);
  const chosen = items
    .filter((it) => (it.tags || []).some((t) => tags.has(t)))
    .map((it) => ({
      item_id: it.id,
      name: it.name,
      category_id: it.category_id,
      qty: computeQty(it, days),
      weight_grams: it.weight_grams,
      packed: false,
      source: "suggested",
      removed: false,
    }));
  if (flugHandOnly) {
    chosen.push({
      item_id: null, name: "Flüssigkeiten je ≤100 ml + 1-L-Beutel (Handgepäck!)",
      category_id: catByName["Hygiene & Toilettenartikel"], qty: 1, weight_grams: null,
      packed: false, source: "suggested", removed: false,
    });
  }
  return chosen;
}

/* Kategorien-Cache (Name -> id, id -> obj) */
let categories = [];
let catByName = {};
let catById = {};

/* ---------- Datenzugriff ---------- */
async function loadMeta() {
  const [{ data: cats }, { data: items }] = await Promise.all([
    sb.from("categories").select("*").order("sort_order"),
    sb.from("items").select("*"),
  ]);
  categories = cats || [];
  catByName = Object.fromEntries(categories.map((c) => [c.name, c.id]));
  catById = Object.fromEntries(categories.map((c) => [c.id, c]));
  return { items: items || [] };
}

/* ---------- App ---------- */
function App() {
  const [session, setSession] = useState(undefined); // undefined=lädt, null=logged out
  const [profile, setProfile] = useState(null);
  const [view, setView] = useState({ name: "home" });

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setProfile(null); return; }
    sb.from("profiles").select("*").eq("id", session.user.id).single()
      .then(({ data }) => setProfile(data));
  }, [session]);

  if (session === undefined) return html`<div class="spinner"></div>`;
  if (!session) return html`<${Login} />`;

  const go = (v) => setView(v);
  return html`
    <header class="appbar">
      <div class="title">🧳 Packassistent</div>
      ${profile?.role === "admin" &&
        html`<button class="ghost" onClick=${() => go({ name: "admin" })}>Admin</button>`}
      <button class="ghost" onClick=${() => sb.auth.signOut()}>Logout</button>
    </header>
    <main>
      ${view.name === "home" && html`<${Home} go=${go} />`}
      ${view.name === "wizard" && html`<${Wizard} go=${go} />`}
      ${view.name === "trip" && html`<${TripView} tripId=${view.tripId} go=${go} />`}
      ${view.name === "admin" && html`<${Admin} go=${go} />`}
    </main>
  `;
}

/* ---------- Login / Registrierung ---------- */
function Login() {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setMsg("");
    const fn = mode === "login" ? sb.auth.signInWithPassword : sb.auth.signUp;
    const { error } = await fn({ email: email.trim(), password: pw });
    setBusy(false);
    if (error) return setMsg(error.message);
    if (mode === "signup") setMsg("Registriert! Du kannst dich jetzt anmelden.");
  }
  return html`
    <main>
      <h1>Willkommen</h1>
      <p class="muted">Dein persönlicher Pack-Assistent.</p>
      <div class="card">
        <form onSubmit=${submit}>
          <label>E-Mail</label>
          <input type="email" autocomplete="username" required
                 value=${email} onInput=${(e) => setEmail(e.target.value)} />
          <label>Passwort</label>
          <input type="password" autocomplete=${mode === "login" ? "current-password" : "new-password"}
                 required minlength="6" value=${pw} onInput=${(e) => setPw(e.target.value)} />
          ${msg && html`<p class="error" style="margin-top:12px">${msg}</p>`}
          <button class="primary block" style="margin-top:16px" disabled=${busy}>
            ${busy ? "…" : mode === "login" ? "Anmelden" : "Registrieren"}
          </button>
        </form>
      </div>
      <p class="center">
        ${mode === "login"
          ? html`Noch kein Konto? <a href="#" onClick=${(e) => { e.preventDefault(); setMode("signup"); setMsg(""); }}>Registrieren</a>`
          : html`Schon ein Konto? <a href="#" onClick=${(e) => { e.preventDefault(); setMode("login"); setMsg(""); }}>Anmelden</a>`}
      </p>
    </main>
  `;
}

/* ---------- Home / Historie ---------- */
function Home({ go }) {
  const [trips, setTrips] = useState(null);
  useEffect(() => {
    sb.from("trips").select("*").order("start_date", { ascending: false, nullsFirst: false })
      .then(({ data }) => setTrips(data || []));
  }, []);
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = (trips || []).filter((t) => !t.end_date || t.end_date >= today);
  const past = (trips || []).filter((t) => t.end_date && t.end_date < today);

  return html`
    <h1>Deine Reisen</h1>
    <p class="muted">Neue Packliste erstellen oder frühere ansehen.</p>
    ${trips === null && html`<div class="spinner"></div>`}
    ${trips && trips.length === 0 && html`<div class="card center muted">Noch keine Reise. Leg unten los! 👇</div>`}
    ${upcoming.length > 0 && html`<h2>Anstehend & offen</h2>`}
    ${upcoming.map((t) => html`<${TripCard} t=${t} go=${go} />`)}
    ${past.length > 0 && html`<h2>Archiv</h2>`}
    ${past.map((t) => html`<${TripCard} t=${t} go=${go} />`)}
    <div class="actionbar">
      <button class="primary block" onClick=${() => go({ name: "wizard" })}>+ Neue Reise</button>
    </div>
  `;
}
function TripCard({ t, go }) {
  const fmt = (d) => (d ? new Date(d).toLocaleDateString("de-DE", { day: "2-digit", month: "short" }) : "?");
  return html`
    <div class="card" style="cursor:pointer" onClick=${() => go({ name: "trip", tripId: t.id })}>
      <div style="display:flex;align-items:center;gap:10px">
        <div style="flex:1">
          <div style="font-weight:700">${t.title}</div>
          <div class="muted" style="font-size:.85rem">
            ${fmt(t.start_date)} – ${fmt(t.end_date)} · ${t.purpose === "business" ? "Business" : "Privat"}
          </div>
        </div>
        <div class="badge">${t.persons}👤</div>
      </div>
    </div>
  `;
}

/* ---------- Assistent (Wizard) ---------- */
function emptyLeg() {
  return { destination: "", accommodation: "Hotel", transport: "flug", hand_luggage_only: false, activities: [] };
}
function Wizard({ go }) {
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [purpose, setPurpose] = useState("privat");
  const [persons, setPersons] = useState(1);
  const [legs, setLegs] = useState([emptyLeg()]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const setLeg = (i, patch) => setLegs((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const toggleAct = (i, tag) =>
    setLeg(i, {
      activities: legs[i].activities.includes(tag)
        ? legs[i].activities.filter((t) => t !== tag)
        : [...legs[i].activities, tag],
    });
  const days = daysBetween(start, end);

  async function create() {
    setErr("");
    if (!title.trim()) return setErr("Bitte einen Titel angeben.");
    if (!start || !end) return setErr("Bitte Zeitraum wählen.");
    if (end < start) return setErr("Enddatum liegt vor Startdatum.");
    setBusy(true);
    const { data: user } = await sb.auth.getUser();
    const { data: trip, error } = await sb.from("trips")
      .insert({ user_id: user.user.id, title: title.trim(), start_date: start, end_date: end, purpose, persons })
      .select().single();
    if (error) { setBusy(false); return setErr(error.message); }
    await sb.from("trip_legs").insert(
      legs.map((l, i) => ({
        trip_id: trip.id, position: i + 1, destination: l.destination,
        accommodation: l.accommodation, transport: l.transport,
        hand_luggage_only: l.hand_luggage_only, activities: l.activities,
      }))
    );
    const { items } = await loadMeta();
    const list = generateList(items, trip, legs).map((x) => ({ ...x, trip_id: trip.id }));
    if (list.length) await sb.from("trip_items").insert(list);
    setBusy(false);
    go({ name: "trip", tripId: trip.id });
  }

  return html`
    <h1>Neue Reise</h1>
    <p class="muted">${days} ${days === 1 ? "Tag" : "Tage"} · daraus wird deine Liste erstellt.</p>

    <div class="card">
      <label>Titel</label>
      <input placeholder="z. B. Kitesurfen Ägypten" value=${title} onInput=${(e) => setTitle(e.target.value)} />
      <div class="row">
        <div><label>Von</label><input type="date" value=${start} onInput=${(e) => setStart(e.target.value)} /></div>
        <div><label>Bis</label><input type="date" value=${end} onInput=${(e) => setEnd(e.target.value)} /></div>
      </div>
      <label>Anlass</label>
      <div class="chips">
        ${["privat", "business"].map((p) => html`
          <button class=${"chip " + (purpose === p ? "on" : "")} onClick=${() => setPurpose(p)}>
            ${p === "privat" ? "Privat" : "Business"}
          </button>`)}
      </div>
      <label>Personen</label>
      <div class="qty">
        <button onClick=${() => setPersons((n) => Math.max(1, n - 1))}>−</button>
        <span>${persons}</span>
        <button onClick=${() => setPersons((n) => n + 1)}>+</button>
      </div>
    </div>

    ${legs.map((leg, i) => html`
      <div class="card">
        <div style="display:flex;align-items:center">
          <strong style="flex:1">${legs.length > 1 ? `Etappe ${i + 1}` : "Ziel"}</strong>
          ${legs.length > 1 && html`<button class="danger" style="width:auto" onClick=${() => setLegs(legs.filter((_, k) => k !== i))}>Entfernen</button>`}
        </div>
        <label>Reiseziel</label>
        <input placeholder="z. B. El Gouna" value=${leg.destination} onInput=${(e) => setLeg(i, { destination: e.target.value })} />
        <label>Unterkunft</label>
        <select value=${leg.accommodation} onChange=${(e) => setLeg(i, { accommodation: e.target.value })}>
          ${ACCOMMODATION.map((a) => html`<option>${a}</option>`)}
        </select>
        <label>Anreise</label>
        <div class="chips">
          ${TRANSPORT.map((t) => html`
            <button class=${"chip " + (leg.transport === t.v ? "on" : "")} onClick=${() => setLeg(i, { transport: t.v })}>${t.l}</button>`)}
        </div>
        ${leg.transport === "flug" && html`
          <label style="display:flex;align-items:center;gap:10px;margin-top:14px">
            <input type="checkbox" style="width:24px;min-height:24px" checked=${leg.hand_luggage_only}
                   onChange=${(e) => setLeg(i, { hand_luggage_only: e.target.checked })} />
            <span style="color:var(--text);font-weight:500">Nur Handgepäck (Flüssigkeiten ≤100 ml)</span>
          </label>`}
        <label>Aktivitäten</label>
        <div class="chips">
          ${ACTIVITIES.map((a) => html`
            <button class=${"chip " + (leg.activities.includes(a.tag) ? "on" : "")} onClick=${() => toggleAct(i, a.tag)}>${a.l}</button>`)}
        </div>
      </div>`)}

    <button class="ghost block" onClick=${() => setLegs([...legs, emptyLeg()])}>+ Weitere Etappe (Rundreise)</button>
    ${err && html`<p class="error">${err}</p>`}

    <div class="actionbar">
      <button class="ghost" style="flex:0 0 auto" onClick=${() => go({ name: "home" })}>Zurück</button>
      <button class="primary block" disabled=${busy} onClick=${create}>${busy ? "Erstelle…" : "Packliste erstellen"}</button>
    </div>
  `;
}

/* ---------- Reise-/Listenansicht ---------- */
function TripView({ tripId, go }) {
  const [trip, setTrip] = useState(null);
  const [items, setItems] = useState(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCat, setNewCat] = useState("");

  async function reload() {
    if (!categories.length) await loadMeta();
    setNewCat(categories[0]?.id || "");
    const [{ data: t }, { data: it }] = await Promise.all([
      sb.from("trips").select("*").eq("id", tripId).single(),
      sb.from("trip_items").select("*").eq("trip_id", tripId).eq("removed", false).order("created_at"),
    ]);
    setTrip(t); setItems(it || []);
  }
  useEffect(() => { reload(); }, [tripId]);

  async function patch(id, p) {
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));
    await sb.from("trip_items").update(p).eq("id", id);
  }
  async function remove(id) {
    setItems((xs) => xs.filter((x) => x.id !== id));
    await sb.from("trip_items").update({ removed: true }).eq("id", id);
  }
  async function addItem() {
    if (!newName.trim()) return;
    const row = { trip_id: tripId, item_id: null, name: newName.trim(), category_id: newCat, qty: 1, source: "manual", packed: false, removed: false };
    const { data } = await sb.from("trip_items").insert(row).select().single();
    setItems((xs) => [...xs, data]);
    setNewName(""); setAdding(false);
  }

  if (!trip || !items) return html`<div class="spinner"></div>`;

  const groups = categories
    .map((c) => ({ cat: c, list: items.filter((x) => x.category_id === c.id) }))
    .filter((g) => g.list.length);
  const uncategorized = items.filter((x) => !x.category_id);
  if (uncategorized.length) groups.push({ cat: { name: "Sonstiges", icon: "📦" }, list: uncategorized });

  const total = items.length;
  const done = items.filter((x) => x.packed).length;
  const weight = items.reduce((s, x) => s + (x.packed ? 0 : (x.weight_grams || 0) * x.qty), 0);

  return html`
    <div style="display:flex;align-items:center;gap:10px">
      <button class="ghost" style="width:auto" onClick=${() => go({ name: "home" })}>‹</button>
      <h1 style="flex:1;font-size:1.25rem">${trip.title}</h1>
    </div>
    <p class="muted">
      ${done}/${total} gepackt${weight > 0 ? ` · offen ${(weight / 1000).toFixed(1)} kg` : ""}
    </p>

    ${groups.map((g) => html`
      <div class="cathead">
        <span>${g.cat.icon || "•"}</span><span>${g.cat.name}</span>
        <span class="count">${g.list.filter((x) => x.packed).length}/${g.list.length}</span>
      </div>
      <div class="card" style="padding:6px 14px">
        ${g.list.map((x) => html`
          <div class="pitem">
            <button class=${"check " + (x.packed ? "on" : "")} onClick=${() => patch(x.id, { packed: !x.packed })}>
              ${x.packed ? "✓" : ""}
            </button>
            <span class=${"name " + (x.packed ? "done" : "")}>${x.name}</span>
            <div class="qty">
              <button onClick=${() => patch(x.id, { qty: Math.max(1, x.qty - 1) })}>−</button>
              <span>${x.qty}</span>
              <button onClick=${() => patch(x.id, { qty: x.qty + 1 })}>+</button>
            </div>
            <button class="danger" style="width:auto" onClick=${() => remove(x.id)}>✕</button>
          </div>`)}
      </div>`)}

    ${adding
      ? html`
        <div class="card">
          <label>Neuer Eintrag</label>
          <input autofocus placeholder="Was fehlt?" value=${newName} onInput=${(e) => setNewName(e.target.value)} />
          <label>Kategorie</label>
          <select value=${newCat} onChange=${(e) => setNewCat(e.target.value)}>
            ${categories.map((c) => html`<option value=${c.id}>${c.icon} ${c.name}</option>`)}
          </select>
          <div class="row" style="margin-top:12px">
            <button class="ghost" onClick=${() => setAdding(false)}>Abbrechen</button>
            <button class="primary" onClick=${addItem}>Hinzufügen</button>
          </div>
        </div>`
      : html`<button class="ghost block" onClick=${() => setAdding(true)}>+ Eigenes Item</button>`}

    <div style="height:20px"></div>
  `;
}

/* ---------- Admin: Nutzerverwaltung ---------- */
function Admin({ go }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    sb.from("profiles").select("*").order("created_at").then(({ data }) => setRows(data || []));
  }, []);
  async function setRole(id, role) {
    setRows((xs) => xs.map((x) => (x.id === id ? { ...x, role } : x)));
    await sb.from("profiles").update({ role }).eq("id", id);
  }
  return html`
    <div style="display:flex;align-items:center;gap:10px">
      <button class="ghost" style="width:auto" onClick=${() => go({ name: "home" })}>‹</button>
      <h1 style="flex:1;font-size:1.25rem">Nutzerverwaltung</h1>
    </div>
    ${rows === null && html`<div class="spinner"></div>`}
    ${(rows || []).map((u) => html`
      <div class="card" style="display:flex;align-items:center;gap:10px">
        <div style="flex:1">
          <div style="font-weight:600">${u.display_name || u.email}</div>
          <div class="muted" style="font-size:.82rem">${u.email}</div>
        </div>
        <select style="width:auto" value=${u.role} onChange=${(e) => setRole(u.id, e.target.value)}>
          <option value="user">user</option>
          <option value="admin">admin</option>
        </select>
      </div>`)}
    <p class="muted">Admins können Rollen vergeben und (per Design) alle Listen einsehen.</p>
  `;
}

render(html`<${App} />`, document.getElementById("app"));
