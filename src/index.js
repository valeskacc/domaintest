// Cloudflare Worker für test.valeska.cc
// Öffentliche Startseite + geschützter Mitgliederbereich (/app) via Supabase Auth.
// Der Publishable Key ist bewusst öffentlich (Client-seitig vorgesehen).
// Passwörter werden ausschließlich in Supabase gehasht gespeichert, niemals hier.

const SUPABASE_URL = "https://mfvghwzpkrewnvbgihpq.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_1uPQ3IDCOb9hBY8JJ8hfcw_pPgA9dtg";

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh;
         display: flex; align-items: center; justify-content: center;
         background: #111; color: #eee; }
  .card { width: 100%; max-width: 360px; padding: 2rem; text-align: center; }
  h1 { margin: 0 0 .5rem; }
  p { color: #bbb; }
  form { display: flex; flex-direction: column; gap: .75rem; text-align: left; margin-top: 1rem; }
  label { display: flex; flex-direction: column; gap: .25rem; font-size: .85rem; color: #ccc; }
  input { padding: .6rem .7rem; border-radius: 8px; border: 1px solid #333;
          background: #1b1b1b; color: #eee; font-size: 1rem; }
  button { padding: .6rem .7rem; border-radius: 8px; border: 0; cursor: pointer;
           background: #f38020; color: #111; font-weight: 600; font-size: 1rem; }
  button.secondary { background: #333; color: #eee; }
  a { color: #f38020; }
  .err { color: #ff6b6b; font-size: .85rem; }
`;

const LANDING_PAGE = `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hello World — test.valeska.cc</title>
  <style>${STYLE}</style>
</head>
<body>
  <div class="card">
    <h1>Hello World</h1>
    <p>Läuft auf Cloudflare Workers — test.valeska.cc</p>
    <p><a href="/app">Zum Mitgliederbereich &rarr;</a></p>
  </div>
</body>
</html>`;

const APP_PAGE = `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mitgliederbereich — test.valeska.cc</title>
  <style>${STYLE}</style>
</head>
<body>
  <div class="card" id="root"><p>Lädt…</p></div>
  <script type="module">
    import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

    const supabase = createClient("${SUPABASE_URL}", "${SUPABASE_PUBLISHABLE_KEY}");
    const root = document.getElementById("root");

    function esc(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }

    function renderLogin(message) {
      root.innerHTML =
        "<h1>Login</h1>" +
        "<p>Bitte melde dich an.</p>" +
        (message ? "<p class='err'>" + esc(message) + "</p>" : "") +
        "<form id='loginForm'>" +
        "<label>E-Mail<input type='email' id='email' autocomplete='username' required></label>" +
        "<label>Passwort<input type='password' id='password' autocomplete='current-password' required></label>" +
        "<button type='submit'>Anmelden</button>" +
        "</form>" +
        "<p><a href='/'>&larr; Zur Startseite</a></p>";
      document.getElementById("loginForm").addEventListener("submit", onLogin);
    }

    async function onLogin(event) {
      event.preventDefault();
      const email = document.getElementById("email").value.trim();
      const password = document.getElementById("password").value;
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) { renderLogin("Anmeldung fehlgeschlagen: " + error.message); return; }
      render();
    }

    function renderMember(user) {
      root.innerHTML =
        "<h1>Willkommen 🎉</h1>" +
        "<p>Du bist eingeloggt als <strong>" + esc(user.email) + "</strong>.</p>" +
        "<p>Das ist der geschützte Mitgliederbereich.</p>" +
        "<button id='logout' class='secondary'>Logout</button>";
      document.getElementById("logout").addEventListener("click", async function () {
        await supabase.auth.signOut();
        render();
      });
    }

    async function render() {
      const { data } = await supabase.auth.getSession();
      if (data.session) renderMember(data.session.user);
      else renderLogin();
    }

    render();
  </script>
</body>
</html>`;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const body = url.pathname === "/app" ? APP_PAGE : LANDING_PAGE;
    return new Response(body, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
