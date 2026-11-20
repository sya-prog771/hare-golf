/* IndexedDB の薄いラッパー
 *  users   : 利用者（ログインID・権限・パスワードで包んだデータ鍵）。カルテ内容は含まない
 *  records : 暗号化したレコード { id, type, iv, ct }（type 以外は読めない）
 *  meta    : 監査ログ末尾のハッシュなど、暗号化不要の管理情報
 */
(function (g) {
  "use strict";
  const DB_NAME = "emr-local";
  const DB_VER = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("users")) db.createObjectStore("users", { keyPath: "id" });
        if (!db.objectStoreNames.contains("records")) {
          const s = db.createObjectStore("records", { keyPath: "id" });
          s.createIndex("type", "type");
        }
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

  function wrap(req) {
    return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  }

  async function getAll(store) {
    const db = await open();
    return wrap(db.transaction(store).objectStore(store).getAll());
  }
  async function get(store, key) {
    const db = await open();
    return wrap(db.transaction(store).objectStore(store).get(key));
  }
  async function put(store, val) {
    const db = await open();
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(val);
    return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error("保存が中断されました")); });
  }
  /** 複数ストアへの書き込みを1トランザクションで（全部成功か全部失敗） */
  async function putMany(items) {
    const db = await open();
    const stores = Array.from(new Set(items.map(i => i.store)));
    const tx = db.transaction(stores, "readwrite");
    for (const it of items) tx.objectStore(it.store).put(it.value);
    return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error("保存が中断されました")); });
  }
  async function replaceAll(dump) {
    const db = await open();
    const tx = db.transaction(["users", "records", "meta"], "readwrite");
    for (const s of ["users", "records", "meta"]) {
      const os = tx.objectStore(s);
      os.clear();
      for (const v of dump[s] || []) os.put(v);
    }
    return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error("復元が中断されました")); });
  }
  async function dumpAll() {
    return { users: await getAll("users"), records: await getAll("records"), meta: await getAll("meta") };
  }
  async function persist() {
    try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) { /* 対応していない */ }
    return false;
  }

  g.EMRDB = { open, get, getAll, put, putMany, replaceAll, dumpAll, persist, DB_NAME };
})(window);
