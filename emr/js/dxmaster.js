/* 病名マスター: 検索と、外部ファイル（MEDIS 標準病名マスターなど）の取り込み
 *
 * 取り込みは列の並びを決め打ちしない。最初の数百行を見て
 *   「ICD-10 の形の列」「漢字を含む病名の列」「カナだけの読みの列」を自動で見分ける。
 * 文字コードは UTF-8 / Shift_JIS を自動判定。区切りはタブまたはカンマ（"" 囲み対応）。
 */
(function (g) {
  "use strict";

  const ICD_RE = /^[A-Z]\d{2}(\.?\d{1,2})?[+*]?$/;
  const KANJI_RE = /[一-鿿々]/;
  const KANA_RE = /^[゠-ヿｦ-ﾟ぀-ゟ\s・ー（）()\-－]+$/;

  function norm(s) {
    return String(s || "").normalize("NFKC").toLowerCase()
      .replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60))
      .replace(/[\s・]/g, "");
  }
  function normIcd(s) {
    let t = String(s || "").normalize("NFKC").toUpperCase().replace(/[+*†]$/, "").trim();
    if (/^[A-Z]\d{3,4}$/.test(t)) t = t.slice(0, 3) + "." + t.slice(3); // I489 → I48.9
    return t;
  }

  function decode(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(u8).replace(/^﻿/, ""); }
    catch (e) { return new TextDecoder("shift_jis").decode(u8); }
  }

  function splitLine(line, sep) {
    if (sep === "\t") return line.split("\t").map(x => x.trim());
    const out = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ",") { out.push(cur.trim()); cur = ""; }
      else cur += c;
    }
    out.push(cur.trim());
    return out;
  }

  /** ファイルの中身（文字列）から [{name, kana, icd}] を作る。見分けた列も返す */
  function parse(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) throw new Error("ファイルが空です");
    const sep = (lines[0].match(/\t/g) || []).length >= (lines[0].match(/,/g) || []).length && lines[0].includes("\t") ? "\t" : ",";
    const rows = lines.map(l => splitLine(l, sep));
    const sample = rows.slice(0, 400);
    const width = Math.max(...sample.map(r => r.length));
    const score = { icd: new Array(width).fill(0), name: new Array(width).fill(0), kana: new Array(width).fill(0) };
    for (const r of sample) r.forEach((v, i) => {
      if (!v) return;
      if (ICD_RE.test(v.normalize("NFKC").toUpperCase())) score.icd[i]++;
      if (KANJI_RE.test(v)) score.name[i] += 1 + Math.min(v.length, 20) / 40; // 長い漢字の列ほど病名らしい
      if (KANA_RE.test(v) && /[゠-ヿｦ-ﾟ]/.test(v)) score.kana[i]++;
    });
    const best = arr => { let b = -1, bi = -1; arr.forEach((v, i) => { if (v > b) { b = v; bi = i; } }); return b > sample.length * 0.3 ? bi : -1; };
    const col = { name: best(score.name), icd: best(score.icd), kana: best(score.kana) };
    if (col.name < 0) throw new Error("病名の列が見つかりませんでした。病名の一覧（テキストまたはCSV）を選んでください");
    const seen = new Set(), list = [];
    for (const r of rows) {
      const name = (r[col.name] || "").trim();
      if (!name || !KANJI_RE.test(name) && !/[゠-ヿ]/.test(name)) continue;
      if (/^(病名|名称|病名表記|傷病名)$/.test(name)) continue; // 見出し行
      const icd = col.icd >= 0 ? normIcd(r[col.icd]) : "";
      const kana = col.kana >= 0 ? (r[col.kana] || "").normalize("NFKC") : "";
      if (seen.has(name)) continue;
      seen.add(name);
      list.push({ name, kana, icd: ICD_RE.test(icd) ? icd : "" });
    }
    if (!list.length) throw new Error("病名を1件も読み取れませんでした");
    return { list, col, sep, total: rows.length };
  }

  /** 検索: 病名・よみ・ICD のどれでも。前方一致を優先して並べる */
  function search(master, q, limit) {
    const n = norm(q);
    if (!n) return [];
    const icdQ = /^[a-z]\d/.test(n) ? n.toUpperCase() : null;
    const hits = [];
    for (const d of master) {
      const nn = d._n || (d._n = norm(d.name));
      const words = d._k || (d._k = String(d.kana || "").split(/\s+/).map(norm).filter(Boolean));
      let s = -1;
      if (nn === n) s = 0;
      else if (nn.startsWith(n) || words.some(w => w === n)) s = 1;
      else if (words.some(w => w.startsWith(n))) s = 2;
      else if (nn.includes(n)) s = 3;
      else if (words.some(w => w.includes(n))) s = 4;
      else if (icdQ && d.icd && d.icd.toUpperCase().replace(".", "").startsWith(icdQ.replace(".", ""))) s = 5;
      if (s >= 0) hits.push([s, d.name.length, d]);
    }
    hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return hits.slice(0, limit || 30).map(h => h[2]);
  }

  g.EMRDxMaster = { parse, decode, search, norm, normIcd };
})(typeof window !== "undefined" ? window : globalThis);
