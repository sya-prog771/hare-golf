/* 電子カルテの通しテスト（Playwright + Chromium）
 *   実行: node emr/tests/e2e.js [スクリーンショット保存先]
 *   必要: npm i playwright（Chromium 同梱）
 */
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SHOTS = process.argv[2] || null;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

function serve() {
  return new Promise(res => {
    const srv = http.createServer((req, rsp) => {
      const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html"));
      if (!p.startsWith(ROOT) || !fs.existsSync(p)) { rsp.writeHead(404); return rsp.end(); }
      rsp.writeHead(200, { "content-type": TYPES[path.extname(p)] || "application/octet-stream" });
      fs.createReadStream(p).pipe(rsp);
    }).listen(0, "127.0.0.1", () => res(srv));
  });
}

let failures = 0;
function check(cond, msg) { if (cond) console.log("  ✓ " + msg); else { failures++; console.log("  ✗ " + msg); } }

(async () => {
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/index.html`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  // 印刷ダイアログは止める
  await page.addInitScript(() => { window.print = () => { }; HTMLIFrameElement.prototype.__p = 1; });
  const shot = async name => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + ".png"), fullPage: false }); };
  const modalBtn = label => page.locator(".modal-foot button", { hasText: label });

  console.log("1. 初期設定とデモデータ");
  await page.goto(url);
  await page.fill("input[autocomplete=organization]", "テスト内科クリニック");
  await page.fill("input[autocomplete=username]", "dr.test");
  await page.fill("input[autocomplete=name]", "医師 太郎");
  await page.locator("input[type=password]").nth(0).fill("Passw0rd!x");
  await page.locator("input[type=password]").nth(1).fill("Passw0rd!x");
  await page.click("button:has-text('はじめる')");
  await page.waitForSelector(".modal:has-text('デモ用の利用者')", { timeout: 60000 });
  const creds = await page.$$eval(".modal tbody tr", trs => trs.map(tr => Array.from(tr.querySelectorAll("td"), td => td.textContent)));
  check(creds.length === 2, "看護師・事務の初期IDが表示される");
  await modalBtn("確認しました").click();
  await page.waitForSelector(".board");
  check(await page.locator(".lane-waiting .enc-card").count() === 3, "受付一覧に3名が診察待ち");
  await shot("01-reception");

  console.log("2. 鈴木さん: Do処方 + NSAIDs追加 → 相互作用警告");
  await page.locator(".enc-card", { hasText: "鈴木" }).locator("button", { hasText: "カルテ" }).click();
  await page.waitForSelector(".pt-head:has-text('鈴木 一郎')");
  await page.click("button:has-text('記載を始める')");
  await page.waitForSelector(".editor-col textarea");
  await page.locator(".vfield", { hasText: "体温" }).locator("input").fill("36.4");
  await page.locator(".vfield", { hasText: "血圧(上)" }).locator("input").fill("132");
  await page.locator(".vfield", { hasText: "血圧(下)" }).locator("input").fill("76");
  await page.locator(".editor-col textarea").nth(0).fill("3日前から腰痛が悪化。下肢しびれなし。");
  await page.locator(".editor-col textarea").nth(2).fill("腰痛症 増悪");
  await page.click("button:has-text('前回Do')");
  check(await page.locator(".rx-items .rx-item").count() === 2, "前回Do で2剤コピー");
  await page.fill(".drug-search input", "ろきそにん");
  await page.waitForSelector(".dropdown .opt");
  await page.keyboard.press("Enter");
  check(await page.locator(".rx-items .rx-item").count() === 3, "商品名（ひらがな）で検索して追加");
  check(await page.locator(".chk.warn", { hasText: "ワルファリン" }).count() > 0, "ワルファリン×NSAIDs の相互作用警告");
  check(await page.locator(".chk.info", { hasText: "75歳以上" }).count() > 0, "高齢者への注意表示");
  await shot("02-editor-warnings");
  await page.click("button:has-text('確定する')");
  await page.waitForSelector(".modal:has-text('処方の確認')");
  await modalBtn("確認して発行").click();
  await page.waitForSelector(".modal:has-text('確定しました')");
  await modalBtn("あとで").click();
  check(await page.locator(".note-card").first().locator(".rx-mini li").count() === 3, "確定した記載に処方3剤が表示");
  check(await page.locator(".pt-head .badge", { hasText: "会計待ち" }).count() === 1, "確定で受付状態が会計待ちになる");

  console.log("3. 確定後の修正（理由必須・版管理）");
  await page.locator(".note-card").first().locator("button", { hasText: "修正" }).click();
  await page.waitForSelector(".editor-col h2:has-text('記載の修正')");
  await page.locator(".editor-col textarea").nth(0).fill("3日前から腰痛が悪化。下肢しびれなし。\n重い物を持ち上げた後から。");
  await page.click("button:has-text('修正を確定')");
  await page.waitForSelector(".modal:has-text('修正理由')");
  await modalBtn("OK").click();
  check(await page.locator(".modal-err").count() === 1, "修正理由が空だと確定できない");
  await page.fill(".modal input", "受傷機転の追記");
  await modalBtn("OK").click();
  await page.waitForSelector(".note-card .linkish:has-text('第2版')");
  await page.locator(".note-card .linkish", { hasText: "第2版" }).first().click();
  await page.waitForSelector(".modal .ver");
  check(await page.locator(".modal .ok-text", { hasText: "改変されていません" }).count() === 1, "版のハッシュ照合OK");
  check(await page.locator(".modal .dadd", { hasText: "重い物" }).count() === 1, "差分に追記行が表示");
  await shot("03-history");
  await page.keyboard.press("Escape");

  console.log("4. 高橋さん: アレルギー警告は理由なしでは発行できない");
  await page.goto(url + "#/patients?q=たかはし");
  await page.click("tr:has-text('高橋 美咲')");
  await page.click("button:has-text('記載を始める')");
  await page.locator(".editor-col textarea").nth(0).fill("頭痛");
  await page.fill(".drug-search input", "ロキソプロフェンNa錠60mg（頓用）");
  await page.waitForSelector(".dropdown .opt");
  await page.keyboard.press("Enter");
  check(await page.locator(".chk.danger", { hasText: "ロキソニン" }).count() === 1, "商品名で登録したアレルギーを一般名処方で検出");
  await page.click("button:has-text('確定する')");
  await page.waitForSelector(".modal:has-text('処方の警告')");
  await modalBtn("理由を記録して発行").click();
  check(await page.locator(".modal-err").count() === 1, "理由なしでは発行できない");
  await page.keyboard.press("Escape");
  await page.locator(".rx-items .rx-item .icon-btn").click();
  await page.fill(".drug-search input", "カロナール");
  await page.waitForSelector(".dropdown .opt");
  await page.locator(".dropdown .opt", { hasText: "頓用" }).dispatchEvent("mousedown");
  check(await page.locator(".chk.danger").count() === 0, "アセトアミノフェンに変更すると警告が消える");
  await page.click("button:has-text('確定する')");
  await page.waitForSelector(".modal:has-text('確定しました')");
  await modalBtn("あとで").click();

  console.log("5. 山田さん: 検査・経過グラフ・文書");
  await page.goto(url + "#/patients?q=ヤマダ");
  await page.click("tr:has-text('山田 太郎')");
  await page.waitForSelector(".note-card");
  await shot("04-chart");
  await page.click(".tabs a:has-text('検査')");
  await page.waitForSelector(".lab-tbl");
  check(await page.locator(".lab-tbl tr", { hasText: "HbA1c" }).locator(".flag-H").count() >= 2, "HbA1c 高値に H 表示");
  check(await page.locator(".lab-tbl tr", { hasText: "eGFR" }).count() === 1, "eGFR 自動計算行");
  await shot("05-labs");
  await page.click(".tabs a:has-text('経過グラフ')");
  await page.waitForSelector(".chart svg");
  const box = await page.locator(".chart svg").first().boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  check(await page.locator(".chart-tip:not([hidden])").count() === 1, "グラフにホバー表示");
  await shot("06-vitals");
  await page.click(".tabs a:has-text('文書')");
  await page.click("button:has-text('診療情報提供書')");
  await page.waitForSelector(".modal textarea");
  const dx = await page.locator(".modal .field", { hasText: "傷病名" }).locator("textarea").inputValue();
  check(dx.includes("高血圧症") && dx.includes("2型糖尿病"), "傷病名が病名から自動入力");
  const meds = await page.locator(".modal .field", { hasText: "現在の処方" }).locator("textarea").inputValue();
  check(meds.includes("ロスバスタチン"), "現在の処方が自動入力");
  await page.locator(".modal .field", { hasText: "紹介先医療機関" }).locator("input").fill("架空総合病院");
  await modalBtn("保存して印刷").click();
  await page.waitForSelector("td:has-text('架空総合病院')");
  check(true, "文書を保存");

  console.log("6. 監査ログ・改ざんチェック・バックアップ");
  await page.goto(url + "#/audit");
  await page.click("button:has-text('改ざんチェック')");
  await page.waitForSelector(".verify .ok-text, .verify .notice");
  check(await page.locator(".verify .ok-text").count() === 1, "監査ログのハッシュ鎖が正常");
  await shot("07-audit");
  await page.goto(url + "#/admin");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("button:has-text('バックアップを書き出す')")]);
  const backup = JSON.parse(fs.readFileSync(await dl.path(), "utf8"));
  const plain = JSON.stringify(backup.records);
  check(backup.records.length > 30 && !plain.includes("山田") && !plain.includes("ワルファリン"), "バックアップは暗号化済み（氏名・薬品名が平文で含まれない）");

  console.log("7. 権限: 看護師・医療事務");
  await page.click("button:has-text('ログアウト')");
  const nurse = creds.find(c => c[1] === "nurse1");
  await page.fill("input[autocomplete=username]", "nurse1");
  await page.fill("input[autocomplete=current-password]", "wrong-password");
  await page.click("button:has-text('ログイン')");
  await page.waitForSelector(".form-err:has-text('違います')");
  check(true, "誤ったパスワードは拒否");
  await page.fill("input[autocomplete=current-password]", nurse[2]);
  await page.click("button:has-text('ログイン')");
  await page.waitForSelector(".modal:has-text('パスワードを変更してください')");
  await page.locator(".modal input").nth(0).fill(nurse[2]);
  await page.locator(".modal input").nth(1).fill("Nurse-pass-2");
  await page.locator(".modal input").nth(2).fill("Nurse-pass-2");
  await modalBtn("変更する").click();
  await page.waitForSelector(".board");
  check(await page.locator(".nav a", { hasText: "管理" }).count() === 0, "看護師に管理メニューは出ない");
  await page.goto(url + "#/patients?q=サトウ");
  await page.click("tr:has-text('佐藤 花子')");
  await page.click("button:has-text('記載を始める')");
  await page.waitForSelector(".editor-col textarea");
  check(await page.locator(".editor-col .badge", { hasText: "看護記録" }).count() === 1, "看護師は看護記録として記載");
  check(await page.locator(".rx-box .drug-search").count() === 0, "看護師には処方入力が出ない");
  await page.locator(".vfield", { hasText: "体温" }).locator("input").fill("37.6");
  await page.locator(".editor-col textarea").nth(0).fill("咳嗽あり。");
  await page.click("button:has-text('確定する')");
  await page.waitForSelector(".note-card .badge:has-text('看護記録')");
  check(true, "看護記録を確定");
  await page.click("button:has-text('ログアウト')");
  const clerk = creds.find(c => c[1] === "clerk1");
  await page.fill("input[autocomplete=username]", "clerk1");
  await page.fill("input[autocomplete=current-password]", clerk[2]);
  await page.click("button:has-text('ログイン')");
  await page.waitForSelector(".modal:has-text('パスワードを変更してください')");
  await page.locator(".modal input").nth(0).fill(clerk[2]);
  await page.locator(".modal input").nth(1).fill("Clerk-pass-2");
  await page.locator(".modal input").nth(2).fill("Clerk-pass-2");
  await modalBtn("変更する").click();
  await page.waitForSelector(".board");
  check(await page.locator(".enc-card button", { hasText: "カルテ" }).count() === 0, "事務にはカルテボタンが出ない");
  await page.goto(url + "#/patients?q=ヤマダ");
  await page.click("tr:has-text('山田 太郎')");
  await page.waitForSelector(".tabs");
  const tabs = await page.$$eval(".tabs a", as => as.map(a => a.textContent));
  check(!tabs.includes("カルテ") && !tabs.includes("処方歴") && tabs.includes("患者情報"), "事務は診療タブを見られない");
  await page.goto(url + "#/new");
  await page.locator(".field", { hasText: "氏名" }).first().locator("input").fill("新規 次郎");
  await page.locator(".field", { hasText: "カナ" }).first().locator("input").fill("しんき じろう");
  await page.locator(".field", { hasText: "生年月日" }).first().locator("input").fill("1990-02-03");
  await page.locator(".field", { hasText: "性別" }).first().locator("select").selectOption("M");
  await page.click("button:has-text('登録する')");
  await page.waitForSelector(".modal:has-text('このまま受付')");
  await modalBtn("受付へ").click();
  await page.waitForSelector(".modal:has-text('受付')");
  await modalBtn("受付する").click();
  await page.waitForSelector(".pt-head:has-text('シンキ ジロウ')");
  check(await page.locator(".pt-head .badge", { hasText: "診察待ち" }).count() === 1, "事務が新患登録→受付（ひらがな→カタカナ変換）");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url + "#/reception");
  await page.waitForSelector(".board");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(!overflow, "スマホ幅で横スクロールが出ない");
  await shot("08-mobile");
  await page.setViewportSize({ width: 1440, height: 900 });

  console.log("8. 改ざん検出（DBの暗号文を書き換える）");
  await page.click("button:has-text('ログアウト')");
  await page.evaluate(async () => {
    const db = await new Promise(r => { const q = indexedDB.open("emr-local"); q.onsuccess = () => r(q.result); });
    const recs = await new Promise(r => { const q = db.transaction("records").objectStore("records").getAll(); q.onsuccess = () => r(q.result); });
    const a = recs.find(x => x.type === "audit" && x.id === "audit-000000005");
    const ct = atob(a.ct); a.ct = btoa(String.fromCharCode(ct.charCodeAt(0) ^ 1) + ct.slice(1));
    await new Promise(r => { const tx = db.transaction("records", "readwrite"); tx.objectStore("records").put(a); tx.oncomplete = r; });
  });
  await page.fill("input[autocomplete=username]", "dr.test");
  await page.fill("input[autocomplete=current-password]", "Passw0rd!x");
  await page.click("button:has-text('ログイン')");
  await page.waitForSelector(".toast.error:has-text('復号できない')");
  check(true, "書き換えられたレコードをログイン時に検出");
  await page.goto(url + "#/audit");
  await page.click("button:has-text('改ざんチェック')");
  await page.waitForSelector(".verify .notice");
  check(await page.locator(".verify li", { hasText: "連番の欠落" }).count() === 1, "監査ログの欠落を検出");

  const realErrors = errors.filter(e => !/favicon/.test(e));
  check(realErrors.length === 0, "JavaScript エラーなし" + (realErrors.length ? ": " + realErrors.join(" | ") : ""));
  await browser.close();
  srv.close();
  console.log(failures ? `\n失敗 ${failures} 件` : "\nすべて成功");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
