#!/usr/bin/env node
/* 電子カルテ 院内サーバー（親機）
 *
 *  - Node.js だけで動く（追加のインストール不要）。インターネットは使わない。
 *  - カルテのデータは子機（ブラウザ）側で暗号化されたまま届くので、このサーバーは中身を読めない。
 *  - 書き込み・読み出しは、データ鍵から作った「サーバー認証鍵」での署名がないと受け付けない。
 *  - 院内（プライベートIPアドレス）からの接続だけを受け付ける。
 *  - データは data/ フォルダに保存し、毎日自動でバックアップを作る（30日分）。
 *
 *  起動: node server/server.js   （ポート変更: EMR_PORT=8081、保存先変更: EMR_DATA_DIR=...）
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");

const VERSION = "1.1.0";
const APP_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.resolve(process.env.EMR_DATA_DIR || path.join(__dirname, "data"));
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const SNAP = path.join(DATA_DIR, "snapshot.json");
const JOURNAL = path.join(DATA_DIR, "journal.jsonl");
const AUTH = path.join(DATA_DIR, "auth.json");
const CONF = path.join(DATA_DIR, "server.json");
const STORES = ["users", "records", "meta"];
const KEEP_BACKUPS = 30;
const MAX_BODY = 300 * 1024 * 1024;

// ------------------------------------------------------------------ 保存
const db = { users: new Map(), records: new Map(), meta: new Map() }; // key -> { v, r }
let seq = 0;
let auth = null; // { key: Buffer }
let journalFd = null;
let conf = {};

const keyOf = (store, v) => (store === "meta" ? v.key : v.id);

function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return dflt; } }
function writeJsonAtomic(p, obj) {
  const tmp = p + ".tmp";
  const fd = fs.openSync(tmp, "w");
  fs.writeSync(fd, JSON.stringify(obj));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, p);
}

function load() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  conf = readJson(CONF, {});
  const a = readJson(AUTH, null);
  if (a && a.key) auth = { key: Buffer.from(a.key, "base64") };
  const snap = readJson(SNAP, null);
  if (snap) {
    seq = snap.seq || 0;
    for (const s of STORES) for (const [r, v] of snap.stores[s] || []) db[s].set(keyOf(s, v), { v, r });
  }
  if (fs.existsSync(JOURNAL)) {
    const lines = fs.readFileSync(JOURNAL, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let tx;
      try { tx = JSON.parse(line); } catch (e) { console.warn("  （途中で切れた記録を1件無視しました。停電などで最後の書き込みが中断した可能性があります）"); break; }
      if (tx.seq <= seq) continue;
      applyTx(tx);
    }
  }
  compact();
}

function applyTx(tx) {
  seq = tx.seq;
  for (const it of tx.items) db[it.s].set(keyOf(it.s, it.v), { v: it.v, r: tx.seq });
}

function commit(items) {
  const tx = { seq: seq + 1, at: new Date().toISOString(), items };
  const line = JSON.stringify(tx) + "\n";
  fs.writeSync(journalFd, line);
  fs.fsyncSync(journalFd); // 停電でも消えないよう、ディスクに書き終えてから返事をする
  applyTx(tx);
  if (fs.fstatSync(journalFd).size > 32 * 1024 * 1024) compact();
  broadcast({ seq });
  return seq;
}

function compact() {
  const stores = {};
  for (const s of STORES) stores[s] = Array.from(db[s].values(), x => [x.r, x.v]);
  writeJsonAtomic(SNAP, { seq, savedAt: new Date().toISOString(), stores });
  if (journalFd !== null) fs.closeSync(journalFd);
  journalFd = fs.openSync(JOURNAL, "w");
}

function replaceAll(dump) {
  for (const s of STORES) {
    db[s].clear();
    for (const v of dump[s] || []) db[s].set(keyOf(s, v), { v, r: seq + 1 });
  }
  seq += 1;
  compact();
}

function dump() {
  const out = { format: "emr-local-backup", version: 1, exportedAt: new Date().toISOString(), source: "server" };
  for (const s of STORES) out[s] = Array.from(db[s].values(), x => x.v);
  return out;
}

// ------------------------------------------------------------------ 自動バックアップ
function dailyBackup() {
  if (!auth || !db.users.size) return;
  const d = new Date();
  const name = `emr-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.json`;
  const p = path.join(BACKUP_DIR, name);
  if (fs.existsSync(p)) return;
  writeJsonAtomic(p, dump());
  const files = fs.readdirSync(BACKUP_DIR).filter(f => /^emr-backup-.*\.json$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(BACKUP_DIR, f));
  log(`自動バックアップを作成しました: ${name}`);
}
function backupInfo() {
  const files = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter(f => /^emr-backup-.*\.json$/.test(f)).sort() : [];
  return { count: files.length, last: files[files.length - 1] || null, dir: BACKUP_DIR };
}

// ------------------------------------------------------------------ ネットワーク
function isPrivate(ip) {
  ip = String(ip || "").replace(/^::ffff:/, "");
  if (ip === "::1" || ip.startsWith("127.")) return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^169\.254\./.test(ip)) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip)) return true;
  return false;
}
const VIRTUAL = /vethernet|virtualbox|vmware|vbox|docker|wsl|hyper-v|loopback|utun|bridge|tailscale|zerotier|vpn|tun\d|tap\d|awdl|llw/i;
function addresses(port) {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      if (a.internal) continue;
      let score = 0;
      if (/^192\.168\./.test(a.address)) score = 3;
      else if (/^10\./.test(a.address) || /^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) score = 2;
      else if (/^169\.254\./.test(a.address)) score = -2; // ルーターから番号をもらえていない
      if (VIRTUAL.test(name)) score -= 5;
      if (/wi-?fi|wlan|en0|ワイヤレス|イーサネット|ethernet|eth0|en1/i.test(name)) score += 1;
      out.push({ ip: a.address, name, url: `http://${a.address}:${port}`, score });
    }
  }
  out.sort((a, b) => b.score - a.score);
  if (out[0]) out[0].recommended = true;
  return out;
}
function hostnameLocal(port) {
  const h = os.hostname().replace(/\.local$/i, "");
  if (!/^[A-Za-z0-9-]+$/.test(h)) return null;
  return `http://${h}.local:${port}`;
}

// ------------------------------------------------------------------ 接続中の端末
const clients = new Map(); // cid -> { ip, label, user, ua, lastSeen, connected }
const streams = new Set();
function touchClient(req, extra) {
  const u = new URL(req.url, "http://x");
  const cid = (u.searchParams.get("cid") || req.headers["x-emr-client"] || "").slice(0, 40);
  if (!cid) return null;
  const c = clients.get(cid) || { firstSeen: Date.now() };
  c.ip = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  c.ua = deviceName(req.headers["user-agent"] || "");
  c.lastSeen = Date.now();
  if (u.searchParams.get("user")) c.user = u.searchParams.get("user").slice(0, 40);
  Object.assign(c, extra || {});
  clients.set(cid, c);
  return c;
}
function deviceName(ua) {
  const os_ = /iPad/.test(ua) ? "iPad" : /iPhone/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "不明な端末";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "ブラウザ";
  return `${os_}・${br}`;
}
function broadcast(msg, event) {
  const data = (event ? `event: ${event}\n` : "") + `data: ${JSON.stringify(msg)}\n\n`;
  for (const s of streams) { try { s.write(data); } catch (e) { /* 切断済み */ } }
}
setInterval(() => broadcast({ seq, ping: Date.now() }), 25000).unref();

