/* 保存先の切りかえ
 *
 *  ローカル版（この端末だけで使う）: ブラウザ内の IndexedDB に保存
 *  院内サーバー版（複数の端末で使う）: 親機の server.js に保存。ほかの端末の変更は自動で届く
 *
 *  どちらも同じ形で使える:
 *    users   : 利用者（ログインID・パスワードで包んだデータ鍵）
 *    records : 暗号化したレコード { id, type, iv, ct }
 *    meta    : 監査ログ末尾のハッシュなど
 */
(function (g) {
  "use strict";
  const C = g.EMRCrypto;

  class ConflictError extends Error {
    constructor(msg) { super(msg || "ほかの端末で先に更新されました。最新の内容を読み込んだので、もう一度操作してください。"); this.conflict = true; }
  }
  class OfflineError extends Error {
    constructor() { super("院内サーバー（親機）につながりません。親機のパソコンと黒い画面が起動しているか、Wi-Fi につながっているか確認してください。"); this.offline = true; }
  }

  // ================================================================ ローカル（IndexedDB）
  const local = (function () {
    const DB_NAME = "emr-local";
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("users")) db.createObjectStore("users", { keyPath: "id" });
          if (!db.objectStoreNames.contains("records")) db.createObjectStore("records", { keyPath: "id" }).createIndex("type", "type");
          if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => { db.close(); alert("別のタブでデータベースが更新されました。再読み込みします。"); location.reload(); };
          resolve(db);
        };
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error("データベースが別のタブで使用中です"));
      });
      return dbp;
    }
    const wrap = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    const done = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error("保存が中断されました")); });
    return {
      mode: "local",
      async getAll(store) { const db = await open(); return wrap(db.transaction(store).objectStore(store).getAll()); },
      async get(store, key) { const db = await open(); return wrap(db.transaction(store).objectStore(store).get(key)); },
      async put(store, value) { return this.putMany([{ store, value }]); },
      async putMany(items) {
        const db = await open();
        const tx = db.transaction(Array.from(new Set(items.map(i => i.store))), "readwrite");
        for (const it of items) tx.objectStore(it.store).put(it.value);
        return done(tx);
      },
      async replaceAll(dump) {
        const db = await open();
        const tx = db.transaction(["users", "records", "meta"], "readwrite");
        for (const s of ["users", "records", "meta"]) { const os = tx.objectStore(s); os.clear(); for (const v of dump[s] || []) os.put(v); }
        return done(tx);
      },
      async dumpAll() { return { users: await this.getAll("users"), records: await this.getAll("records"), meta: await this.getAll("meta") }; },
      async loginFailed(u) {
        u.failed = (u.failed || 0) + 1;
        if (u.failed >= 5) { u.lockedUntil = Date.now() + 5 * 60 * 1000; u.failed = 0; }
        await this.put("users", u);
      },
      async persist() { try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) { /* 非対応 */ } return false; },
      setAuthKey() { }, async initServer() { }, async sync() { }, connect() { }, disconnect() { },
      onRemote() { }, onReset() { }, onStatus() { }, status: "local"
    };
  })();

  // ================================================================ 院内サーバー
  const server = (function () {
    const base = new URL(".", location.href).href; // index.html と同じ場所の api/
    const mirror = { users: new Map(), records: new Map(), meta: new Map() }; // key -> { v, r }
    const keyOf = (s, v) => (s === "meta" ? v.key : v.id);
    let authKey = null, offset = 0, lastSeq = 0, es = null, timer = null, syncing = null;
    const remoteL = new Set(), resetL = new Set(), statusL = new Set();
    let cid = null;
    try { cid = sessionStorage.getItem("emr-cid"); } catch (e) { /* 使えない */ }
    if (!cid) { cid = C.uid(); try { sessionStorage.setItem("emr-cid", cid); } catch (e) { /* noop */ } }
    let userLabel = "";

    function setStatus(s) { if (api.status !== s) { api.status = s; for (const f of statusL) f(s); } }

    async function req(method, path, body, signed) {
      const text = body === undefined ? "" : JSON.stringify(body);
      const headers = { "x-emr-client": cid };
      if (text) headers["content-type"] = "application/json";
      const url = new URL("api/" + path, base);
      if (signed) {
        if (!authKey) throw new Error("ログインしていません");
        const ts = String(Date.now() + offset), nonce = C.toHex(C.rand(12));
        const bodyHash = C.toHex(await C.sha256bytes(new TextEncoder().encode(text)));
        const mac = C.toHex(await C.hmac(authKey, `${method}\n${url.pathname}${url.search}\n${ts}\n${nonce}\n${bodyHash}`));
        headers["x-emr-auth"] = `${ts}.${nonce}.${mac}`;
      }
      let res;
      try { res = await fetch(url, { method, headers, body: text || undefined, cache: "no-store" }); }
      catch (e) { setStatus("offline"); throw new OfflineError(); }
      if (api.status === "offline" || api.status === "init") setStatus("online");
      let data = null;
      try { data = await res.json(); } catch (e) { /* 本文なし */ }
      if (res.status === 409 && data && data.conflict) {
        const changed = applyItems(data.items || []);
        emitRemote(changed);
        throw new ConflictError();
      }
      if (!res.ok) throw new Error((data && data.error) || `院内サーバーでエラーが発生しました（${res.status}）`);
      return data;
    }

    function applyItems(items) {
      const changed = [];
      for (const it of items) {
        if (!it.v) { // サーバー側に存在しない（こちらだけにある）
          continue;
        }
        const k = keyOf(it.s, it.v);
        const cur = mirror[it.s].get(k);
        if (cur && cur.r >= it.r) continue; // 自分の書き込みの折り返しなど
        mirror[it.s].set(k, { v: it.v, r: it.r });
        changed.push({ store: it.s, value: it.v });
      }
      return changed;
    }
    function emitRemote(changed) { if (changed.length) for (const f of remoteL) { try { f(changed); } catch (e) { console.error(e); } } }

    async function sync() {
      if (!authKey) return;
      if (syncing) return syncing;
      syncing = (async () => {
        try {
          const data = await req("GET", `sync?since=${lastSeq}`, undefined, true);
          const changed = applyItems(data.items);
          lastSeq = Math.max(lastSeq, data.seq);
          emitRemote(changed);
        } finally { syncing = null; }
      })();
      return syncing;
    }

    function connect(label) {
      userLabel = label || userLabel;
      disconnect(true);
      es = new EventSource(new URL(`api/events?cid=${encodeURIComponent(cid)}&user=${encodeURIComponent(userLabel)}`, base));
      es.onopen = () => { setStatus("online"); sync().catch(() => { }); };
      es.onmessage = e => {
        let m = {}; try { m = JSON.parse(e.data); } catch (x) { /* noop */ }
        if (api.status !== "online") setStatus("online");
        if (m.seq > lastSeq) sync().catch(() => { });
      };
      es.addEventListener("reset", () => { for (const f of resetL) f(); });
      es.onerror = () => setStatus("offline");
      clearInterval(timer);
      timer = setInterval(() => { if (authKey) sync().catch(() => { }); }, 30000);
    }
    function disconnect(keepAuth) {
      if (es) { es.close(); es = null; }
      clearInterval(timer); timer = null;
      if (!keepAuth) { authKey = null; lastSeq = 0; for (const s of Object.values(mirror)) s.clear(); }
    }

    const api = {
      mode: "server", status: "init", cid,
      async info() {
        const t0 = Date.now();
        const r = await fetch(new URL("api/info", base), { cache: "no-store" });
        const d = await r.json();
        offset = d.time - Math.round((t0 + Date.now()) / 2); // 子機の時計のずれを補正
        return d;
      },
      async statusInfo() { const r = await fetch(new URL("api/status", base), { cache: "no-store" }); return r.json(); },
      async getAll(store) {
        if (store === "users" && !authKey) {
          const list = await req("GET", "users");
          for (const v of list) if (!mirror.users.has(v.id)) mirror.users.set(v.id, { v, r: 0 });
          return list;
        }
        return Array.from(mirror[store].values(), x => x.v);
      },
      async get(store, key) {
        if (store === "users" && !authKey) { const list = await this.getAll("users"); return list.find(u => u.id === key); }
        const x = mirror[store].get(key);
        return x ? x.v : undefined;
      },
      async put(store, value) { return this.putMany([{ store, value }]); },
      async putMany(items) {
        const body = { items: items.map(it => { const cur = mirror[it.store].get(keyOf(it.store, it.value)); return { s: it.store, v: it.value, base: cur ? cur.r : 0 }; }) };
        const data = await req("POST", "write", body, true);
        for (const it of items) mirror[it.store].set(keyOf(it.store, it.value), { v: it.value, r: data.seq });
        if (data.seq === lastSeq + 1) lastSeq = data.seq; // 間にほかの端末の書き込みがなければ、そのまま進める
      },
      async replaceAll(dump) { await req("POST", "restore", { dump }, true); },
      async dumpAll() { return req("GET", "dump", undefined, true); },
      async loginFailed(u) { try { await req("POST", "login-failed", { id: u.id }); } catch (e) { /* 記録できなくてもログイン拒否は変わらない */ } },
      async persist() { return true; },
      setAuthKey(k) { authKey = k; },
      async initServer(k) { await req("POST", "init", { authKey: C.b64e(k) }); },
      async initRestore(k, dump) { await req("POST", "init-restore", { authKey: C.b64e(k), dump }); },
      async sync() { lastSeq = lastSeq || 0; return sync(); },
      connect, disconnect,
      onRemote(f) { remoteL.add(f); }, onReset(f) { resetL.add(f); }, onStatus(f) { statusL.add(f); }
    };
    return api;
  })();

  // ================================================================ 起動時に判定
  let impl = local;
  const DB = {
    ConflictError, OfflineError,
    get mode() { return impl.mode; },
    get status() { return impl.status; },
    async init() {
      if (/^https?:$/.test(location.protocol)) {
        try {
          const d = await server.info();
          if (d && d.app === "emr") { impl = server; return d; }
        } catch (e) { /* 院内サーバーではない（ふつうのWebサーバーやファイル） */ }
      }
      impl = local;
      return null;
    },
    get impl() { return impl; }
  };
  for (const m of ["getAll", "get", "put", "putMany", "replaceAll", "dumpAll", "loginFailed", "persist", "setAuthKey", "initServer", "sync", "connect", "disconnect"]) {
    DB[m] = (...a) => impl[m](...a);
  }
  // 通知の登録は、起動時の判定より前に行われることがあるので、院内サーバー側に直接つける（ローカル版では呼ばれない）
  for (const m of ["onRemote", "onReset", "onStatus"]) DB[m] = f => server[m](f);
  DB.initRestore = (...a) => server.initRestore(...a);
  DB.statusInfo = () => server.statusInfo();
  g.EMRDB = DB;
})(window);
