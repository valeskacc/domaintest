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
  { v: "motorrad", l: "🏍️ Motorrad" },
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
  // Pro-Tag-Items richten sich nach der Reisedauer (z. B. 2 Tage -> 2 Paar Socken),
  // nicht nach einem hohen Mindestwert. Sonst feste Standardmenge.
  if (item.qty_per_days) {
    let n = Math.ceil(item.qty_per_days * days);
    // Am Anreisetag trägt man Socken/Unterwäsche bereits -> einen Tag abziehen.
    if (item.travel_day_worn) n -= Math.ceil(item.qty_per_days);
    return Math.max(1, n);
  }
  return item.default_qty || 1;
}

function toRow(it, days) {
  return {
    item_id: it.id, name: it.name, category_id: it.category_id,
    qty: computeQty(it, days), weight_grams: it.weight_grams,
    packed: false, source: "suggested", removed: false,
  };
}

/* Reisekontext (aussagekräftige Tags, ohne "basis") für kontextbezogenes Lernen */
function contextTags(trip, legs) {
  const s = new Set();
  if (trip && trip.purpose === "business") s.add("business");
  for (const l of legs || []) {
    if (l.transport) s.add(l.transport);
    for (const t of accommodationTags(l.accommodation)) s.add(t);
    for (const a of l.activities || []) s.add(a);
  }
  return [...s];
}

async function recordSignal(kind, name, tags, category_id) {
  try {
    const { data: u } = await sb.auth.getUser();
    if (!u?.user) return;
    await sb.from("pack_signals").insert({
      user_id: u.user.id, item_name: name, kind, tags: tags || [], category_id: category_id || null,
    });
  } catch (_e) { /* Lernen darf den Flow nie blockieren */ }
}

/* Aus den gesammelten Signalen die Vorschlagsliste anpassen (kontextbezogen) */
function applyLearning(chosen, items, ctxTags, signals, days) {
  if (!signals || !signals.length) return chosen;
  const ctx = new Set(ctxTags);
  const W = { added: 2, missed: 3, used: 1, removed: -2, unused: -2 };
  const score = new Map(); // nameKey -> { score, category_id, name }
  for (const s of signals) {
    const st = s.tags || [];
    const relevant = st.length === 0 ? true : st.some((t) => ctx.has(t)); // leere Tags = kontextunabhängig
    if (!relevant) continue;
    const key = s.item_name.toLowerCase();
    const cur = score.get(key) || { score: 0, category_id: s.category_id, name: s.item_name };
    cur.score += W[s.kind] || 0;
    if (s.category_id && !cur.category_id) cur.category_id = s.category_id;
    score.set(key, cur);
  }
  const present = new Set(chosen.map((x) => x.name.toLowerCase()));
  // Wegnehmen: was konsequent gestrichen/ungenutzt wurde
  const out = chosen.filter((x) => {
    const sc = score.get(x.name.toLowerCase());
    return !(sc && sc.score <= -3);
  });
  // Ergänzen: was konsequent selbst hinzugefügt/vermisst wurde
  for (const [key, v] of score) {
    if (v.score >= 3 && !present.has(key)) {
      const it = items.find((i) => i.name.toLowerCase() === key);
      out.push(it ? toRow(it, days) : {
        item_id: null, name: v.name, category_id: v.category_id || null, qty: 1,
        weight_grams: null, packed: false, source: "suggested", removed: false,
      });
      present.add(key);
    }
  }
  return out;
}

