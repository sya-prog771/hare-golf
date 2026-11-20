/* 純 JavaScript の暗号実装（SHA-256 / HMAC / PBKDF2 / AES-256-GCM）
 *
 * なぜ必要か: ブラウザの Web Crypto（crypto.subtle）は https か localhost でしか使えない。
 * 院内LANで http://192.168.x.x を開いた子機でも同じ暗号化を行うため、標準どおりの実装を持つ。
 * 出力は Web Crypto と完全に同じ（tests/crypto-test.js で照合）。
 */
(function (g) {
  "use strict";

  // ---------------- SHA-256 ----------------
  const K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  const IV0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const W = new Int32Array(64);

  /** state(8語) に 16語のブロック w を圧縮して上書き */
  function compress(st, w) {
    for (let i = 0; i < 16; i++) W[i] = w[i];
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = st[0], b = st[1], c = st[2], d = st[3], e = st[4], f = st[5], g2 = st[6], h = st[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g2);
      const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) | 0;
      h = g2; g2 = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    st[0] = (st[0] + a) | 0; st[1] = (st[1] + b) | 0; st[2] = (st[2] + c) | 0; st[3] = (st[3] + d) | 0;
    st[4] = (st[4] + e) | 0; st[5] = (st[5] + f) | 0; st[6] = (st[6] + g2) | 0; st[7] = (st[7] + h) | 0;
  }

  function sha256(bytes) {
    const st = new Int32Array(IV0);
    const n = bytes.length;
    const total = ((n + 9 + 63) >> 6) << 6;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[n] = 0x80;
    const bits = n * 8;
    buf[total - 4] = (bits >>> 24) & 255; buf[total - 3] = (bits >>> 16) & 255; buf[total - 2] = (bits >>> 8) & 255; buf[total - 1] = bits & 255;
    buf[total - 5] = Math.floor(bits / 0x100000000) & 255;
    const w = new Int32Array(16);
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) { const j = off + i * 4; w[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3]; }
      compress(st, w);
    }
    return wordsToBytes(st);
  }
  function wordsToBytes(st) {
    const out = new Uint8Array(st.length * 4);
    for (let i = 0; i < st.length; i++) { out[i * 4] = st[i] >>> 24; out[i * 4 + 1] = st[i] >>> 16; out[i * 4 + 2] = st[i] >>> 8; out[i * 4 + 3] = st[i]; }
    return out;
  }

  function hmac(key, msg) {
    if (key.length > 64) key = sha256(key);
    const ip = new Uint8Array(64 + msg.length), op = new Uint8Array(64 + 32);
    for (let i = 0; i < 64; i++) { const k = key[i] || 0; ip[i] = k ^ 0x36; op[i] = k ^ 0x5c; }
    ip.set(msg, 64);
    op.set(sha256(ip), 64);
    return sha256(op);
  }

  /** PBKDF2-HMAC-SHA256。1ブロック(32バイト)分。重いので await で区切って画面を固めない */
  async function pbkdf2(pw, salt, iter, onProgress) {
    let key = pw.length > 64 ? sha256(pw) : pw;
    const blockOf = pad => {
      const b = new Uint8Array(64);
      for (let i = 0; i < 64; i++) b[i] = (key[i] || 0) ^ pad;
      const w = new Int32Array(16);
      for (let i = 0; i < 16; i++) w[i] = (b[i * 4] << 24) | (b[i * 4 + 1] << 16) | (b[i * 4 + 2] << 8) | b[i * 4 + 3];
      const st = new Int32Array(IV0); compress(st, w); return st;
    };
    const istate = blockOf(0x36), ostate = blockOf(0x5c);
    const msg = new Uint8Array(salt.length + 4);
    msg.set(salt); msg[salt.length + 3] = 1;
    let u = hmac(key, msg);
    const T = new Int32Array(8), U = new Int32Array(8);
    for (let i = 0; i < 8; i++) U[i] = T[i] = (u[i * 4] << 24) | (u[i * 4 + 1] << 16) | (u[i * 4 + 2] << 8) | u[i * 4 + 3];
    // 2回目以降: 32バイトの入力は常に「1ブロック＋固定パディング」なので、状態を直接回す
    const w = new Int32Array(16);
    w[8] = 0x80000000 | 0; w[15] = (64 + 32) * 8;
    const st = new Int32Array(8);
    for (let n = 1; n < iter; n++) {
      for (let i = 0; i < 8; i++) { w[i] = U[i]; st[i] = istate[i]; }
      for (let i = 9; i < 15; i++) w[i] = 0;
      compress(st, w);
      for (let i = 0; i < 8; i++) { w[i] = st[i]; st[i] = ostate[i]; }
      compress(st, w);
      for (let i = 0; i < 8; i++) { U[i] = st[i]; T[i] ^= st[i]; }
      if ((n & 0x7fff) === 0) { if (onProgress) onProgress(n / iter); await new Promise(r => setTimeout(r, 0)); }
    }
    return wordsToBytes(T);
  }

  // ---------------- AES-256 ----------------
  const SBOX = new Uint8Array(256), T0 = new Uint32Array(256), T1 = new Uint32Array(256), T2 = new Uint32Array(256), T3 = new Uint32Array(256);
  (function init() {
    const mul = (a, b) => { let p = 0; for (let i = 0; i < 8; i++) { if (b & 1) p ^= a; const hi = a & 0x80; a = (a << 1) & 255; if (hi) a ^= 0x1b; b >>= 1; } return p; };
    const inv = a => { if (!a) return 0; let r = 1; for (let i = 0; i < 254; i++) r = mul(r, a); return r; };
    for (let i = 0; i < 256; i++) {
      const b = inv(i);
      let s = b;
      for (let k = 1; k <= 4; k++) s ^= ((b << k) | (b >> (8 - k))) & 255;
      SBOX[i] = s ^ 0x63;
    }
    for (let i = 0; i < 256; i++) {
      const s = SBOX[i], s2 = mul(s, 2), s3 = mul(s, 3);
      T0[i] = ((s2 << 24) | (s << 16) | (s << 8) | s3) >>> 0;
      T1[i] = ((s3 << 24) | (s2 << 16) | (s << 8) | s) >>> 0;
      T2[i] = ((s << 24) | (s3 << 16) | (s2 << 8) | s) >>> 0;
      T3[i] = ((s << 24) | (s << 16) | (s3 << 8) | s2) >>> 0;
    }
  })();

  function expandKey(key) {
    if (key.length !== 32) throw new Error("AES-256 の鍵は32バイトです");
    const Nk = 8, Nr = 14, w = new Uint32Array(4 * (Nr + 1));
    for (let i = 0; i < Nk; i++) w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
    let rcon = 1;
    for (let i = Nk; i < w.length; i++) {
      let t = w[i - 1];
      if (i % Nk === 0) {
        t = ((t << 8) | (t >>> 24)) >>> 0;
        t = ((SBOX[t >>> 24] << 24) | (SBOX[(t >>> 16) & 255] << 16) | (SBOX[(t >>> 8) & 255] << 8) | SBOX[t & 255]) >>> 0;
        t = (t ^ (rcon << 24)) >>> 0;
        rcon = (rcon << 1) ^ ((rcon >> 7) * 0x11b);
      } else if (i % Nk === 4) {
        t = ((SBOX[t >>> 24] << 24) | (SBOX[(t >>> 16) & 255] << 16) | (SBOX[(t >>> 8) & 255] << 8) | SBOX[t & 255]) >>> 0;
      }
      w[i] = (w[i - Nk] ^ t) >>> 0;
    }
    return w;
  }

  /** 16バイトブロックを暗号化（in: 4語 → out: 4語） */
  function encBlock(w, s0, s1, s2, s3, out) {
    s0 ^= w[0]; s1 ^= w[1]; s2 ^= w[2]; s3 ^= w[3];
    let k = 4;
    for (let r = 1; r < 14; r++) {
      const t0 = T0[s0 >>> 24] ^ T1[(s1 >>> 16) & 255] ^ T2[(s2 >>> 8) & 255] ^ T3[s3 & 255] ^ w[k];
      const t1 = T0[s1 >>> 24] ^ T1[(s2 >>> 16) & 255] ^ T2[(s3 >>> 8) & 255] ^ T3[s0 & 255] ^ w[k + 1];
      const t2 = T0[s2 >>> 24] ^ T1[(s3 >>> 16) & 255] ^ T2[(s0 >>> 8) & 255] ^ T3[s1 & 255] ^ w[k + 2];
      const t3 = T0[s3 >>> 24] ^ T1[(s0 >>> 16) & 255] ^ T2[(s1 >>> 8) & 255] ^ T3[s2 & 255] ^ w[k + 3];
      s0 = t0 >>> 0; s1 = t1 >>> 0; s2 = t2 >>> 0; s3 = t3 >>> 0; k += 4;
    }
    out[0] = ((SBOX[s0 >>> 24] << 24) | (SBOX[(s1 >>> 16) & 255] << 16) | (SBOX[(s2 >>> 8) & 255] << 8) | SBOX[s3 & 255]) ^ w[k];
    out[1] = ((SBOX[s1 >>> 24] << 24) | (SBOX[(s2 >>> 16) & 255] << 16) | (SBOX[(s3 >>> 8) & 255] << 8) | SBOX[s0 & 255]) ^ w[k + 1];
    out[2] = ((SBOX[s2 >>> 24] << 24) | (SBOX[(s3 >>> 16) & 255] << 16) | (SBOX[(s0 >>> 8) & 255] << 8) | SBOX[s1 & 255]) ^ w[k + 2];
    out[3] = ((SBOX[s3 >>> 24] << 24) | (SBOX[(s0 >>> 16) & 255] << 16) | (SBOX[(s1 >>> 8) & 255] << 8) | SBOX[s2 & 255]) ^ w[k + 3];
  }

  // ---------------- GCM ----------------
  function gmul(x, h) { // x,h: 4語。x ← x·h
    let z0 = 0, z1 = 0, z2 = 0, z3 = 0, v0 = h[0], v1 = h[1], v2 = h[2], v3 = h[3];
    for (let i = 0; i < 128; i++) {
      if ((x[i >>> 5] >>> (31 - (i & 31))) & 1) { z0 ^= v0; z1 ^= v1; z2 ^= v2; z3 ^= v3; }
      const lsb = v3 & 1;
      v3 = (v3 >>> 1) | (v2 << 31); v2 = (v2 >>> 1) | (v1 << 31); v1 = (v1 >>> 1) | (v0 << 31); v0 = v0 >>> 1;
      if (lsb) v0 ^= 0xe1000000;
    }
    x[0] = z0 >>> 0; x[1] = z1 >>> 0; x[2] = z2 >>> 0; x[3] = z3 >>> 0;
  }
  function ghashBytes(y, h, data) {
    for (let off = 0; off < data.length; off += 16) {
      const b = new Uint8Array(16);
      b.set(data.subarray(off, Math.min(off + 16, data.length)));
      for (let i = 0; i < 4; i++) y[i] ^= ((b[i * 4] << 24) | (b[i * 4 + 1] << 16) | (b[i * 4 + 2] << 8) | b[i * 4 + 3]) >>> 0;
      gmul(y, h);
    }
  }
  function gcm(key, iv, input, aad, decrypt) {
    if (iv.length !== 12) throw new Error("IV は12バイトです");
    const w = expandKey(key), o = new Uint32Array(4);
    encBlock(w, 0, 0, 0, 0, o);
    const H = Uint32Array.from(o);
    const j0 = [((iv[0] << 24) | (iv[1] << 16) | (iv[2] << 8) | iv[3]) >>> 0, ((iv[4] << 24) | (iv[5] << 16) | (iv[6] << 8) | iv[7]) >>> 0, ((iv[8] << 24) | (iv[9] << 16) | (iv[10] << 8) | iv[11]) >>> 0];
    let data = input, tagIn = null;
    if (decrypt) {
      if (input.length < 16) throw new Error("復号に失敗しました");
      data = input.subarray(0, input.length - 16); tagIn = input.subarray(input.length - 16);
    }
    const out = new Uint8Array(data.length);
    let ctr = 1;
    for (let off = 0; off < data.length; off += 16) {
      ctr = (ctr + 1) >>> 0;
      encBlock(w, j0[0], j0[1], j0[2], ctr, o);
      for (let i = 0; i < 16 && off + i < data.length; i++) out[off + i] = data[off + i] ^ ((o[i >> 2] >>> (24 - 8 * (i & 3))) & 255);
    }
    const ct = decrypt ? data : out;
    const y = new Uint32Array(4);
    ghashBytes(y, H, aad);
    ghashBytes(y, H, ct);
    const ab = aad.length * 8, cb = ct.length * 8;
    y[0] ^= Math.floor(ab / 0x100000000); y[1] ^= ab >>> 0; y[2] ^= Math.floor(cb / 0x100000000); y[3] ^= cb >>> 0;
    gmul(y, H);
    encBlock(w, j0[0], j0[1], j0[2], 1, o);
    const tag = new Uint8Array(16);
    for (let i = 0; i < 16; i++) tag[i] = ((y[i >> 2] ^ o[i >> 2]) >>> (24 - 8 * (i & 3))) & 255;
    if (decrypt) {
      let diff = 0;
      for (let i = 0; i < 16; i++) diff |= tag[i] ^ tagIn[i];
      if (diff) throw new Error("復号に失敗しました（鍵が違うか、データが改変されています）");
      return out;
    }
    const res = new Uint8Array(out.length + 16);
    res.set(out); res.set(tag, out.length);
    return res;
  }

  g.EMRJsCrypto = {
    sha256, hmac, pbkdf2,
    gcmEncrypt: (key, iv, pt, aad) => gcm(key, iv, pt, aad || new Uint8Array(0), false),
    gcmDecrypt: (key, iv, ct, aad) => gcm(key, iv, ct, aad || new Uint8Array(0), true)
  };
})(typeof window !== "undefined" ? window : globalThis);
