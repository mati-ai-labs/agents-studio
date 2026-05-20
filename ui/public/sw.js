const CACHE_NAME = "paperclip-v2";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests and API calls
  if (request.method !== "GET" || url.pathname.startsWith("/api")) {
    return;
  }

  // Network-first for everything — cache is only an offline fallback
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok && url.origin === self.location.origin) {
        const clone = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
      }
      return response;
    } catch {
      if (request.mode === "navigate") {
        const cachedRoot = await caches.match("/");
        if (cachedRoot) return cachedRoot;
        const cachedIndex = await caches.match("/index.html");
        if (cachedIndex) return cachedIndex;
        return new Response("Offline", { status: 503 });
      }
      const cached = await caches.match(request);
      if (cached) return cached;
      return new Response("Offline", { status: 503 });
    }
  })());
});