/* Regel-Engine: aus Reise + Etappen die passenden Katalog-Items wählen */
function generateList(items, trip, legs, signals) {
  const tags = new Set(["basis"]);
  if (trip.purpose === "business") tags.add("business");
  let flugHandOnly = false;
  let enoughLuggage = false; // Auto, Bahn oder Flug MIT Aufgabegepäck
  let motorrad = false;
  for (const leg of legs) {
    if (leg.transport) tags.add(leg.transport);
    for (const t of accommodationTags(leg.accommodation)) tags.add(t);
    for (const a of leg.activities || []) tags.add(a);
    if (leg.transport === "flug" && leg.hand_luggage_only) flugHandOnly = true;
    if (leg.transport === "motorrad") motorrad = true;
    if (leg.transport === "auto" || leg.transport === "bahn" ||
        (leg.transport === "flug" && !leg.hand_luggage_only)) enoughLuggage = true;
  }
  // Motorrad ohne sonstiges großes Gepäck -> Sperriges weglassen
  const bulkyBlocked = motorrad && !enoughLuggage;
  const days = daysBetween(trip.start_date, trip.end_date);
  const chosen = items
    .filter((it) => (it.tags || []).some((t) => tags.has(t)))
    .filter((it) => !(bulkyBlocked && it.bulky))
    .map((it) => toRow(it, days));

  // Zusatzregeln, die Items unabhängig von Tags erzwingen
  const present = new Set(chosen.map((x) => x.name.toLowerCase()));
  const ensure = (name) => {
    if (present.has(name.toLowerCase())) return;
    const it = items.find((i) => i.name.toLowerCase() === name.toLowerCase());
    if (it) { chosen.push(toRow(it, days)); present.add(name.toLowerCase()); }
  };

  // Privatreise in den Sommermonaten (Mai–Sep) -> Sonnencreme
  const month = trip.start_date ? new Date(trip.start_date).getMonth() + 1 : 0;
  if (trip.purpose !== "business" && month >= 5 && month <= 9) ensure("Sonnencreme");

  // Genug Gepäck -> Haarschaum & Trockenshampoo (bei Motorrad/Handgepäck bewusst nicht)
  if (enoughLuggage) { ensure("Haarschaum"); ensure("Trockenshampoo"); }

  if (flugHandOnly) {
    chosen.push({
      item_id: null, name: "Flüssigkeiten je ≤100 ml + 1-L-Beutel (Handgepäck!)",
      category_id: catByName["Hygiene & Toilettenartikel"], qty: 1, weight_grams: null,
      packed: false, source: "suggested", removed: false,
    });
  }
  // Gelerntes anwenden (kontextbezogen)
  const ctxTags = [...tags].filter((t) => t !== "basis");
  return applyLearning(chosen, items, ctxTags, signals, days);
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

async function duplicateTrip(id) {
  const { data: u } = await sb.auth.getUser();
  const { data: src } = await sb.from("trips").select("*").eq("id", id).single();
  if (!src) return null;
  const { data: nt } = await sb.from("trips").insert({
    user_id: u.user.id, title: src.title + " (Kopie)", start_date: src.start_date,
    end_date: src.end_date, purpose: src.purpose, persons: src.persons, notes: src.notes,
  }).select().single();
  const { data: legs } = await sb.from("trip_legs").select("*").eq("trip_id", id);
  if (legs?.length) await sb.from("trip_legs").insert(legs.map((l) => ({
    trip_id: nt.id, position: l.position, destination: l.destination, accommodation: l.accommodation,
    transport: l.transport, hand_luggage_only: l.hand_luggage_only, activities: l.activities,
  })));
  const { data: its } = await sb.from("trip_items").select("*").eq("trip_id", id).eq("removed", false);
  if (its?.length) await sb.from("trip_items").insert(its.map((x) => ({
    trip_id: nt.id, item_id: x.item_id, name: x.name, category_id: x.category_id,
    qty: x.qty, weight_grams: x.weight_grams, packed: false, source: x.source, removed: false,
  })));
  return nt.id;
}
async function removeTrip(id) { await sb.from("trips").delete().eq("id", id); }

/* Kuratierte Ziel-Besonderheiten (erweiterbar) */
const DEST_INFO = [
  { re: /sansibar|zanzibar|tansania|tanzania/i, notes: [
    "Pflicht-Reisekrankenversicherung für Sansibar (bei Einreise nachweisen)",
    "Visum nötig (e-Visa / Visa on arrival)",
    "Malaria-Risiko – Prophylaxe & Mückenschutz",
    "Gelbfieber-Impfnachweis bei Einreise aus Gelbfiebergebiet",
    "Steckdosen Typ D/G – Reiseadapter mitnehmen",
  ] },
  { re: /ägypten|egypt|hurghada|gouna|marsa|kairo/i, notes: [
    "Visum nötig (e-Visa / Visa on arrival)",
    "Leitungswasser nicht trinken",
    "Mückenschutz empfehlenswert",
  ] },
  { re: /thailand|bali|indonesien|vietnam/i, notes: [
    "Auslands-Reisekrankenversicherung dringend empfohlen",
    "Reiseadapter prüfen",
    "Mückenschutz (Dengue)",
  ] },
  { re: /usa|amerika|new york|kalifornien|florida/i, notes: [
    "ESTA vor Abflug beantragen",
    "Steckdosen Typ A/B – Adapter nötig",
  ] },
  { re: /uk|england|london|schottland|irland/i, notes: [
    "Steckdosen Typ G – Adapter nötig",
  ] },
];
function destNotesFor(legs) {
  const out = new Set();
  for (const l of legs || []) {
    for (const d of DEST_INFO) if (d.re.test(l.destination || "")) d.notes.forEach((n) => out.add(n));
  }
  return [...out];
}

/* ---------- Wetter (Open-Meteo, kein API-Key) ---------- */
function WeatherPanel({ destination, start, end }) {
  const [st, setSt] = useState({ loading: true });
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!destination) return setSt({ none: true });
        const daysToStart = start ? Math.round((new Date(start) - new Date()) / 86400000) : 999;
        if (daysToStart > 16) return setSt({ tooEarly: true });
        const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(destination)}&count=1&language=de`).then((r) => r.json());
        const loc = g.results && g.results[0];
        if (!loc) return setSt({ noGeo: true });
        const s = start || new Date().toISOString().slice(0, 10);
        const e = end && end >= s ? end : s;
        const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&start_date=${s}&end_date=${e}`).then((r) => r.json());
        if (!alive) return;
        const d = w.daily;
        if (!d || !d.temperature_2m_max) return setSt({ err: true });
        setSt({
          place: loc.name,
          max: Math.round(Math.max(...d.temperature_2m_max)),
          min: Math.round(Math.min(...d.temperature_2m_min)),
          rain: Math.max(...(d.precipitation_probability_max || [0]).map((x) => x || 0)),
        });
      } catch (_e) { if (alive) setSt({ err: true }); }
    })();
    return () => { alive = false; };
  }, [destination, start, end]);

  if (st.loading) return html`<p class="muted">🌦️ Wetter wird geladen…</p>`;
  if (st.tooEarly) return html`<p class="muted">🌦️ Wettervorhersage gibt's ~16 Tage vor Reisebeginn.</p>`;
  if (st.none || st.noGeo) return html`<p class="muted">🌦️ Wetter: Ziel nicht erkannt – Ort genauer angeben.</p>`;
  if (st.err) return html`<p class="muted">🌦️ Wetter derzeit nicht verfügbar.</p>`;
  const hint = st.rain >= 50 ? "Regen möglich – Regenjacke einpacken"
    : st.max >= 25 ? "Warm – Sonnencreme & leichte Kleidung"
    : st.max <= 8 ? "Kühl – warme Schichten"
    : "Wechselhaft – flexibel packen";
  return html`<p style="margin:.2rem 0"><strong>🌡️ ${st.place}:</strong> ${st.min}–${st.max}°C · Regen bis ${st.rain}%<br /><span class="muted">${hint}</span></p>`;
}

