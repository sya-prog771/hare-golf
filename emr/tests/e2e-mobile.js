/* スマホ版の通しテスト（iPhone 相当の画面・タッチで操作。オフライン起動も確認）
 *   実行: node emr/tests/e2e-mobile.js [スクリーンショット保存先]
 */
const { chromium, devices } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SHOTS = process.argv[2] || null;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".webmanifest": "application/manifest+json" };
let failures = 0;
const check = (c, m) => { if (c) console.log("  ✓ " + m); else { failures++; console.log("  ✗ " + m); } };

function serve() {
  return new Promise(res => {
    const srv = http.createServer((req, rsp) => {
      const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html"));
      if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { rsp.writeHead(404); return rsp.end(); }
      rsp.writeHead(200, { "content-type": TYPES[path.extname(p)] || "application/octet-stream" });
      fs.createReadStream(p).pipe(rsp);
    }).listen(0, "127.0.0.1", () => res(srv));
  });
}

(async () => {
  const srv = await serve();
  const url = `http://localhost:${srv.address().port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !/status of 404|ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(m.text())) errors.push(m.text()); });
  const shot = async n => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "m-" + n + ".png") }); };
  const noOverflow = async where => check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), `${where}: 横にはみ出さない`);
  const modalBtn = label => page.locator(".modal-foot button", { hasText: label });

  console.log("1. 初期設定（ホーム画面に追加の案内）");
  await page.goto(url);
  await page.waitForSelector("h1:has-text('初期設定')");
  check(await page.locator(".install-banner:has-text('共有ボタン')").count() === 1, "iPhone では「共有 → ホーム画面に追加」の案内を表示");
  check(await page.locator(".install-banner:has-text('先に追加してから')").count() === 1, "Safari とアプリでデータが別になる注意を表示");
  await shot("01-setup");
  await page.fill("input[autocomplete=organization]", "スマホ医院");
  await page.fill("input[autocomplete=username]", "dr.m");
  await page.fill("input[autocomplete=name]", "医師 スマホ");
  await page.locator("input[type=password]").nth(0).fill("Mobile-pass-1");
  await page.locator("input[type=password]").nth(1).fill("Mobile-pass-1");
  await page.tap("button:has-text('はじめる')");
  await page.waitForSelector(".modal:has-text('デモ用の利用者')", { timeout: 60000 });
  await modalBtn("確認しました").tap();
  await page.waitForSelector(".board");

  console.log("2. 画面のつくり");
  check(await page.locator(".tabbar").isVisible() && !(await page.locator(".nav").isVisible()), "下にタブバー、横のメニューは隠れる");
  const fs16 = await page.evaluate(() => getComputedStyle(document.querySelector(".input, input")).fontSize);
  await page.tap(".tabbar a:has-text('患者')");
  await page.waitForSelector(".searchbar input");
  const searchFs = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".searchbar input")).fontSize));
  check(searchFs >= 16, `入力欄の文字が16px以上（iPhoneで勝手に拡大しない）: ${searchFs}px ${fs16}`);
  check(await page.locator(".pt-list thead").isHidden(), "患者一覧はカード表示");
  await noOverflow("患者一覧");
  await shot("02-patients");
  await page.tap(".tabbar a:has-text('受付')");
  await page.waitForSelector(".lane-switch");
  check(await page.locator(".lane-waiting").isVisible() && await page.locator(".lane-done").isHidden(), "受付は「診察待ち」だけを表示");
  await page.tap(".lane-switch button:has-text('完了')");
  check(await page.locator(".lane-done").isVisible() && await page.locator(".lane-waiting").isHidden(), "状態を押すと切りかわる");
  await page.tap(".lane-switch button:has-text('診察待ち')");
  await noOverflow("受付");
  await shot("03-reception");

  console.log("3. スマホで診察・記載・処方");
  await page.locator(".enc-card", { hasText: "鈴木" }).locator("button", { hasText: "カルテ" }).tap();
  await page.waitForSelector(".pane-switch");
  check(await page.locator(".editor-col").isVisible() && await page.locator(".history-col").isHidden(), "カルテは「記載する」側だけを表示");
  await page.tap("button:has-text('記載を始める')");
  await page.waitForSelector(".editor-col textarea");
  await page.locator(".vfield", { hasText: "体温" }).locator("input").fill("36.8");
  check(await page.locator(".vfield", { hasText: "体温" }).locator("input").getAttribute("inputmode") === "decimal", "バイタルは数字キーボード");
  await page.locator(".editor-col textarea").nth(0).fill("スマホから記載。腰痛は改善傾向。");
  await page.tap("button:has-text('前回Do')");
  check(await page.locator(".rx-item").count() === 2, "前回Do処方");
  const footVisible = await page.evaluate(() => { const r = document.querySelector(".editor-foot").getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; });
  check(footVisible, "「確定する」ボタンが画面内に常に見えている");
  await noOverflow("記載画面");
  await shot("04-editor");
  await page.tap("button:has-text('確定する')");
  await page.waitForSelector(".modal:has-text('確定しました')");
  const full = await page.evaluate(() => { const r = document.querySelector(".modal").getBoundingClientRect(); return Math.round(r.width) === window.innerWidth && Math.round(r.height) >= window.innerHeight - 1; });
  check(full, "ダイアログは全画面");
  await shot("05-modal");
  await modalBtn("あとで").tap();
  await page.tap(".pane-switch button:has-text('過去の記載')");
  check(await page.locator(".history-col .note-card:has-text('スマホから記載')").isVisible(), "「過去の記載」に切りかえると確定した記載が見える");
  await shot("06-history");
  await page.tap(".tabs a:has-text('経過グラフ')");
  await page.waitForSelector(".chart svg");
  await noOverflow("経過グラフ");
  await page.tap(".tabs a:has-text('検査')");
  await noOverflow("検査（表は枠の中で横スクロール）");

  console.log("4. メニューとロック");
  await page.tap(".tabbar button:has-text('メニュー')");
  await page.waitForSelector(".modal.sheet");
  check(await page.locator(".sheet-item:has-text('管理')").count() === 1, "メニューに管理・監査ログ・ロックなど");
  await shot("07-menu");
  await page.locator(".sheet-item", { hasText: "ロック" }).tap();
  await page.waitForSelector("input[autocomplete=current-password]");
  check(true, "ロックでログイン画面へ");

  console.log("5. 電波がなくても起動・ログインできる");
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => { });
  if (!(await page.evaluate(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller)))) { await page.reload(); await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 }); }
  check(await page.evaluate(() => !!navigator.serviceWorker.controller), "オフライン用の保存（service worker）が有効");
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector("input[autocomplete=current-password]", { timeout: 15000 });
  await page.fill("input[autocomplete=username]", "dr.m");
  await page.fill("input[autocomplete=current-password]", "Mobile-pass-1");
  await page.tap("button:has-text('ログイン')");
  await page.waitForSelector(".board", { timeout: 30000 });
  check(await page.locator(".enc-card").count() >= 3, "機内モードのまま再起動しても、ログインしてカルテが使える");
  await page.goto(url + "guide.html").catch(() => { });
  check(await page.locator("h1:has-text('接続ガイド')").count() === 1, "接続ガイドもオフラインで開ける");
  await ctx.setOffline(false);

  const real = errors.filter(e => !/favicon/.test(e));
  check(real.length === 0, "JavaScript エラーなし" + (real.length ? ": " + real.join(" | ") : ""));
  await browser.close();
  srv.close();
  console.log(failures ? `\n失敗 ${failures} 件` : "\nすべて成功");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
