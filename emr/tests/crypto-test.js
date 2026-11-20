/* 純JS暗号（js/jscrypto.js）が標準実装（Node の Web Crypto）と同じ結果になるかを照合する
 *   実行: node emr/tests/crypto-test.js
 */
require("../js/jscrypto.js");
const J = globalThis.EMRJsCrypto;
const { webcrypto } = require("crypto");
const subtle = webcrypto.subtle;
const hex = b => Buffer.from(b).toString("hex");
const rnd = n => webcrypto.getRandomValues(new Uint8Array(n));
let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log("  ✗ " + m); } };

(async () => {
  // 既知の値（FIPS 180-2 / NIST SP 800-38D テストケース16）
  ok(hex(J.sha256(new TextEncoder().encode("abc"))) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "SHA-256 abc");
  ok(hex(J.sha256(new Uint8Array(0))) === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "SHA-256 空");
  const key = Buffer.from("feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308", "hex");
  const iv = Buffer.from("cafebabefacedbaddecaf888", "hex");
  const pt = Buffer.from("d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39", "hex");
  const aad = Buffer.from("feedfacedeadbeeffeedfacedeadbeefabaddad2", "hex");
  const ct = J.gcmEncrypt(key, iv, pt, aad);
  ok(hex(ct) === "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662" + "76fc6ece0f4e1768cddf8853bb2d551b", "AES-256-GCM NIST テストケース16");
  ok(hex(J.gcmDecrypt(key, iv, ct, aad)) === hex(pt), "AES-256-GCM 復号");

  // 乱数で Web Crypto と照合
  let n = 0;
  for (const len of [0, 1, 15, 16, 17, 31, 32, 33, 100, 1000, 4097]) {
    for (const alen of [0, 5, 16, 40]) {
      const k = rnd(32), v = rnd(12), p = rnd(len), a = rnd(alen);
      const ck = await subtle.importKey("raw", k, "AES-GCM", false, ["encrypt", "decrypt"]);
      const ref = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: v, additionalData: a }, ck, p));
      const mine = J.gcmEncrypt(k, v, p, a);
      ok(hex(ref) === hex(mine), `GCM 暗号 len=${len} aad=${alen}`);
      ok(hex(J.gcmDecrypt(k, v, ref, a)) === hex(p), `GCM 復号 len=${len} aad=${alen}`);
      const bad = ref.slice(); if (bad.length) bad[0] ^= 1; else bad[0] = 1;
      let threw = false; try { J.gcmDecrypt(k, v, bad, a); } catch (e) { threw = true; }
      ok(threw, `改変を検出 len=${len}`);
      n++;
    }
    const m = rnd(len);
    ok(hex(J.sha256(m)) === hex(new Uint8Array(await subtle.digest("SHA-256", m))), `SHA-256 len=${len}`);
    const hk = rnd(len % 80 + 1);
    const hkey = await subtle.importKey("raw", hk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    ok(hex(J.hmac(hk, m)) === hex(new Uint8Array(await subtle.sign("HMAC", hkey, m))), `HMAC len=${len}`);
  }
  for (const it of [1, 2, 3, 1000, 70000]) {
    const pw = new TextEncoder().encode("パスワード" + it), salt = rnd(16);
    const base = await subtle.importKey("raw", pw, "PBKDF2", false, ["deriveBits"]);
    const ref = new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", salt, iterations: it, hash: "SHA-256" }, base, 256));
    ok(hex(await J.pbkdf2(pw, salt, it)) === hex(ref), `PBKDF2 iter=${it}`);
  }
  const t = Date.now();
  await J.pbkdf2(new TextEncoder().encode("x"), rnd(16), 600000);
  console.log(`  PBKDF2 60万回: ${Date.now() - t} ms（ログイン1回あたりの時間の目安）`);
  console.log(fail ? `失敗 ${fail} 件` : `暗号テスト すべて成功（GCM ${n}通り＋SHA/HMAC/PBKDF2）`);
  process.exit(fail ? 1 : 0);
})();