/* ---------- Orts-Autocomplete (Open-Meteo Geocoding, kein API-Key) ---------- */
function DestInput({ value, onChange }) {
  const [q, setQ] = useState(value || "");
  const [sug, setSug] = useState([]);
  const [open, setOpen] = useState(false);
  useEffect(() => { setQ(value || ""); }, [value]);
  useEffect(() => {
    if (!q || q.length < 2) { setSug([]); return; }
    let alive = true;
    const id = setTimeout(async () => {
      try {
        const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=de`).then((r) => r.json());
        if (alive) setSug((g.results || []).map((r) => ({
          label: [r.name, r.admin1, r.country].filter(Boolean).join(", "),
          short: [r.name, r.country].filter(Boolean).join(", "),
        })));
      } catch (_e) { if (alive) setSug([]); }
    }, 300);
    return () => { alive = false; clearTimeout(id); };
  }, [q]);
  return html`
    <div style="position:relative">
      <input placeholder="Ort suchen… z. B. El Gouna" value=${q}
             onInput=${(e) => { setQ(e.target.value); onChange(e.target.value); setOpen(true); }}
             onFocus=${() => setOpen(true)}
             onBlur=${() => setTimeout(() => setOpen(false), 150)} />
      ${open && sug.length > 0 && html`
        <div class="suggest">
          ${sug.map((s) => html`
            <div class="suggest-item" onMouseDown=${() => { setQ(s.short); onChange(s.short); setSug([]); setOpen(false); }}>${s.label}</div>`)}
        </div>`}
    </div>`;
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
      <div class="title" style="cursor:pointer" onClick=${() => go({ name: "home" })}>🧳 Packassistent</div>
      ${profile?.role === "admin" &&
        html`<button class="ghost" onClick=${() => go({ name: "admin" })}>Nutzerverwaltung</button>`}
      <button class="ghost" onClick=${() => sb.auth.signOut()}>Logout</button>
    </header>
    <main>
      ${view.name === "home" && html`<${Home} go=${go} />`}
      ${view.name === "wizard" && html`<${Wizard} go=${go} editId=${view.editId} />`}
      ${view.name === "trip" && html`<${TripView} tripId=${view.tripId} go=${go} />`}
      ${view.name === "review" && html`<${Review} tripId=${view.tripId} go=${go} />`}
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
    try {
      const creds = { email: email.trim(), password: pw };
      const { data, error } =
        mode === "login"
          ? await sb.auth.signInWithPassword(creds)
          : await sb.auth.signUp(creds);
      if (error) { setMsg(error.message); return; }
      if (mode === "signup" && !data.session) {
        setMode("login");
        setMsg("Registriert! Bitte jetzt anmelden.");
      }
      // Bei vorhandener Session übernimmt onAuthStateChange automatisch.
    } catch (err) {
      setMsg("Fehler: " + (err?.message || String(err)));
    } finally {
      setBusy(false);
    }
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
  const load = () =>
    sb.from("trips").select("*").order("start_date", { ascending: false, nullsFirst: false })
      .then(({ data }) => setTrips(data || []));
  useEffect(() => { load(); }, []);
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = (trips || []).filter((t) => !t.end_date || t.end_date >= today);
  const past = (trips || []).filter((t) => t.end_date && t.end_date < today);

  return html`
    <h1>Deine Reisen</h1>
    <p class="muted">Neue Packliste erstellen oder frühere ansehen.</p>
    ${trips === null && html`<div class="spinner"></div>`}
    ${trips && trips.length === 0 && html`<div class="card center muted">Noch keine Reise. Leg unten los! 👇</div>`}
    ${upcoming.length > 0 && html`<h2>Anstehend & offen</h2>`}
    ${upcoming.map((t) => html`<${TripCard} t=${t} go=${go} reload=${load} />`)}
    ${past.length > 0 && html`<h2>Archiv</h2>`}
    ${past.map((t) => html`<${TripCard} t=${t} go=${go} reload=${load} />`)}
    <div class="actionbar">
      <button class="primary block" onClick=${() => go({ name: "wizard" })}>+ Neue Reise</button>
    </div>
  `;
}
function TripCard({ t, go, reload }) {
  const fmt = (d) => (d ? new Date(d).toLocaleDateString("de-DE", { day: "2-digit", month: "short" }) : "?");
  async function copy(e) { e.stopPropagation(); await duplicateTrip(t.id); reload(); }
  async function del(e) {
    e.stopPropagation();
    if (!confirm(`„${t.title}“ wirklich löschen?`)) return;
    await removeTrip(t.id); reload();
  }
  return html`
    <div class="card" style="cursor:pointer" onClick=${() => go({ name: "trip", tripId: t.id })}>
      <div style="display:flex;align-items:center;gap:10px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:700">${t.title}</div>
          <div class="muted" style="font-size:.85rem">
            ${fmt(t.start_date)} – ${fmt(t.end_date)} · ${t.purpose === "business" ? "Business" : "Privat"}
          </div>
        </div>
        <button class="mini-ic" title="Kopieren" onClick=${copy}>⧉</button>
        <button class="mini-ic" title="Löschen" onClick=${del}>🗑</button>
      </div>
    </div>
  `;
}

/* ---------- Assistent (Wizard) ---------- */
function emptyLeg() {
  return { destination: "", accommodation: "Hotel", transport: "flug", hand_luggage_only: false, activities: [] };
}
function Wizard({ go, editId }) {
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [purpose, setPurpose] = useState("privat");
  const [persons, setPersons] = useState(1);
  const [legs, setLegs] = useState([emptyLeg()]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [trips, setTrips] = useState([]);
  const [template, setTemplate] = useState(""); // optionale Vorlage-Reise

  useEffect(() => {
    sb.from("trips").select("id,title,start_date")
      .order("start_date", { ascending: false, nullsFirst: false })
      .then(({ data }) => setTrips(data || []));
  }, []);

  // Bearbeiten-Modus: bestehende Reise + Etappen vorbefüllen
  useEffect(() => {
    if (!editId) return;
    (async () => {
      const [{ data: t }, { data: lg }] = await Promise.all([
        sb.from("trips").select("*").eq("id", editId).single(),
        sb.from("trip_legs").select("*").eq("trip_id", editId).order("position"),
      ]);
      if (t) {
        setTitle(t.title); setStart(t.start_date || ""); setEnd(t.end_date || "");
        setPurpose(t.purpose || "privat"); setPersons(t.persons || 1);
      }
      if (lg && lg.length) setLegs(lg.map((l) => ({
        destination: l.destination || "", accommodation: l.accommodation || "Hotel",
        transport: l.transport || "flug", hand_luggage_only: !!l.hand_luggage_only,
        activities: l.activities || [],
      })));
    })();
  }, [editId]);

  const setLeg = (i, patch) => setLegs((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  // Anlass "Business" markiert automatisch die Aktivität "Business" in allen Etappen
  const choosePurpose = (p) => {
    setPurpose(p);
    setLegs((ls) => ls.map((l) => ({
      ...l,
      activities: p === "business"
        ? Array.from(new Set([...l.activities, "business"]))
        : l.activities.filter((t) => t !== "business"),
    })));
  };
  const toggleAct = (i, tag) =>
    setLeg(i, {
      activities: legs[i].activities.includes(tag)
        ? legs[i].activities.filter((t) => t !== tag)
        : [...legs[i].activities, tag],
    });
  const days = daysBetween(start, end);

  const legRows = (tid) => legs.map((l, i) => ({
    trip_id: tid, position: i + 1, destination: l.destination, accommodation: l.accommodation,
    transport: l.transport, hand_luggage_only: l.hand_luggage_only, activities: l.activities,
  }));

  async function create() {
    setErr("");
    if (!title.trim()) return setErr("Bitte einen Titel angeben.");
    if (!start || !end) return setErr("Bitte Zeitraum wählen.");
    if (end < start) return setErr("Enddatum liegt vor Startdatum.");
    setBusy(true);
    const { items } = await loadMeta();
    const { data: signals } = await sb.from("pack_signals").select("*");
    const tripData = { title: title.trim(), start_date: start, end_date: end, purpose, persons };

    if (editId) {
      // Bearbeiten: Reise + Etappen aktualisieren, Liste neu berechnen.
      await sb.from("trips").update(tripData).eq("id", editId);
      await sb.from("trip_legs").delete().eq("trip_id", editId);
      await sb.from("trip_legs").insert(legRows(editId));
      const { data: existing } = await sb.from("trip_items").select("*").eq("trip_id", editId).eq("removed", false);
      // Gepackte & selbst hinzugefügte Items behalten, alte Vorschläge verwerfen
      const keepNames = new Set((existing || []).filter((x) => x.packed || x.source === "manual").map((x) => x.name.toLowerCase()));
      const throwaway = (existing || []).filter((x) => !x.packed && x.source !== "manual");
      if (throwaway.length) await sb.from("trip_items").delete().in("id", throwaway.map((x) => x.id));
      const fresh = generateList(items, tripData, legs, signals).filter((x) => !keepNames.has(x.name.toLowerCase()));
      if (fresh.length) await sb.from("trip_items").insert(fresh.map((x) => ({ ...x, trip_id: editId })));
      setBusy(false);
      go({ name: "trip", tripId: editId });
      return;
    }

    const { data: user } = await sb.auth.getUser();
    const { data: trip, error } = await sb.from("trips")
      .insert({ user_id: user.user.id, ...tripData }).select().single();
    if (error) { setBusy(false); return setErr(error.message); }
    await sb.from("trip_legs").insert(legRows(trip.id));
    let list = generateList(items, trip, legs, signals);
    if (template) {
      // Auf bestehende Reise aufbauen: deren Items zuerst, dann neue Vorschläge ergänzen
      const { data: tItems } = await sb.from("trip_items")
        .select("name,category_id,qty,weight_grams,item_id")
        .eq("trip_id", template).eq("removed", false);
      const base = (tItems || []).map((t) => ({
        item_id: t.item_id, name: t.name, category_id: t.category_id,
        qty: t.qty, weight_grams: t.weight_grams, packed: false, source: "suggested", removed: false,
      }));
      const extra = list.filter((x) => !base.some((b) => b.name.toLowerCase() === x.name.toLowerCase()));
      list = [...base, ...extra];
    }
    const rows = list.map((x) => ({ ...x, trip_id: trip.id }));
    if (rows.length) await sb.from("trip_items").insert(rows);
    setBusy(false);
    go({ name: "trip", tripId: trip.id });
  }

  return html`
    <div style="display:flex;align-items:center;gap:10px">
      <button class="ghost" style="width:auto;min-height:34px;padding:5px 10px;font-size:.8rem"
              onClick=${() => go({ name: "home" })}>‹ Zurück</button>
      <h1 style="flex:1;font-size:1.3rem;margin:0">${editId ? "Reise bearbeiten" : "Neue Reise"}</h1>
    </div>

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
          <button class=${"chip " + (purpose === p ? "on" : "")} onClick=${() => choosePurpose(p)}>
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

    ${!editId && trips.length > 0 && html`
      <div class="card">
        <label>Auf bestehende Reise aufbauen (optional)</label>
        <select value=${template} onChange=${(e) => setTemplate(e.target.value)}>
          <option value="">— Nur aus Vorschlägen erstellen —</option>
          ${trips.map((t) => html`<option value=${t.id}>${t.title}</option>`)}
        </select>
        ${template && html`<p class="muted" style="margin:.5rem 0 0;font-size:.8rem">Die neue Liste startet mit den Items dieser Reise und ergänzt neue Vorschläge.</p>`}
      </div>`}

    ${legs.map((leg, i) => html`
      <div class="card">
        <div style="display:flex;align-items:center">
          <strong style="flex:1">${legs.length > 1 ? `Etappe ${i + 1}` : "Ziel"}</strong>
          ${legs.length > 1 && html`<button class="danger" style="width:auto" onClick=${() => setLegs(legs.filter((_, k) => k !== i))}>Entfernen</button>`}
        </div>
        <label>Reiseziel</label>
        <${DestInput} value=${leg.destination} onChange=${(v) => setLeg(i, { destination: v })} />
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

    <button class="ghost block" onClick=${() => setLegs([...legs, purpose === "business" ? { ...emptyLeg(), activities: ["business"] } : emptyLeg()])}>+ Weitere Etappe (Rundreise)</button>
    ${err && html`<p class="error">${err}</p>`}

    <button class="primary block" style="min-height:56px;font-size:1.05rem;margin-top:8px"
            disabled=${busy} onClick=${create}>
      ${busy ? "Speichere…" : editId ? "Änderungen übernehmen" : "Packliste erstellen"}
    </button>
    <div style="height:24px"></div>
  `;
}

/* ---------- Reise-/Listenansicht ---------- */
function TripView({ tripId, go }) {
  const [trip, setTrip] = useState(null);
  const [items, setItems] = useState(null);
  const [legs, setLegs] = useState([]);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [addCat, setAddCat] = useState(null);   // Kategorie-Key, in dem gerade hinzugefügt wird
  const [addText, setAddText] = useState("");

  async function reload() {
    if (!categories.length) await loadMeta();
    const [{ data: t }, { data: it }, { data: lg }] = await Promise.all([
      sb.from("trips").select("*").eq("id", tripId).single(),
      sb.from("trip_items").select("*").eq("trip_id", tripId).eq("removed", false).order("created_at"),
      sb.from("trip_legs").select("*").eq("trip_id", tripId).order("position"),
    ]);
    setTrip(t); setItems(it || []); setLegs(lg || []);
  }
  useEffect(() => { reload(); }, [tripId]);

  async function patch(id, p) {
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));
    await sb.from("trip_items").update(p).eq("id", id);
  }
  async function remove(x) {
    setItems((xs) => xs.filter((i) => i.id !== x.id));
    await sb.from("trip_items").update({ removed: true }).eq("id", x.id);
    recordSignal("removed", x.name, contextTags(trip, legs), x.category_id);
  }
  async function addToCat(catId) {
    if (!addText.trim()) return;
    const row = { trip_id: tripId, item_id: null, name: addText.trim(), category_id: catId, qty: 1, source: "manual", packed: false, removed: false };
    const { data } = await sb.from("trip_items").insert(row).select().single();
    setItems((xs) => [...xs, data]);
    recordSignal("added", row.name, contextTags(trip, legs), catId);
    setAddText(""); setAddCat(null);
  }
  const toggle = (key) => setCollapsed((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  async function copyTrip() { const nid = await duplicateTrip(tripId); if (nid) go({ name: "trip", tripId: nid }); }
  async function deleteTrip() {
    if (!confirm("Diese Packliste wirklich löschen?")) return;
    await removeTrip(tripId); go({ name: "home" });
  }

  if (!trip || !items) return html`<div class="spinner"></div>`;

  const groups = categories
    .map((c) => ({ cat: c, list: items.filter((x) => x.category_id === c.id) }))
    .filter((g) => g.list.length);
  const uncategorized = items.filter((x) => !x.category_id);
  if (uncategorized.length) groups.push({ cat: { id: null, name: "Sonstiges", icon: "📦" }, list: uncategorized });

  const total = items.length;
  const done = items.filter((x) => x.packed).length;
  const weight = items.reduce((s, x) => s + (x.packed ? 0 : (x.weight_grams || 0) * x.qty), 0);
  const firstDest = (legs.find((l) => l.destination) || {}).destination || "";
  const transports = [...new Set(legs.map((l) => l.transport).filter(Boolean))];
  const tLabel = (v) => (TRANSPORT.find((t) => t.v === v) || { l: v }).l;
  const notes = destNotesFor(legs);

  return html`
    <div style="display:flex;align-items:center;gap:10px">
      <button class="ghost" style="width:auto" onClick=${() => go({ name: "home" })}>‹</button>
      <h1 style="flex:1;font-size:1.25rem">${trip.title}</h1>
      <button class="mini-ic" title="Bedingungen ändern" onClick=${() => go({ name: "wizard", editId: tripId })}>✎</button>
    </div>
    <p class="muted">
      ${done}/${total} gepackt${weight > 0 ? ` · offen ${(weight / 1000).toFixed(1)} kg` : ""}
    </p>
    <div class="listbar">
      <span class="lbl">Kategorien</span>
      <button class="mini-ic" title="Alle ausklappen" onClick=${() => setCollapsed(new Set())}>▾</button>
      <button class="mini-ic" title="Alle einklappen" onClick=${() => setCollapsed(new Set(groups.map((g) => g.cat.id || g.cat.name)))}>▸</button>
    </div>

    ${groups.map((g) => {
      const key = g.cat.id || g.cat.name;
      const open = !collapsed.has(key);
      return html`
        <div class="cathead" onClick=${() => toggle(key)}>
          <span class=${"chev " + (open ? "" : "closed")}>▾</span>
          <span>${g.cat.icon || "•"}</span><span>${g.cat.name}</span>
          <span class="count">${g.list.filter((x) => x.packed).length}/${g.list.length}</span>
        </div>
        ${open &&
          html`
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
                  <button class="danger" style="width:auto" onClick=${() => remove(x)}>✕</button>
                </div>`)}
              ${addCat === key &&
                html`
                  <div class="addrow">
                    <input autofocus placeholder="Was fehlt hier noch?" value=${addText}
                           onInput=${(e) => setAddText(e.target.value)}
                           onKeyDown=${(e) => e.key === "Enter" && addToCat(g.cat.id)} />
                    <button class="primary" onClick=${() => addToCat(g.cat.id)}>OK</button>
                  </div>`}
              ${g.cat.id && addCat !== key &&
                html`<button class="addlink" onClick=${() => { setAddCat(key); setAddText(""); }}>＋ Item hinzufügen</button>`}
            </div>`}
      `;
    })}

    <h2>Infos & Entscheidungskriterien</h2>
    <div class="card">
      <p class="muted" style="margin-top:0">
        ${firstDest ? firstDest : "Ziel offen"} · ${daysBetween(trip.start_date, trip.end_date)} Tage${transports.length ? " · " + transports.map(tLabel).join(", ") : ""}
      </p>
      <${WeatherPanel} destination=${firstDest} start=${trip.start_date} end=${trip.end_date} />
      ${notes.length > 0 && html`
        <div style="margin-top:10px">
          <strong>📌 Besonderheiten am Ziel</strong>
          <ul class="list-clean" style="margin:8px 0 0">
            ${notes.map((n) => html`<li style="padding:4px 0;display:flex;gap:8px"><span>•</span><span>${n}</span></li>`)}
          </ul>
        </div>`}
      <p class="muted" style="margin:12px 0 0;font-size:.78rem">
        Hinweise ohne Gewähr – bitte offizielle Quellen (Auswärtiges Amt) prüfen.
      </p>
    </div>

    <button class="ghost block" style="margin-top:18px" onClick=${() => go({ name: "review", tripId })}>
      📝 Reise-Rückblick${trip.reviewed_at ? " ✓" : ""}
    </button>
    <div class="row" style="margin-top:10px">
      <button class="ghost" onClick=${copyTrip}>⧉ Kopieren</button>
      <button class="danger" onClick=${deleteTrip}>🗑 Löschen</button>
    </div>
    <div style="height:24px"></div>
  `;
}

/* ---------- Reise-Rückblick (Lernen) ---------- */
function Review({ tripId, go }) {
  const [trip, setTrip] = useState(null);
  const [legs, setLegs] = useState([]);
  const [items, setItems] = useState(null);
  const [marks, setMarks] = useState({}); // trip_item.id -> 'used' | 'unused'
  const [missed, setMissed] = useState([]);
  const [mName, setMName] = useState("");
  const [mCat, setMCat] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      if (!categories.length) await loadMeta();
      setMCat(categories[0]?.id || "");
      const [{ data: t }, { data: lg }, { data: it }] = await Promise.all([
        sb.from("trips").select("*").eq("id", tripId).single(),
        sb.from("trip_legs").select("*").eq("trip_id", tripId),
        sb.from("trip_items").select("*").eq("trip_id", tripId).eq("removed", false).order("name"),
      ]);
      setTrip(t); setLegs(lg || []); setItems(it || []);
    })();
  }, [tripId]);

  const setMark = (id, v) => setMarks((m) => ({ ...m, [id]: m[id] === v ? undefined : v }));
  function addMissed() {
    if (!mName.trim()) return;
    setMissed((xs) => [...xs, { name: mName.trim(), category_id: mCat }]);
    setMName("");
  }
  async function save() {
    setBusy(true);
    const ctx = contextTags(trip, legs);
    const { data: u } = await sb.auth.getUser();
    const rows = [];
    for (const it of items) {
      const v = marks[it.id];
      if (v === "used" || v === "unused")
        rows.push({ user_id: u.user.id, item_name: it.name, kind: v, tags: ctx, category_id: it.category_id });
    }
    for (const m of missed)
      rows.push({ user_id: u.user.id, item_name: m.name, kind: "missed", tags: ctx, category_id: m.category_id });
    if (rows.length) await sb.from("pack_signals").insert(rows);
    await sb.from("trips").update({ reviewed_at: new Date().toISOString() }).eq("id", tripId);
    setBusy(false);
    go({ name: "trip", tripId });
  }

  if (!trip || !items) return html`<div class="spinner"></div>`;
  return html`
    <div style="display:flex;align-items:center;gap:10px">
      <button class="ghost" style="width:auto" onClick=${() => go({ name: "trip", tripId })}>‹</button>
      <h1 style="flex:1;font-size:1.25rem">Rückblick</h1>
    </div>
    <p class="muted">Was hast du gebraucht oder nicht? Das verbessert deine künftigen Vorschläge – kontextbezogen zu dieser Reiseart.</p>

    <div class="card" style="padding:6px 14px">
      ${items.map((it) => html`
        <div class="pitem">
          <span class="name" style="flex:1">${it.name}</span>
          <button class=${"tag-btn " + (marks[it.id] === "used" ? "on-ok" : "")} onClick=${() => setMark(it.id, "used")}>gebraucht</button>
          <button class=${"tag-btn " + (marks[it.id] === "unused" ? "on-bad" : "")} onClick=${() => setMark(it.id, "unused")}>unnötig</button>
        </div>`)}
    </div>

    <h2>Etwas vermisst?</h2>
    <div class="card">
      ${missed.map((m) => html`<div class="pitem"><span class="name" style="flex:1">＋ ${m.name}</span></div>`)}
      <div class="addrow">
        <input placeholder="Vermisstes Item…" value=${mName} onInput=${(e) => setMName(e.target.value)}
               onKeyDown=${(e) => e.key === "Enter" && addMissed()} />
        <button class="primary" onClick=${addMissed}>+</button>
      </div>
      <select value=${mCat} onChange=${(e) => setMCat(e.target.value)}>
        ${categories.map((c) => html`<option value=${c.id}>${c.icon} ${c.name}</option>`)}
      </select>
    </div>

    <button class="primary block" style="min-height:52px;margin-top:8px" disabled=${busy} onClick=${save}>
      ${busy ? "Speichere…" : "Rückblick speichern"}
    </button>
    <div style="height:24px"></div>
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
