export default {
  async fetch(request) {
    return new Response(
      `<!doctype html>
<html lang="de">
<head><meta charset="utf-8"><title>Hello World</title></head>
<body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #111; color: #eee;">
  <div style="text-align: center;">
    <h1>Hello World</h1>
    <p>Läuft auf Cloudflare Workers — test.valeska.cc</p>
  </div>
</body>
</html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } }
    );
  },
};
