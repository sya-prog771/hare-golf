// フェアウェイ予報 service worker
// アプリ本体だけをキャッシュし、天気・ゴルフ場データは毎回ネットから取得する
const CACHE = "hare-golf-v14";
const SHELL = ["./", "./index.html", "./manifest.webmanifest?v=2", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png", "./lib/qrcode.js"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("hare-golf-") && k !== CACHE).map(k => caches.delete(k)))) // 同じサイトの電子カルテ（emr/）のキャッシュは消さない
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return; // 外部APIはそのまま
  if (url.pathname.includes("/emr/")) return; // 電子カルテは自分の service worker で扱う
  // 新しい版があればそれを使い、電波がないときはキャッシュを使う
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
  );
});