// ------------------------------------------------------------------ 認証（HMAC署名）
const usedNonces = new Map();
function verifyAuth(req, body) {
  if (!auth) return "まだ初期設定されていません";
  const h = String(req.headers["x-emr-auth"] || "");
  const [ts, nonce, mac] = h.split(".");
  if (!ts || !nonce || !mac) return "署名がありません";
  if (Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) return "時刻のずれが大きすぎます（端末の時計を確認してください）";
  if (usedNonces.has(nonce)) return "同じ要求が繰り返されました";
  const bodyHash = crypto.createHash("sha256").update(body || "").digest("hex");
  const expect = crypto.createHmac("sha256", auth.key).update(`${req.method}\n${req.url}\n${ts}\n${nonce}\n${bodyHash}`).digest();
  const got = Buffer.from(mac, "hex");
  if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return "署名が正しくありません";
  usedNonces.set(nonce, Date.now());
  if (usedNonces.size > 5000) { const lim = Date.now() - 11 * 60 * 1000; for (const [k, t] of usedNonces) if (t < lim) usedNonces.delete(k); }
  return null;
}

// ------------------------------------------------------------------ HTTP
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".md": "text/plain; charset=utf-8" };
const STATIC_OK = /^\/(index\.html|guide\.html|styles\.css|guide\.css|README\.md|js\/[\w.-]+\.js|vendor\/[\w.-]+\.js)$/;

