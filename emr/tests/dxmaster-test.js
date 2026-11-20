/* 病名マスター取り込み（列の自動判別・文字コード判定）と検索のテスト
 *   実行: node emr/tests/dxmaster-test.js */
const fs = require("fs"), path = require("path");
global.window = global;
require("../js/diseases.js"); require("../js/dxmaster.js");
const X = window.EMRDxMaster;
let fail = 0; const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fail++; };

const sj = X.parse(X.decode(fs.readFileSync(path.join(__dirname, "fixtures", "dx-sample-sjis.txt"))));
ok(sj.list.length === 8, `Shift_JIS・独自の列順から8件読み取り（${sj.list.length}件）`);
const ht = sj.list.find(d => d.name === "高血圧症");
ok(ht && ht.icd === "I10" && /ｺｳｹﾂ|コウケツ/.test(ht.kana), "病名・読み・ICDの列を正しく判別");
ok(sj.list.find(d => d.name === "２型糖尿病").icd === "E11.9", "点なしICD（E119）を E11.9 に直す");
ok(X.search(sj.list, "こうけつ", 5)[0].name === "高血圧症", "半角カナの読みでも、ひらがなで検索できる");
ok(X.search(sj.list, "2型", 5)[0].name === "２型糖尿病", "全角・半角の違いを吸収して検索");
ok(X.search(sj.list, "D69", 5)[0].name === "特発性血小板減少性紫斑病", "ICDで検索");

const cs = X.parse(X.decode(fs.readFileSync(path.join(__dirname, "fixtures", "dx-custom.csv"))));
ok(cs.list.length === 3 && !cs.list.some(d => d.name === "病名"), "自作CSV（見出し行あり）を3件読み取り、見出しは除く");
ok(cs.list.some(d => d.name === "自作の病名, カンマ入り"), "\"\" で囲んだカンマ入りの病名");

let threw = false; try { X.parse("abc,def\n123,456\n"); } catch (e) { threw = /病名の列/.test(e.message); }
ok(threw, "病名のないファイルは分かりやすいエラーにする");

const L = window.EMRDiseases;
ok(L.length >= 400, `組み込みの病名 ${L.length}件`);
for (const [q, want] of [["こうけつあつ", "高血圧症"], ["にきび", "尋常性ざ瘡"], ["みずむし", "白癬"], ["ぎっくり", "急性腰痛症"], ["ものもらい", "麦粒腫"], ["おたふく", "流行性耳下腺炎"]])
  ok(X.search(L, q, 3).some(d => d.name === want), `「${q}」→ ${want}`);
console.log(fail ? `失敗 ${fail} 件` : "病名マスターのテスト すべて成功");
process.exit(fail ? 1 : 0);
