/* Service Worker: macht die App auch ganz ohne Netz startbar.
   - Eigene Dateien (HTML/JS): "Netz zuerst, bei Fehler aus dem Cache" – online bekommst
     du also immer den neuesten Stand, offline den zuletzt geladenen.
   - Fremde CDN-Module (esm.sh: preact/htm/supabase-js): "aus Cache sofort, im Hintergrund
     auffrischen" – ohne diese Module könnte die App offline gar nicht erst starten,
     weil ihre import-Anweisungen sonst ohne Netz fehlschlagen. */
const SHELL_CACHE = "shell-v1";
const CDN_CACHE = "cdn-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co")) return; // Datenzugriffe nie hier behandeln

  if (url.origin === location.origin) {
    e.respondWith(networkFirst(req, SHELL_CACHE));
  } else {
    e.respondWith(staleWhileRevalidate(req, CDN_CACHE));
  }
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw e;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req)
    .then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; })
    .catch(() => null);
  return cached || (await fetchPromise) || new Response("", { status: 504 });
}
