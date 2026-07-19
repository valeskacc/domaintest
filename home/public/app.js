import { h, render } from "https://esm.sh/preact@10";
import { useState, useEffect } from "https://esm.sh/preact@10/hooks";
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

const APPS = [
  { icon: "🧳", name: "Pack-Assistent", desc: "Packlisten & Reisen", href: "https://travel.valeska.cc", ready: true },
  { icon: "✅", name: "To-Do", desc: "Listen, Aufgaben & Prioritäten", href: "https://todo.valeska.cc", ready: true },
  { icon: "♻️", name: "Kauf → 2 raus", desc: "Neu gekauft? Zwei müssen weichen", href: "https://kauf.valeska.cc", ready: true },
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

  const enrolled = aal.nextLevel === "aal2";
  return html`
    <header class="appbar">
      <div class="title" style="cursor:pointer" onClick=${() => setView("home")}>⌂ Home</div>
      <button onClick=${() => setView("security")}>🔐 Sicherheit</button>
      <button onClick=${signOutEverywhere}>Logout</button>
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
      <${Footer} current="home" />
    </main>
  `;
}

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
      <h1 class="center">⌂ Home</h1>
      <p class="muted center">Bitte anmelden.</p>
      <div class="card">
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
      try { setDeviceTrust(localStorage.getItem("sb-stay-pref") !== "0"); } catch (e) {}
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
    for (const x of totp) if (x.status !== "verified") await sb.auth.mfa.unenroll({ factorId: x.id });
    const verified = totp.find((x) => x.status === "verified");
    if (verified) { setFactorId(verified.id); setStatus("active"); return; }
    await enroll();
  }
  async function enroll() {
    setErr(""); setCode("");
    const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp" });
    if (error) { setErr(error.message); setStatus("active"); return; }
    setFactorId(data.id); setQr(data.totp.qr_code); setSecret(data.totp.secret); setStatus("enroll");
  }
  async function reconfigure() {
    if (!confirm("2FA neu einrichten? Du scannst gleich einen neuen QR-Code – der bisherige wird ersetzt.")) return;
    const { data: f } = await sb.auth.mfa.listFactors();
    for (const x of (f?.totp || [])) await sb.auth.mfa.unenroll({ factorId: x.id });
    await onChange();
    await enroll();
  }
  async function verify() {
    setBusy(true); setErr("");
    const { data: ch, error: e1 } = await sb.auth.mfa.challenge({ factorId });
    if (e1) { setErr(e1.message); setBusy(false); return; }
    const { error: e2 } = await sb.auth.mfa.verify({ factorId, challengeId: ch.id, code: code.trim() });
    if (e2) { setErr(e2.message); setBusy(false); return; }
    setBusy(false); await onChange(); setStatus("active");
  }
  async function remove() {
    if (!confirm("2FA wirklich entfernen?")) return;
    const { data: f } = await sb.auth.mfa.listFactors();
    for (const x of (f?.totp || [])) await sb.auth.mfa.unenroll({ factorId: x.id });
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
        <button class="btn" style="width:100%" onClick=${reconfigure}>🔄 Neu einrichten / QR-Code anzeigen</button>
        <p class="muted" style="font-size:.8rem;margin:8px 0 0">Zum Hinzufügen auf einem weiteren Gerät neu einrichten und den QR-Code auf allen gewünschten Geräten scannen.</p>
        <button class="danger-btn" style="width:100%;margin-top:14px" onClick=${remove}>2FA entfernen</button>
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