function send(res, code, obj, headers) {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj);
  res.writeHead(code, Object.assign({ "content-type": typeof obj === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", "cache-control": "no-store" }, headers || {}));
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", c => { n += c.length; if (n > MAX_BODY) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const loginFails = new Map(); // ip -> [時刻]
async function handle(req, res) {
  const ip = req.socket.remoteAddress;
  if (!isPrivate(ip)) return send(res, 403, "院内ネットワーク以外からの接続は受け付けません。");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "SAMEORIGIN");
  res.setHeader("referrer-policy", "no-referrer");
  const u = new URL(req.url, "http://x");
  const p = u.pathname;

  if (!p.startsWith("/api/")) {
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method Not Allowed");
    const rel = p === "/" ? "/index.html" : p;
    if (!STATIC_OK.test(rel)) return send(res, 404, "見つかりません");
    const file = path.join(APP_DIR, rel);
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, "見つかりません");
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
      res.end(req.method === "HEAD" ? undefined : data);
    });
    return;
  }

  // ---- 認証なしで使えるAPI
  if (p === "/api/info" && req.method === "GET") return send(res, 200, { app: "emr", version: VERSION, time: Date.now(), initialized: !!auth, seq });
  if (p === "/api/status" && req.method === "GET") {
    const port = server.address().port;
    const now = Date.now();
    return send(res, 200, {
      app: "emr", version: VERSION, initialized: !!auth, port, hostname: os.hostname(), mdnsUrl: hostnameLocal(port),
      addresses: addresses(port), ipChanged: conf.ipChanged || null, uptimeSec: Math.round(process.uptime()),
      clients: Array.from(clients.values()).filter(c => now - c.lastSeen < 10 * 60 * 1000).map(c => ({ ip: c.ip, device: c.ua, user: c.user || "", connected: !!c.connected, lastSeen: c.lastSeen })),
      users: db.users.size, records: db.records.size, backups: backupInfo(), dataDir: DATA_DIR, os: process.platform, yourIp: String(ip).replace(/^::ffff:/, "")
    });
  }
  if (p === "/api/users" && req.method === "GET") return send(res, 200, Array.from(db.users.values(), x => x.v));
  if (p === "/api/events" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(`retry: 3000\ndata: ${JSON.stringify({ seq })}\n\n`);
    const c = touchClient(req, { connected: true });
    streams.add(res);
    req.on("close", () => { streams.delete(res); if (c) c.connected = false; });
    return;
  }
  if (p === "/api/login-failed" && req.method === "POST") {
    const body = JSON.parse(await readBody(req) || "{}");
    const list = (loginFails.get(ip) || []).filter(t => Date.now() - t < 10 * 60 * 1000);
    list.push(Date.now()); loginFails.set(ip, list);
    if (list.length > 30) return send(res, 429, { error: "ログインの失敗が多すぎます。しばらく待ってください" });
    const cur = db.users.get(body.id);
    if (!cur) return send(res, 200, { ok: true });
    const v = Object.assign({}, cur.v);
    v.failed = (v.failed || 0) + 1;
    if (v.failed >= 5) { v.lockedUntil = Date.now() + 5 * 60 * 1000; v.failed = 0; }
    commit([{ s: "users", v }]);
    return send(res, 200, { ok: true });
  }
  if (p === "/api/init" && req.method === "POST") {
    const body = JSON.parse(await readBody(req) || "{}");
    if (auth || db.users.size) return send(res, 409, { error: "このサーバーはすでに初期設定済みです" });
    const key = Buffer.from(String(body.authKey || ""), "base64");
    if (key.length !== 32) return send(res, 400, { error: "認証鍵が正しくありません" });
    auth = { key };
    writeJsonAtomic(AUTH, { key: key.toString("base64"), createdAt: new Date().toISOString() });
    log("初期設定を受け付けました。");
    return send(res, 200, { ok: true });
  }
  if (p === "/api/init-restore" && req.method === "POST") {
    const body = JSON.parse(await readBody(req) || "{}");
    if (auth || db.users.size) return send(res, 409, { error: "このサーバーはすでに初期設定済みです" });
    const key = Buffer.from(String(body.authKey || ""), "base64");
    if (key.length !== 32 || !body.dump || !Array.isArray(body.dump.records)) return send(res, 400, { error: "データが正しくありません" });
    replaceAll(body.dump);
    auth = { key };
    writeJsonAtomic(AUTH, { key: key.toString("base64"), createdAt: new Date().toISOString() });
    log(`バックアップから移行しました（${body.dump.records.length} 件）。`);
    return send(res, 200, { ok: true, seq });
  }

  // ---- ここから先は署名が必要
  const raw = req.method === "GET" ? "" : await readBody(req);
  const err = verifyAuth(req, raw);
  if (err) return send(res, 401, { error: err });
  touchClient(req);

  if (p === "/api/sync" && req.method === "GET") {
    const since = Number(u.searchParams.get("since") || 0);
    const items = [];
    for (const s of STORES) for (const x of db[s].values()) if (x.r > since) items.push({ s, v: x.v, r: x.r });
    return send(res, 200, { seq, items });
  }
  if (p === "/api/write" && req.method === "POST") {
    const body = JSON.parse(raw);
    const items = body.items || [];
    const conflicts = [];
    for (const it of items) {
      if (!STORES.includes(it.s) || !it.v || !keyOf(it.s, it.v)) return send(res, 400, { error: "不正なデータです" });
      const cur = db[it.s].get(keyOf(it.s, it.v));
      const curRev = cur ? cur.r : 0;
      if (it.base !== undefined && it.base !== curRev) conflicts.push(cur ? { s: it.s, v: cur.v, r: cur.r } : { s: it.s, k: keyOf(it.s, it.v), r: 0 });
    }
    if (conflicts.length) return send(res, 409, { error: "ほかの端末で先に更新されました", conflict: true, items: conflicts });
    const r = commit(items.map(it => ({ s: it.s, v: it.v })));
    return send(res, 200, { seq: r });
  }
  if (p === "/api/dump" && req.method === "GET") return send(res, 200, dump());
  if (p === "/api/restore" && req.method === "POST") {
    const body = JSON.parse(raw);
    if (!body.dump || !Array.isArray(body.dump.records)) return send(res, 400, { error: "データが正しくありません" });
    dailyBackupForce("before-restore");
    replaceAll(body.dump);
    broadcast({ seq }, "reset");
    log("バックアップから復元しました。各端末は再ログインになります。");
    return send(res, 200, { ok: true, seq });
  }
  return send(res, 404, { error: "not found" });
}
function dailyBackupForce(tag) {
  if (!db.users.size) return;
  const name = `emr-backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${tag}.json`;
  writeJsonAtomic(path.join(BACKUP_DIR, name), dump());
}

