/* Service Worker: macht die App auch ganz ohne Netz startbar.
   - Eigene Dateien (HTML/JS): "Netz zuerst, bei Fehler aus dem Cache" – online bekommst
     du also immer den neuesten Stand, offline den zuletzt geladenen.
   - Fremde CDN-Module (esm.sh: preact/htm/supabase-js): "aus Cache sofort, im Hintergrund
     auffrischen" – ohne diese Module könnte die App offline gar nicht erst starten,
     weil ihre import-Anweisungen sonst ohne Netz fehlschlagen.
   Wichtig: eine fetch-Behandlung darf NIE ablehnen (reject) – Safari zeigt dann
   "Safari kann die Seite nicht öffnen" statt einer sinnvollen Rückfalllösung.
   Genauso wichtig: jeder fetch() bekommt ein kurzes eigenes Zeitlimit – sonst wartet
   der Browser bei totalem Verbindungsverlust (Flugmodus) auf das systemeigene
   Timeout (kann 30-40+ Sekunden dauern), bevor überhaupt der Cache greift. */
const SHELL_CACHE = "shell-v3";
const CDN_CACHE = "cdn-v4";
const PRECACHE_URLS = ["/", "/index.html", "/app.js"];
const CDN_HOST = "esm.sh"; // nur das eigentliche Modul-CDN cachen, keine anderen APIs (z. B. Wetterdaten)

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => Promise.all(PRECACHE_URLS.map((u) => cache.add(u).catch(() => {}))))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== SHELL_CACHE && n !== CDN_CACHE).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co")) return; // Datenzugriffe nie hier behandeln

  if (url.origin === location.origin) {
    e.respondWith(networkFirst(req, SHELL_CACHE));
  } else if (url.hostname === CDN_HOST) {
    e.respondWith(staleWhileRevalidate(req, CDN_CACHE));
  }
  // Alles andere (z. B. Wetter-/Geocoding-Aufrufe) unangetastet lassen – normaler,
  // unveränderter Netzwerkzugriff, nie gecacht.
});

const OFFLINE_FALLBACK = new Response(
  "<!doctype html><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>" +
  "<body style='background:#000;color:#eaf6f4;font-family:system-ui,sans-serif;display:flex;" +
  "align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:20px'>" +
  "<p>🔌 Offline – diese Seite wurde noch nicht geladen.<br>Bitte später erneut versuchen.</p></body>",
  { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
);

function fetchWithTimeout(req, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(req, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetchWithTimeout(req, 12000);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const cached = (await cache.match(req)) || (await cache.match("/index.html")) || (await cache.match("/"));
    return cached || OFFLINE_FALLBACK;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const fetchPromise = fetchWithTimeout(req, 12000)
    .then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; })
    .catch(() => null);
  return cached || (await fetchPromise) || new Response("", { status: 504 });
}
