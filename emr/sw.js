/* 電子カルテ service worker
 * 画面のプログラム（HTML・JS・CSS・アイコン）だけを端末に保存し、電波がなくても起動できるようにする。
 * カルテのデータは扱わない（データはアプリ側で暗号化して IndexedDB / 院内サーバーに保存）。
 * 院内サーバーの API（api/）には一切さわらない。
 */
const CACHE = "emr-shell-v2";
const SHELL = [
  "./", "./index.html", "./styles.css", "./manifest.webmanifest", "./guide.html", "./guide.css",
  "./js/jscrypto.js", "./js/diseases.js", "./js/dxmaster.js", "./js/crypto.js", "./js/db.js", "./js/master.js", "./js/store.js", "./js/ui.js",
  "./js/print.js", "./js/demo.js", "./js/charts.js", "./js/app.js", "./js/guide.js", "./vendor/qrcode.js",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-512.png", "./icons/apple-touch-icon.png", "./icons/favicon-32.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith("emr-shell-") && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;
  if (url.pathname.startsWith(scope.pathname + "api/")) return; // 院内サーバーのデータは常にサーバーから

  // 保存済みのものをすぐ返し（電波がなくても即起動）、裏で新しい版を取ってきて次回に使う
  e.respondWith(caches.open(CACHE).then(async cache => {
    const isRoot = url.pathname === scope.pathname; // 「/emr/」は index.html と同じもの
    const key = isRoot ? new URL("./index.html", scope).href : req;
    const cached = await cache.match(key, { ignoreSearch: true });
    const fresh = fetch(req).then(res => {
      if (res && res.ok && res.type === "basic") cache.put(key, res.clone());
      return res;
    }).catch(() => null);
    if (cached) { e.waitUntil(fresh); return cached; }
    const res = await fresh;
    return res || new Response("電波がなく、まだこの端末に保存されていないページです。", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }));
});