function log(msg) { console.log(`  [${new Date().toLocaleTimeString("ja-JP")}] ${msg}`); }

// ------------------------------------------------------------------ 起動画面
function terminalQr(text) {
  try {
    const qrcode = require(path.join(APP_DIR, "vendor", "qrcode.js"));
    const qr = qrcode(0, "M"); qr.addData(text); qr.make();
    const invert = process.platform !== "darwin";
    const n = qr.getModuleCount(), q = 2, dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
    const lines = [];
    for (let r = -q; r < n + q; r += 2) {
      let s = "    ";
      for (let c = -q; c < n + q; c++) {
        const top = dark(r, c), bot = dark(r + 1, c);
        // Windows・Linux の黒い画面では明るい部分を文字で描く。Mac の「ターミナル」は白い画面なので暗い部分を描く
        const a = invert ? !top : top, b = invert ? !bot : bot;
        s += a && b ? "█" : a ? "▀" : b ? "▄" : " ";
      }
      lines.push(s);
    }
    return lines.join("\n");
  } catch (e) { return ""; }
}

function openBrowser(url) {
  if (process.env.EMR_NO_BROWSER) return;
  const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  execFile(cmd[0], cmd[1], () => { });
}

let server;
function listen(port, tries) {
  server = http.createServer((req, res) => {
    handle(req, res).catch(e => { console.error(e); try { send(res, 500, { error: "サーバー内部のエラー: " + e.message }); } catch (_) { /* 送信済み */ } });
  });
  server.on("error", e => {
    if (e.code === "EADDRINUSE" && tries > 0) { console.log(`  ポート ${port} は使用中のため、${port + 1} を試します…`); return listen(port + 1, tries - 1); }
    if (e.code === "EADDRINUSE") { console.log("\n  ⚠ 電子カルテのサーバーがすでに起動しているようです（同じパソコンで2つ同時には起動できません）。"); process.exit(1); }
    throw e;
  });
  server.listen(port, "0.0.0.0", () => banner(port));
}

