// Gait Tester service worker
// ・アプリ本体：ネット優先（新しい版があれば使い、電波がないときは保存済みを使う）
// ・AI（MediaPipe のライブラリ・WASM・モデル）：一度読み込んだら保存したものを使う（オフラインで解析できる）
const SHELL_CACHE = "gt-shell-v2";
const AI_CACHE = "gt-ai-v1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];
const AI_HOSTS = ["cdn.jsdelivr.net", "storage.googleapis.com"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== AI_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const isAI = (AI_HOSTS.includes(url.hostname) && /mediapipe/.test(url.pathname)) ||
               (url.origin === self.location.origin && url.pathname.includes("/mediapipe/"));
  if (isAI) {
    e.respondWith(caches.open(AI_CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok && res.type === "basic") { const cp = res.clone(); caches.open(SHELL_CACHE).then(c => c.put(req, cp)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("./index.html")))
  );
});
