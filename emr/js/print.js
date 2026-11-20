/* 印刷（処方箋・診療情報提供書・カルテ） */
(function (g) {
  "use strict";
  const ST = g.EMRStore, U = g.EMRUI;

  const esc = s => String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nl = s => esc(s).replace(/\n/g, "<br>");

  const CSS = `
    @page { size: A4; margin: 12mm; }
    * { box-sizing: border-box; }
    body { font-family: "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif; color: #000; font-size: 10.5pt; margin: 0; line-height: 1.5; }
    h1 { text-align: center; font-size: 18pt; letter-spacing: .6em; margin: 0 0 4px; }
    .sub { text-align: center; font-size: 9pt; margin-bottom: 8px; }
    table { border-collapse: collapse; width: 100%; }
    td, th { border: 1px solid #000; padding: 3px 6px; vertical-align: top; text-align: left; font-weight: normal; }
    th { width: 7.5em; background: #f2f2f2; font-size: 9pt; }
    .small { font-size: 8.5pt; }
    .rx-body { min-height: 90mm; }
    .rx-item { margin: 0 0 4px; }
    .rx-item .q { padding-left: 2em; }
    .right { text-align: right; }
    .note { margin: 8px 0 0; font-size: 8pt; color: #444; }
    .sec { margin-top: 10px; }
    .sec h3 { font-size: 11pt; border-bottom: 1px solid #000; margin: 0 0 4px; }
    .enc { page-break-inside: avoid; border-top: 1px solid #000; padding: 6px 0; }
    .soap { display: grid; grid-template-columns: 2em 1fr; gap: 2px 6px; }
    .soap b { font-family: sans-serif; }
    .muted { color: #555; }
    .letter p { margin: 0 0 6px; }
  `;

  function openPrint(title, html) {
    const fr = document.createElement("iframe");
    fr.setAttribute("aria-hidden", "true");
    Object.assign(fr.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
    document.body.appendChild(fr);
    const doc = fr.contentDocument;
    doc.open();
    doc.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>${html}</body></html>`);
    doc.close();
    setTimeout(() => {
      fr.contentWindow.focus();
      fr.contentWindow.print();
      setTimeout(() => fr.remove(), 1500);
    }, 200);
    return doc;
  }

  function clinicBlock() {
    const s = ST.settings();
    return `${esc(s.address)}<br>${esc(s.clinicName)}<br>電話 ${esc(s.phone)}`;
  }

  function prescription(rx) {
    const p = ST.patient(rx.patientId), s = ST.settings(), ins = p.insurance || {};
    const doc = ST.S.col.staff.get(rx.issuedBy) || {};
    const items = rx.items.map((it, i) => `<div class="rx-item">${i + 1})　${esc(it.name)}${it.generic === false ? "　<span class='small'>［変更不可］</span>" : ""}<div class="q">${esc(ST.itemQtyText(it))}${it.comment ? "　" + esc(it.comment) : ""}</div></div>`).join("");
    const symNo = [ins.symbol, ins.number].filter(Boolean).join("・") + (ins.branch ? `（枝番）${esc(ins.branch)}` : "");
    const html = `
      <h1>処方箋</h1>
      <div class="sub">（この処方箋は、どの保険薬局でも有効です。）</div>
      <table>
        <tr><th>公費負担者番号</th><td></td><th>保険者番号</th><td>${esc(ins.insurerNo)}</td></tr>
        <tr><th class="small">公費負担医療の受給者番号</th><td></td><th class="small">被保険者証・被保険者手帳の記号・番号</th><td>${esc(symNo)}</td></tr>
        <tr><th>患者 氏名</th><td>${esc(p.name)}</td><th rowspan="3" class="small">保険医療機関の所在地及び名称</th><td rowspan="3">${clinicBlock()}<br>保険医氏名　${esc(doc.name || "")}　㊞<br><span class="small">医療機関コード ${esc(s.institutionCode)}</span></td></tr>
        <tr><th>生年月日</th><td>${esc(U.wareki(p.birth))}　${p.sex === "M" ? "男" : "女"}</td></tr>
        <tr><th>区分</th><td>${esc(ins.type || "")}　${ins.ratio ? esc(ins.ratio / 10) + "割" : ""}</td></tr>
        <tr><th>交付年月日</th><td>${esc(U.wareki(rx.date))}</td><th class="small">処方箋の使用期間</th><td class="small">${esc(U.wareki(ST.addDays(rx.date, 3)))}まで<br>特に記載のある場合を除き、交付の日を含めて4日以内に保険薬局に提出すること。</td></tr>
        <tr><th>処方</th><td colspan="3" class="rx-body">
          <div class="small">個々の処方薬について、医療上の必要性があるため、後発医薬品（ジェネリック医薬品）への変更に差し支えがあると判断した場合には、「変更不可」欄に記載すること。</div>
          <div style="margin-top:6px">${items}</div>
          <div style="margin-top:6px">以下余白</div>
          <div class="small" style="margin-top:8px">リフィル可　□（　　回）</div>
        </td></tr>
        <tr><th>備考</th><td colspan="3" style="height:18mm">${rx.items.some(i => i.generic === false) ? "保険医署名　　　　　　" : ""}</td></tr>
        <tr><th>調剤済年月日</th><td></td><th class="small">保険薬局の所在地及び名称・保険薬剤師氏名</th><td style="height:14mm"></td></tr>
      </table>
      <p class="note">※ 本システムの試作出力です。正式な様式（保険医療機関及び保険医療養担当規則 様式第二号）との一致を確認してから使用してください。</p>`;
    ST.audit("印刷", { patientId: p.id, target: rx.id, detail: "処方箋" });
    return openPrint(`処方箋_${p.pid}`, html);
  }

  function referral(d) {
    const p = ST.patient(d.patientId), s = ST.settings();
    const author = ST.S.col.staff.get(d.createdBy) || {};
    const row = (label, val) => `<div class="sec"><h3>${esc(label)}</h3><div>${nl(val || "")}</div></div>`;
    const title = d.kind === "診断書" ? "診　断　書" : "診療情報提供書";
    let html;
    if (d.kind === "診断書") {
      html = `<h1>${title}</h1>
        <table style="margin-top:12px">
          <tr><th>氏名</th><td>${esc(p.name)}（${esc(p.kana)}）</td><th>性別</th><td>${p.sex === "M" ? "男" : "女"}</td></tr>
          <tr><th>生年月日</th><td colspan="3">${esc(U.wareki(p.birth))}（${ST.age(p.birth)}歳）</td></tr>
          <tr><th>住所</th><td colspan="3">${esc(p.address)}</td></tr>
          <tr><th>病名</th><td colspan="3" style="height:20mm">${nl(d.diagnosis)}</td></tr>
          <tr><th>付記</th><td colspan="3" style="height:60mm">${nl(d.body)}</td></tr>
        </table>
        <p style="margin-top:14px">上記のとおり診断します。</p>
        <p class="right">${esc(U.wareki(d.date))}</p>
        <p class="right">${clinicBlock()}<br>医師　${esc(author.name || "")}　㊞</p>`;
    } else {
      html = `<h1 style="letter-spacing:.2em">${title}</h1>
        <p class="right">${esc(U.wareki(d.date))}</p>
        <div class="letter">
          <p>${esc(d.toHospital)}<br>${esc(d.toDept)}　${esc(d.toDoctor || "")}　先生　御侍史</p>
          <p class="right">${clinicBlock()}<br>医師　${esc(author.name || "")}　㊞</p>
          <table>
            <tr><th>患者氏名</th><td>${esc(p.name)}（${esc(p.kana)}）</td><th>性別</th><td>${p.sex === "M" ? "男" : "女"}</td></tr>
            <tr><th>生年月日</th><td>${esc(U.wareki(p.birth))}（${ST.age(p.birth)}歳）</td><th>電話</th><td>${esc(p.phone)}</td></tr>
            <tr><th>住所</th><td colspan="3">${esc(p.address)}</td></tr>
          </table>
          <p style="margin-top:8px">平素より大変お世話になっております。下記の患者さんをご紹介申し上げます。ご高診のほど、よろしくお願い申し上げます。</p>
          ${row("傷病名", d.diagnosis)}${row("紹介目的", d.purpose)}${row("既往歴・家族歴", d.history)}
          ${row("症状経過・検査結果", d.course)}${row("治療経過", d.treatment)}${row("現在の処方", d.meds)}${row("備考", d.remarks)}
        </div>`;
    }
    ST.audit("印刷", { patientId: p.id, target: d.id, detail: d.kind });
    return openPrint(`${d.kind}_${p.pid}`, html);
  }

  function chart(pid, from, to) {
    const p = ST.patient(pid), s = ST.settings();
    const notes = ST.notesOf(pid).filter(n => !n.deleted && n.versions.length && n.date >= from && n.date <= to).reverse();
    const rxs = ST.rxOf(pid);
    const probs = ST.problemsOf(pid);
    const vit = v => {
      const a = [];
      if (v.bt) a.push(`体温 ${v.bt}℃`);
      if (v.sbp) a.push(`血圧 ${v.sbp}/${v.dbp || "-"}`);
      if (v.pulse) a.push(`脈拍 ${v.pulse}`);
      if (v.spo2) a.push(`SpO2 ${v.spo2}%`);
      if (v.rr) a.push(`呼吸数 ${v.rr}`);
      if (v.weight) a.push(`体重 ${v.weight}kg`);
      return a.join("　");
    };
    const body = notes.map(n => {
      const last = n.versions[n.versions.length - 1], c = last.content;
      const rx = rxs.filter(r => r.encounterId === n.encounterId && r.status === "issued");
      return `<div class="enc">
        <div><b>${esc(U.jdateW(n.date))}</b>　${esc(n.kind)}　記載：${esc(ST.staffName(n.authorId))}　確定：${esc(ST.staffName(last.signedBy))} ${esc(U.jdt(last.signedAt))}${last.v > 1 ? `　<span class="muted">（第${last.v}版 修正理由：${esc(last.reason)}）</span>` : ""}</div>
        ${vit(c.vitals || {}) ? `<div class="muted">${esc(vit(c.vitals || {}))}</div>` : ""}
        <div class="soap"><b>S</b><div>${nl(c.S)}</div><b>O</b><div>${nl(c.O)}</div><b>A</b><div>${nl(c.A)}</div><b>P</b><div>${nl(c.P)}</div></div>
        ${rx.map(r => `<div style="margin-top:4px">Rp（${esc(r.type)}）<br>${r.items.map((it, i) => `${i + 1}) ${esc(it.name)}　${esc(ST.itemQtyText(it))}`).join("<br>")}</div>`).join("")}
      </div>`;
    }).join("");
    const html = `<h1 style="letter-spacing:.3em;font-size:15pt">診療録</h1>
      <table><tr><th>患者番号</th><td>${esc(p.pid)}</td><th>氏名</th><td>${esc(p.name)}（${esc(p.kana)}）</td></tr>
      <tr><th>生年月日</th><td>${esc(U.wareki(p.birth))}　${p.sex === "M" ? "男" : "女"}</td><th>期間</th><td>${esc(U.jdate(from))} 〜 ${esc(U.jdate(to))}</td></tr>
      <tr><th>病名</th><td colspan="3">${probs.map(x => `${esc(x.name)}${x.suspected ? "（疑い）" : ""}［${esc(x.outcome)}］`).join("、")}</td></tr>
      <tr><th>アレルギー</th><td colspan="3">${(p.allergies || []).map(a => esc(a.substance) + (a.reaction ? `（${esc(a.reaction)}）` : "")).join("、") || "なし"}</td></tr></table>
      ${body || "<p>期間内の確定済み記載はありません。</p>"}
      <p class="note">${esc(s.clinicName)}　出力日時 ${esc(U.jdt(ST.nowIso()))}　出力者 ${esc(ST.S.user.name)}</p>`;
    ST.audit("印刷", { patientId: pid, detail: `カルテ ${from}〜${to}` });
    return openPrint(`診療録_${p.pid}`, html);
  }

  g.EMRPrint = { prescription, referral, chart, esc };
})(window);
