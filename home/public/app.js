import { h, render } from "https://esm.sh/preact@10";
import { useState, useEffect } from "https://esm.sh/preact@10/hooks";
import htm from "https://esm.sh/htm@3";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const html = htm.bind(h);

// Zentrales Hub-Projekt (dasselbe wie die Pack-App -> gemeinsamer Login)
const SUPABASE_URL = "https://qcsezegptoblkpvwhtzx.supabase.co";
const SUPABASE_KEY = "sb_publishable_PkA4IRR8xTrug-JgY-vN5g_EsH34zNB";
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const APPS = [
  { icon: "🧳", name: "Pack-Assistent", desc: "Packlisten & Reisen", href: "https://travel.valeska.cc", ready: true },
  { icon: "✅", name: "To-Do", desc: "Aufgaben & Reminder", ready: false },
  { icon: "♻️", name: "Kauf → 2 raus", desc: "Neu gekauft? Zwei müssen weichen", ready: false },
  { icon: "🩺", name: "Medic", desc: "Gesundheitsdaten & Arzttermine", ready: false },
  { icon: "📅", name: "Kalender", desc: "Termine im Blick", ready: false },
  { icon: "⌚", name: "Health / Garmin", desc: "Aktivität & Vitalwerte", ready: false },
];

function App() {
  const [session, setSession] = useState(undefined);
  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) return html`<div class="spinner"></div>`;
  if (!session) return html`<${Login} />`;
  return html`
    <header class="appbar">
      <div class="title">⌂ Home</div>
      <button onClick=${() => sb.auth.signOut()}>Logout</button>
    </header>
    <main>
      <h1>Willkommen zurück 👋</h1>
      <p class="muted">Dein persönliches Board – alle Bereiche an einem Ort.</p>
      <div class="grid">
        ${APPS.map((a) => a.ready
          ? html`<a class="tile ready" href=${a.href}>
              <div class="ic">${a.icon}</div>
              <div class="nm">${a.name}</div>
              <div class="ds">${a.desc}</div>
            </a>`
          : html`<div class="tile soon">
              <span class="badge">bald</span>
              <div class="ic">${a.icon}</div>
              <div class="nm">${a.name}</div>
              <div class="ds">${a.desc}</div>
            </div>`)}
      </div>
    </main>
  `;
}

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
    } catch (err) {
      setMsg("Fehler: " + (err?.message || String(err)));
    } finally {
      setBusy(false);
    }
  }
  return html`
    <main>
      <h1 class="center">⌂ Home</h1>
      <p class="muted center">Bitte anmelden.</p>
      <div class="card">
        <form onSubmit=${submit}>
          <label>E-Mail</label>
          <input type="email" autocomplete="username" required value=${email} onInput=${(e) => setEmail(e.target.value)} />
          <label>Passwort</label>
          <input type="password" autocomplete="current-password" required value=${pw} onInput=${(e) => setPw(e.target.value)} />
          ${msg && html`<p class="error" style="margin-top:12px">${msg}</p>`}
          <button class="primary" style="margin-top:16px" disabled=${busy}>${busy ? "…" : "Anmelden"}</button>
        </form>
      </div>
    </main>
  `;
}

render(html`<${App} />`, document.getElementById("app"));