function banner(port) {
  const addrs = addresses(port);
  const best = addrs.find(a => a.recommended);
  const prevIp = conf.lastIp;
  conf.ipChanged = prevIp && best && prevIp !== best.ip ? { from: prevIp, to: best.ip } : null;
  conf.lastIp = best ? best.ip : prevIp; conf.lastPort = port;
  writeJsonAtomic(CONF, conf);
  const L = "  " + "=".repeat(60);
  console.log("\n" + L);
  console.log("   電子カルテ 院内サーバー（親機）が起動しました   v" + VERSION);
  console.log(L);
  console.log("");
  console.log("   ★ この黒い画面は閉じないでください（閉じるとカルテが使えなくなります）");
  console.log("");
  console.log(`   このパソコンで使う  →  http://localhost:${port}`);
  if (best) {
    console.log(`   ほかの端末（子機）  →  ${best.url}`);
    console.log("     （子機のブラウザのアドレス欄にそのまま入力。iPad・スマホは下のQRコードをカメラで読み取る）");
    console.log("");
    console.log(terminalQr(best.url));
    const others = addrs.filter(a => !a.recommended && a.score > -2);
    if (others.length) console.log(`\n   つながらない場合はこちらも試す: ${others.map(a => a.url).join("  ")}`);
    if (best.score <= -2) console.log("\n   ⚠ ルーターから番号（IPアドレス）をもらえていません。Wi-Fi または LANケーブルの接続を確認してください。");
  } else {
    console.log("\n   ⚠ ネットワークにつながっていません。Wi-Fi または LANケーブルを確認してください。");
    console.log("     （このパソコンだけで使う場合はこのままで大丈夫です）");
  }
  if (conf.ipChanged) console.log(`\n   ⚠ 前回（${conf.ipChanged.from}）とアドレスが変わりました。子機のブックマーク・ホーム画面のアイコンを作り直してください。`);
  console.log("");
  console.log(`   詳しい接続方法・困ったとき: http://localhost:${port}/guide.html`);
  console.log(`   データの保存場所: ${DATA_DIR}`);
  console.log(`   終了するとき: この画面で Ctrl キーを押しながら C`);
  console.log(L + "\n");
  if (!auth) log("初期設定を待っています。ブラウザで初期設定をしてください。");
  openBrowser(`http://localhost:${port}/${auth ? "" : "guide.html"}`);
}

function shutdown() {
  console.log("\n  終了しています…");
  try { compact(); } catch (e) { console.error(e); }
  for (const s of streams) { try { s.end(); } catch (e) { /* noop */ } }
  console.log("  データを保存して終了しました。");
  process.exit(0);
}

if (require.main === module) {
  load();
  dailyBackup();
  setInterval(dailyBackup, 60 * 60 * 1000).unref();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  listen(Number(process.env.EMR_PORT || conf.lastPort || 8080), 10);
}

module.exports = { isPrivate, addresses };
