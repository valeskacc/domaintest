import { h, render } from "https://esm.sh/preact@10";
import { useState, useEffect } from "https://esm.sh/preact@10/hooks";
import htm from "https://esm.sh/htm@3";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const html = htm.bind(h);

const SUPABASE_URL = "https://qcsezegptoblkpvwhtzx.supabase.co";
const SUPABASE_KEY = "sb_publishable_PkA4IRR8xTrug-JgY-vN5g_EsH34zNB";
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const APPS = [
  { icon: "🧳", name: "Pack-Assistent", desc: "Packlisten & Reisen", href: "https://travel.valeska.cc", ready: true },
  { icon: "✅", name: "To-Do", desc: "Listen, Aufgaben & Prioritäten", href: "https://todo.valeska.cc", ready: true },
  { icon: "♻️", name: "Kauf → 2 raus", desc: "Neu gekauft? Zwei müssen weichen", ready: false },
  { icon: "🩺", name: "Medic", desc: "Gesundheitsdaten & Arzttermine", ready: false },
  { icon: "📅", name: "Kalender", desc: "Termine im Blick", ready: false },
  { icon: "⌚", name: "Health / Garmin", desc: "Aktivität & Vitalwerte", ready: false },
];

function App() {
  const [session, setSession] = useState(undefined);
  const [aal, setAal] = useState(null);
  const [view, setView] = useState("home");

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

  const enrolled = aal.nextLevel === "aal2";
  return html`
    <header class="appbar">
      <div class="title" style="cursor:pointer" onClick=${() => setView("home")}>⌂ Home</div>
      <button onClick=${() => setView("security")}>🔐 Sicherheit</button>
      <button onClick=${() => sb.auth.signOut()}>Logout</button>
    </header>
    <main>
      ${view === "security"
        ? html`<${Security} back=${() => setView("home")} onChange=${refreshAal} />`
        : html`
          <h1>Willkommen zurück 👋</h1>
          <p class="muted">Dein persönliches Board – alle Bereiche an einem Ort.</p>
          ${!enrolled && html`
            <div class="card" style="max-width:none;margin:0 0 16px;display:flex;align-items:center;gap:12px">
              <span style="font-size:1.4rem">🔐</span>
              <div style="flex:1">
                <div style="font-weight:700">2-Faktor-Schutz aktivieren</div>
                <div class="muted" style="font-size:.85rem">Empfohlen – schützt dein Konto zusätzlich.</div>
              </div>
              <button class="primary" style="width:auto" onClick=${() => setView("security")}>Einrichten</button>
            </div>`}
          <div class="grid">
            ${APPS.map((a) => a.ready
              ? html`<a class="tile ready" href=${a.href}>
                  <div class="ic">${a.icon}</div><div class="nm">${a.name}</div><div class="ds">${a.desc}</div>
                </a>`
              : html`<div class="tile soon">
                  <span class="badge">bald</span>
                  <div class="ic">${a.icon}</div><div class="nm">${a.name}</div><div class="ds">${a.desc}</div>
                </div>`)}
          </div>`}
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
    } catch (err) { setMsg("Fehler: " + (err?.message || String(err))); }
    finally { setBusy(false); }
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

/* 2FA-Abfrage beim Login */
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
      <div class="card">
        <form onSubmit=${submit}>
          <label>6-stelliger Code</label>
          <input inputmode="numeric" autocomplete="one-time-code" placeholder="123456"
                 value=${code} onInput=${(e) => setCode(e.target.value)} />
          ${err && html`<p class="error" style="margin-top:12px">${err}</p>`}
          <button class="primary" style="margin-top:16px" disabled=${busy}>${busy ? "…" : "Bestätigen"}</button>
        </form>
        <button style="width:100%;margin-top:10px" onClick=${onLogout}>Abbrechen / Logout</button>
      </div>
    </main>
  `;
}

/* 2FA einrichten / verwalten */
function Security({ back, onChange }) {
  const [status, setStatus] = useState("loading"); // loading | enroll | active
  const [factorId, setFactorId] = useState("");
  const [qr, setQr] = useState("");
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { start(); }, []);
  async function start() {
    setErr("");
    const { data: f } = await sb.auth.mfa.listFactors();
    const totp = f?.totp || [];
    const verified = totp.find((x) => x.status === "verified");
    if (verified) { setFactorId(verified.id); setStatus("active"); return; }
    for (const x of totp) if (x.status !== "verified") await sb.auth.mfa.unenroll({ factorId: x.id });
    const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp" });
    if (error) { setErr(error.message); return; }
    setFactorId(data.id); setQr(data.totp.qr_code); setSecret(data.totp.secret); setStatus("enroll");
  }
  async function verify() {
    setBusy(true); setErr("");
    const { data: ch, error: e1 } = await sb.auth.mfa.challenge({ factorId });
    if (e1) { setErr(e1.message); setBusy(false); return; }
    const { error: e2 } = await sb.auth.mfa.verify({ factorId, challengeId: ch.id, code: code.trim() });
    if (e2) { setErr(e2.message); setBusy(false); return; }
    setBusy(false); await onChange(); back();
  }
  async function remove() {
    if (!confirm("2FA wirklich entfernen?")) return;
    await sb.auth.mfa.unenroll({ factorId });
    await onChange(); back();
  }

  return html`
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
      <button style="width:auto" onClick=${back}>‹ Zurück</button>
      <h1 style="flex:1;font-size:1.35rem;margin:0">2-Faktor-Authentifizierung</h1>
    </div>
    ${status === "loading" && html`<div class="spinner"></div>`}
    ${status === "active" && html`
      <div class="card" style="max-width:none">
        <p style="margin-top:0">✅ 2FA ist <strong>aktiv</strong>. Beim Login wird zusätzlich ein Code aus deiner Authenticator-App verlangt.</p>
        <button class="danger-btn" style="width:100%" onClick=${remove}>2FA entfernen</button>
      </div>`}
    ${status === "enroll" && html`
      <div class="card" style="max-width:none">
        <p style="margin-top:0">1. Scanne den QR-Code mit deiner Authenticator-App (Google/Microsoft Authenticator, 1Password …).</p>
        <div class="center"><img class="qr" src=${qr} alt="QR-Code" /></div>
        <p class="muted" style="font-size:.82rem">Kein Scannen möglich? Schlüssel manuell eingeben:</p>
        <div class="mono" style="word-break:break-all;background:#0a1413;border:1px solid var(--border);border-radius:10px;padding:10px">${secret}</div>
        <label>2. Code aus der App eingeben</label>
        <input inputmode="numeric" autocomplete="one-time-code" placeholder="123456"
               value=${code} onInput=${(e) => setCode(e.target.value)} />
        ${err && html`<p class="error" style="margin-top:10px">${err}</p>`}
        <button class="primary" style="width:100%;margin-top:14px" disabled=${busy} onClick=${verify}>${busy ? "…" : "Aktivieren"}</button>
      </div>`}
    ${err && status === "loading" && html`<p class="error">${err}</p>`}
  `;
}

render(html`<${App} />`, document.getElementById("app"));
