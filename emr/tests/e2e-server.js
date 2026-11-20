/* 院内サーバー版の通しテスト（親機1台＋子機1台を同時に動かす）
 *   実行: node emr/tests/e2e-server.js
 *   子機は http://clinic-pc:ポート で開く（＝院内LANの http://192.168.x.x と同じく「安全でない接続」扱いになり、
 *   ブラウザ内蔵の暗号機能が使えない状態。純JS暗号で動くことを確認する）
 */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 18000 + Math.floor(Math.random() * 1000);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "emr-srv-"));
const DATA2 = fs.mkdtempSync(path.join(os.tmpdir(), "emr-srv2-"));
const SERVER = path.join(__dirname, "..", "server", "server.js");
let failures = 0;
const check = (c, m) => { if (c) console.log("  ✓ " + m); else { failures++; console.log("  ✗ " + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startServer(dir, port) {
  const p = spawn(process.execPath, [SERVER], { env: Object.assign({}, process.env, { EMR_NO_BROWSER: "1", EMR_DATA_DIR: dir, EMR_PORT: String(port) }), stdio: ["ignore", "pipe", "pipe"] });
  p.out = "";
  p.stdout.on("data", d => { p.out += d; });
  p.stderr.on("data", d => { p.out += d; });
  return new Promise((res, rej) => {
    const t = setInterval(() => { if (p.out.includes("起動しました")) { clearInterval(t); res(p); } }, 50);
    setTimeout(() => { clearInterval(t); rej(new Error("サーバーが起動しない\n" + p.out)); }, 10000);
  });
}
const stop = p => new Promise(r => { p.on("exit", r); p.kill("SIGTERM"); });

(async () => {
  let srv = await startServer(DATA, PORT);
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP clinic-pc 127.0.0.1"] });
  const errors = [];
  const mk = async (name, w, hgt) => {
    const ctx = await browser.newContext({ viewport: { width: w || 1440, height: hgt || 900 }, acceptDownloads: true });
    const pg = await ctx.newPage();
    pg.on("pageerror", e => errors.push(`${name}: ${e.message}`));
    pg.on("console", m => { if (m.type() === "error" && !/Failed to load resource|ERR_CONNECTION_REFUSED|net::ERR/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
    await pg.addInitScript(() => { window.print = () => { }; });
    return pg;
  };
  const A = await mk("親機");
  const B = await mk("子機");
  const urlA = `http://localhost:${PORT}/`, urlB = `http://clinic-pc:${PORT}/`;
  const btn = (pg, label) => pg.locator(".modal-foot button", { hasText: label });

  console.log("1. 親機で初期設定");
  await A.goto(urlA);
  await A.waitForSelector("h1:has-text('院内サーバー')");
  check(true, "院内サーバー版の初期設定画面になる");
  await A.fill("input[autocomplete=organization]", "院内LANテスト医院");
  await A.fill("input[autocomplete=username]", "dr.a");
  await A.fill("input[autocomplete=name]", "医師 A");
  await A.locator("input[type=password]").nth(0).fill("Doctor-pass-1");
  await A.locator("input[type=password]").nth(1).fill("Doctor-pass-1");
  await A.click("button:has-text('はじめる')");
  await A.waitForSelector(".modal:has-text('デモ用の利用者')", { timeout: 60000 });
  const creds = await A.$$eval(".modal tbody tr", trs => trs.map(tr => Array.from(tr.querySelectorAll("td"), td => td.textContent)));
  await btn(A, "確認しました").click();
  await A.waitForSelector(".board");
  check(await A.locator(".conn.on").count() === 1, "親機のヘッダーに「院内サーバー接続中」");
  check(fs.existsSync(path.join(DATA, "journal.jsonl")) && !fs.readFileSync(path.join(DATA, "journal.jsonl"), "utf8").includes("山田"), "サーバーのファイルに患者名が平文で入っていない");

  console.log("2. 子機（安全でない接続＝純JS暗号）で看護師ログイン");
  await B.goto(urlB);
  check(await B.evaluate(() => !window.isSecureContext && !window.EMRCrypto.native), "子機はブラウザ内蔵の暗号が使えない状態で動いている");
  const nurse = creds.find(c => c[1] === "nurse1");
  await B.fill("input[autocomplete=username]", "nurse1");
  await B.fill("input[autocomplete=current-password]", nurse[2]);
  await B.click("button:has-text('ログイン')");
  await B.waitForSelector(".modal:has-text('パスワードを変更してください')", { timeout: 30000 });
  await B.locator(".modal input").nth(0).fill(nurse[2]);
  await B.locator(".modal input").nth(1).fill("Nurse-pass-9");
  await B.locator(".modal input").nth(2).fill("Nurse-pass-9");
  await btn(B, "変更する").click();
  await B.waitForSelector(".board");
  check(await B.locator(".lane-waiting .enc-card").count() === 3, "子機でも同じ受付一覧（3名）が見える");

  console.log("3. リアルタイム反映");
  await A.locator(".enc-card", { hasText: "佐藤" }).locator("button", { hasText: "呼び込み" }).click();
  await B.waitForSelector(".lane-exam .enc-card:has-text('佐藤')", { timeout: 8000 });
  check(true, "親機で「呼び込み」→ 子機の受付一覧が自動で更新");
  await B.goto(urlB + "#/patients?q=サトウ");
  await B.click("tr:has-text('佐藤 花子')");
  await B.click("button:has-text('記載を始める')");
  await B.locator(".vfield", { hasText: "体温" }).locator("input").fill("38.1");
  await B.locator(".editor-col textarea").nth(0).fill("子機から記載：咳が強い。");
  await A.goto(urlA + "#/patients?q=サトウ");
  await A.click("tr:has-text('佐藤 花子')");
  await A.waitForSelector(".history-col");
  await B.click("button:has-text('確定する')");
  await A.waitForSelector(".note-card:has-text('子機から記載')", { timeout: 8000 });
  check(true, "子機で確定した看護記録が、開いたままの親機のカルテに自動で表示");

  console.log("4. 同時編集の衝突検出");
  await A.click(".tabs a:has-text('患者情報')");
  await B.click(".tabs a:has-text('患者情報')");
  const memoB = B.locator(".field", { hasText: "メモ" }).locator("textarea");
  await memoB.fill("子機からのメモ"); // 子機は入力途中（フォーカスあり）
  await A.locator(".field", { hasText: "メモ" }).locator("textarea").fill("親機からのメモ");
  await A.click("button:has-text('変更を保存')");
  await A.waitForSelector(".toast:has-text('保存しました')");
  await B.waitForFunction(() => window.EMRStore.patients().find(x => x.kana === "サトウ ハナコ").memo === "親機からのメモ", null, { timeout: 8000 });
  await B.click("button:has-text('変更を保存')");
  await B.waitForSelector(".form-err:has-text('ほかの端末で')");
  const memoNow = await B.evaluate(() => window.EMRStore.patients().find(x => x.kana === "サトウ ハナコ").memo);
  check(memoNow === "親機からのメモ", "古い画面のまま保存しても上書きせず、知らせる");
  await B.click("button:has-text('最新の内容を読み込む')");
  check(await memoB.inputValue() === "親機からのメモ", "「最新の内容を読み込む」で親機の変更が表示");

  console.log("5. 2台同時の新患登録で患者番号が重ならない");
  const reg = async (pg, url, name, kana) => {
    await pg.goto(url + "#/new");
    await pg.locator(".field", { hasText: "氏名" }).first().locator("input").fill(name);
    await pg.locator(".field", { hasText: "カナ" }).first().locator("input").fill(kana);
    await pg.locator(".field", { hasText: "生年月日" }).first().locator("input").fill("1970-01-01");
    await pg.locator(".field", { hasText: "性別" }).first().locator("select").selectOption("F");
  };
  await reg(A, urlA, "同時 一子", "ドウジ イチコ");
  await reg(B, urlB, "同時 二子", "ドウジ ニコ");
  await Promise.all([A.click("button:has-text('登録する')"), B.click("button:has-text('登録する')")]);
  await Promise.all([A.waitForSelector(".modal:has-text('このまま受付')"), B.waitForSelector(".modal:has-text('このまま受付')")]);
  await btn(A, "キャンセル").click(); await btn(B, "キャンセル").click();
  await sleep(1500);
  const pids = await A.evaluate(() => window.EMRStore.patients().map(p => p.pid));
  check(new Set(pids).size === pids.length && pids.length === 6, `患者番号がすべて別（${pids.sort().join(",")}）`);

  console.log("6. 監査ログの鎖（2台で同時に記録しても切れない）");
  await A.goto(urlA + "#/audit");
  await A.click("button:has-text('改ざんチェック')");
  await A.waitForSelector(".verify .ok-text, .verify .notice");
  const vt = await A.locator(".verify").textContent();
  check(/改変は見つかりませんでした/.test(vt), "監査ログ正常: " + vt.trim().slice(0, 60));

  console.log("7. 認証のない要求は拒否");
  const r1 = await fetch(`http://localhost:${PORT}/api/sync?since=0`);
  const r2 = await fetch(`http://localhost:${PORT}/api/write`, { method: "POST", body: JSON.stringify({ items: [{ s: "records", v: { id: "x", type: "patient", iv: "", ct: "" } }] }) });
  const r3 = await fetch(`http://localhost:${PORT}/api/init`, { method: "POST", body: JSON.stringify({ authKey: Buffer.alloc(32).toString("base64") }) });
  check(r1.status === 401 && r2.status === 401 && r3.status === 409, "署名なしの読み出し・書き込み、再初期設定は拒否");
  const r4 = await fetch(`http://localhost:${PORT}/server/data/auth.json`);
  check(r4.status === 404, "サーバーのデータフォルダはブラウザから見えない");

  console.log("8. 親機が止まったとき・戻ったとき");
  await B.goto(urlB + "#/reception");
  await B.waitForSelector(".board");
  await stop(srv);
  await B.waitForSelector("#offline-bar", { timeout: 15000 });
  check(true, "子機に「サーバーにつながりません」を表示");
  srv = await startServer(DATA, PORT);
  await B.waitForSelector("#offline-bar", { state: "detached", timeout: 20000 });
  check(true, "親機が戻ると自動で再接続");
  check(fs.readdirSync(path.join(DATA, "backups")).some(f => /^emr-backup-\d{4}-\d\d-\d\d\.json$/.test(f)), "親機の起動時に自動バックアップを作成");
  await B.reload();
  await B.fill("input[autocomplete=username]", "nurse1");
  await B.fill("input[autocomplete=current-password]", "Nurse-pass-9");
  await B.click("button:has-text('ログイン')");
  await B.waitForSelector(".board", { timeout: 30000 });
  check(await B.locator(".enc-card").count() >= 3, "再起動後もデータが残っている");

  console.log("9. バックアップから別の親機へ移行");
  await A.reload();
  await A.fill("input[autocomplete=username]", "dr.a");
  await A.fill("input[autocomplete=current-password]", "Doctor-pass-1");
  await A.click("button:has-text('ログイン')");
  await A.waitForSelector(".board");
  await A.goto(urlA + "#/admin");
  await A.waitForSelector(".card:has-text('子機から開くアドレス')");
  check(true, "管理画面に院内ネットワークの状態を表示");
  const [dl] = await Promise.all([A.waitForEvent("download"), A.click("button:has-text('バックアップを書き出す')")]);
  const backupPath = await dl.path();
  const PORT2 = PORT + 1;
  const srv2 = await startServer(DATA2, PORT2);
  const C2 = await mk("新しい親機");
  await C2.goto(`http://localhost:${PORT2}/`);
  await C2.click("button:has-text('そのデータを引き継ぐ')");
  await C2.setInputFiles(".modal input[type=file]", backupPath);
  await C2.locator(".modal .field", { hasText: "ログインID" }).locator("input").fill("dr.a");
  await C2.locator(".modal .field", { hasText: "パスワード" }).locator("input").fill("Doctor-pass-1");
  await btn(C2, "引き継ぐ").click();
  await C2.waitForSelector(".board", { timeout: 30000 });
  const n2 = await C2.evaluate(() => window.EMRStore.patients().length);
  check(n2 === 6, `新しい親機に患者 ${n2} 名を引き継ぎ`);

  console.log("10. 案内ページ");
  const G = await mk("案内", 390, 844);
  await G.goto(`http://clinic-pc:${PORT}/guide.html`);
  await G.waitForSelector("#live-url");
  check((await G.locator("#live-url").textContent()).includes(`:${PORT}`), "案内ページに子機用のアドレスを表示");
  check(await G.locator("#live-qr svg").count() === 1, "案内ページにQRコード");
  check(await G.locator("#live-clients li").count() >= 1, "接続中の端末の一覧");
  check(!(await G.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), "スマホ幅で横スクロールなし");

  const real = errors.filter(e => !/favicon/.test(e));
  check(real.length === 0, "JavaScript エラーなし" + (real.length ? ": " + real.join(" | ") : ""));
  await browser.close();
  await stop(srv); await stop(srv2);
  console.log(failures ? `\n失敗 ${failures} 件` : "\nすべて成功");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
