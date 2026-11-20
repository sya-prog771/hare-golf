/* 暗号化まわり
 *
 * しくみ:
 *  - カルテ等のデータはすべて「データ鍵（DEK, AES-256-GCM）」で暗号化して保存する。
 *  - DEK は利用者ごとに、その人のパスワードから PBKDF2-SHA256 で作った鍵（KEK）で暗号化して保存する。
 *  - ログイン = パスワードで DEK を取り出せること。間違ったパスワードでは GCM の認証で失敗する。
 *  - 各レコードは自分の ID を追加認証データ(AAD)にして暗号化するので、別レコードとの差し替えも検出できる。
 *  - 院内サーバーとの通信の認証には、DEK から一方向に作った「サーバー認証鍵」で HMAC 署名する
 *    （サーバーはこの認証鍵しか持たないので、カルテの中身は読めない）。
 *
 * Web Crypto が使えない環境（http://192.168.x.x など）では、同じ計算を純JS実装（jscrypto.js）で行う。
 */
(function (g) {
  "use strict";
  const J = g.EMRJsCrypto;
  const forceJs = typeof location !== "undefined" && /[?&]jscrypto=1\b/.test(location.search);
  const subtle = !forceJs && g.crypto && g.crypto.subtle ? g.crypto.subtle : null;
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
  const toHex = u => Array.from(u, b => b.toString(16).padStart(2, "0")).join("");
  function rand(n) { return g.crypto.getRandomValues(new Uint8Array(n)); }
  function normPw(pw) { return String(pw).normalize("NFKC"); } // 全角/半角の打ち間違いを吸収

  async function pbkdf2(password, salt, iter) {
    const pw = te.encode(normPw(password));
    if (subtle) {
      const base = await subtle.importKey("raw", pw, "PBKDF2", false, ["deriveBits"]);
      return new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, base, 256));
    }
    return J.pbkdf2(pw, salt, iter);
  }
  async function gcmEnc(raw, cryptoKey, iv, data, aad) {
    if (subtle) {
      const k = cryptoKey || await subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
      return new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, k, data));
    }
    return J.gcmEncrypt(raw, iv, data, aad);
  }
  async function gcmDec(raw, cryptoKey, iv, data, aad) {
    if (subtle) {
      const k = cryptoKey || await subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
      return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, k, data));
    }
    return J.gcmDecrypt(raw, iv, data, aad);
  }

  /** DEK は { raw: 32バイト, key: CryptoKey|null } で持つ */
  async function importDek(raw) {
    const key = subtle ? await subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]) : null;
    return { raw, key };
  }
  async function newDek() { return importDek(rand(32)); }

  // 保存形式は Web Crypto の wrapKey("raw", dek, kek, AES-GCM) と同じ（= DEK生バイトの AES-GCM 暗号化）
  async function wrapDek(dek, password, iter) {
    iter = iter || PBKDF2_ITER;
    const salt = rand(16), iv = rand(12);
    const kek = await pbkdf2(password, salt, iter);
    const wrapped = await gcmEnc(kek, null, iv, dek.raw, new Uint8Array(0));
    return { alg: "PBKDF2-SHA256/AES-GCM", iter, salt: b64e(salt), iv: b64e(iv), wrapped: b64e(wrapped) };
  }

  /** パスワードが違うと例外になる */
  async function unwrapDek(w, password) {
    const kek = await pbkdf2(password, b64d(w.salt), w.iter);
    let raw;
    try { raw = await gcmDec(kek, null, b64d(w.iv), b64d(w.wrapped), new Uint8Array(0)); }
    catch (e) { throw new Error("パスワードが違います"); }
    return importDek(raw);
  }

  async function encryptJson(dek, obj, aad) {
    const iv = rand(12);
    const ct = await gcmEnc(dek.raw, dek.key, iv, te.encode(JSON.stringify(obj)), te.encode(aad));
    return { iv: b64e(iv), ct: b64e(ct) };
  }

  async function decryptJson(dek, rec, aad) {
    const pt = await gcmDec(dek.raw, dek.key, b64d(rec.iv), b64d(rec.ct), te.encode(aad));
    return JSON.parse(td.decode(pt));
  }

  async function sha256bytes(data) {
    if (subtle) return new Uint8Array(await subtle.digest("SHA-256", data));
    return J.sha256(data);
  }
  async function sha256hex(str) { return toHex(await sha256bytes(te.encode(str))); }

  async function hmac(keyRaw, msg) {
    const m = typeof msg === "string" ? te.encode(msg) : msg;
    if (subtle) {
      const k = await subtle.importKey("raw", keyRaw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return new Uint8Array(await subtle.sign("HMAC", k, m));
    }
    return J.hmac(keyRaw, m);
  }
  /** サーバー認証鍵（DEK から一方向に導出。サーバーに渡してもカルテは読めない） */
  async function serverAuthKey(dek) { return hmac(dek.raw, "emr-server-auth-v1"); }

  function uid() {
    const r = rand(10);
    return Date.now().toString(36) + Array.from(r, b => (b % 36).toString(36)).join("");
  }

  g.EMRCrypto = {
    available: !!(g.crypto && g.crypto.getRandomValues), native: !!subtle,
    newDek, wrapDek, unwrapDek, encryptJson, decryptJson, sha256hex, sha256bytes, hmac, serverAuthKey,
    uid, rand, b64e, b64d, toHex, PBKDF2_ITER
  };
})(typeof window !== "undefined" ? window : globalThis);
