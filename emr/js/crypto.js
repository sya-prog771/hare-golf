/* 暗号化まわり（Web Crypto API のみ使用・外部ライブラリなし）
 *
 * しくみ:
 *  - カルテ等のデータはすべて「データ鍵（DEK, AES-GCM 256bit）」で暗号化して保存する。
 *  - DEK は利用者ごとに、その人のパスワードから PBKDF2-SHA256 で作った鍵（KEK）で包んで（wrap）保存する。
 *  - ログイン = パスワードで DEK を取り出せること。間違ったパスワードでは GCM の認証で失敗する。
 *  - 各レコードは自分の ID を追加認証データ(AAD)にして暗号化するので、別レコードとの差し替えも検出できる。
 */
(function (g) {
  "use strict";
  const subtle = g.crypto && g.crypto.subtle;
  const te = new TextEncoder();
  const td = new TextDecoder();
  const PBKDF2_ITER = 600000; // OWASP 推奨値（2023）

  function b64e(buf) {
    const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64d(str) {
    const s = atob(str);
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }
  function rand(n) { return g.crypto.getRandomValues(new Uint8Array(n)); }
  function normPw(pw) { return String(pw).normalize("NFKC"); } // 全角/半角の打ち間違いを吸収

  async function deriveKek(password, salt, iter) {
    const base = await subtle.importKey("raw", te.encode(normPw(password)), "PBKDF2", false, ["deriveKey"]);
    return subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["wrapKey", "unwrapKey"]
    );
  }

  async function newDek() {
    return subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  }

  async function wrapDek(dek, password, iter) {
    iter = iter || PBKDF2_ITER;
    const salt = rand(16), iv = rand(12);
    const kek = await deriveKek(password, salt, iter);
    const wrapped = await subtle.wrapKey("raw", dek, kek, { name: "AES-GCM", iv });
    return { alg: "PBKDF2-SHA256/AES-GCM", iter, salt: b64e(salt), iv: b64e(iv), wrapped: b64e(wrapped) };
  }

  /** パスワードが違うと例外になる */
  async function unwrapDek(w, password) {
    const kek = await deriveKek(password, b64d(w.salt), w.iter);
    return subtle.unwrapKey(
      "raw", b64d(w.wrapped), kek, { name: "AES-GCM", iv: b64d(w.iv) },
      { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
    );
  }

  async function encryptJson(dek, obj, aad) {
    const iv = rand(12);
    const ct = await subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: te.encode(aad) }, dek, te.encode(JSON.stringify(obj))
    );
    return { iv: b64e(iv), ct: b64e(ct) };
  }

  async function decryptJson(dek, rec, aad) {
    const pt = await subtle.decrypt(
      { name: "AES-GCM", iv: b64d(rec.iv), additionalData: te.encode(aad) }, dek, b64d(rec.ct)
    );
    return JSON.parse(td.decode(pt));
  }

  async function sha256hex(str) {
    const d = await subtle.digest("SHA-256", te.encode(str));
    return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, "0")).join("");
  }

  function uid() {
    const r = rand(10);
    return Date.now().toString(36) + Array.from(r, b => (b % 36).toString(36)).join("");
  }

  g.EMRCrypto = { available: !!subtle, newDek, wrapDek, unwrapDek, encryptJson, decryptJson, sha256hex, uid, PBKDF2_ITER };
})(typeof window !== "undefined" ? window : globalThis);
