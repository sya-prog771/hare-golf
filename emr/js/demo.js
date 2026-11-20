/* デモデータ（すべて架空の人物・架空の内容です） */
(function (g) {
  "use strict";
  const ST = g.EMRStore, C = g.EMRCrypto;

  function tempPassword() {
    const a = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const r = crypto.getRandomValues(new Uint8Array(10));
    return Array.from(r, b => a[b % a.length]).join("");
  }

  const drug = (name, qty, usage, days, kind, unit) => ({ name, qty, usage, days, kind: kind || "internal", unit: unit || "錠" });

  async function visit(p, daysAgo, o) {
    const S = ST.S, uid = S.user.id;
    const date = ST.addDays(ST.ymd(), -daysAgo);
    const at = h => new Date(`${date}T${h}:00`).toISOString();
    const enc = await ST.save("encounter", {
      patientId: p.id, date, dept: "内科", visitType: o.first ? "初診" : "再診", status: "done", no: 1,
      complaint: o.complaint || "", receptionAt: at("09:10"), receptionBy: uid, doctorId: uid,
      statusLog: [{ at: at("09:10"), status: "waiting", by: uid }, { at: at("09:25"), status: "exam", by: uid }, { at: at("09:40"), status: "billing", by: uid }, { at: at("09:50"), status: "done", by: uid }]
    }, { silent: true });
    const content = { S: o.S || "", O: o.O || "", A: o.A || "", P: o.P || "", vitals: o.vitals || {} };
    const v = { v: 1, content, signedBy: uid, signedAt: at("09:38"), reason: "" };
    v.hash = await C.sha256hex(JSON.stringify({ prev: "", v: 1, content, signedBy: uid, signedAt: v.signedAt, reason: "" }));
    const note = await ST.save("note", {
      patientId: p.id, encounterId: enc.id, date, kind: "診療録", authorId: uid,
      createdAt: at("09:26"), updatedAt: at("09:38"), draft: null, versions: [v]
    }, { silent: true });
    if (o.rx) {
      await ST.save("rx", {
        patientId: p.id, encounterId: enc.id, noteId: note.id, date, type: "院外",
        items: o.rx.map(it => Object.assign({ comment: "", generic: true }, it)), status: "issued", issuedBy: uid, issuedAt: at("09:39")
      }, { silent: true });
    }
    if (o.lab) await ST.save("lab", { patientId: p.id, date, values: o.lab, comment: "", enteredBy: uid, enteredAt: at("15:00") }, { silent: true });
  }

  async function problem(p, name, icd, start, extra) {
    await ST.save("problem", Object.assign({
      patientId: p.id, name, icd, suspected: false, main: false, start, end: "", outcome: "継続", comment: "",
      createdAt: ST.nowIso(), createdBy: ST.S.user.id, log: []
    }, extra || {}), { silent: true });
  }

  async function seed() {
    const T = ST.ymd(), d = n => ST.addDays(T, -n);

    const yamada = await ST.savePatient({
      name: "山田 太郎", kana: "ヤマダ タロウ", birth: "1958-04-12", sex: "M", zip: "000-0000",
      address: "（デモ）東京都架空区本町1-2-3", phone: "000-0000-0001", bloodType: "A+", infection: "",
      history: "虫垂炎術後（20歳）", familyHistory: "父：脳梗塞　母：2型糖尿病", smoking: "元喫煙（20本×30年、55歳で禁煙）", alcohol: "機会飲酒",
      insurance: { type: "社保", insurerNo: "06139999", symbol: "1234", number: "56", branch: "01", ratio: 30, validUntil: "" },
      allergies: [{ substance: "ペニシリン", reaction: "全身の発疹", severity: "中等度" }],
      emergency: { name: "山田 花江", relation: "妻", phone: "000-0000-0002" }, memo: ""
    });
    await problem(yamada, "高血圧症", "I10", d(1100), { main: true });
    await problem(yamada, "2型糖尿病", "E11.9", d(730));
    await problem(yamada, "脂質異常症", "E78.5", d(730));
    const ybase = [drug("【般】アムロジピン錠5mg", 1, "1日1回朝食後", 28), drug("【般】メトホルミン塩酸塩錠250mg", 1, "1日2回朝夕食後", 28)];
    const yfull = ybase.concat([drug("【般】ロスバスタチン錠2.5mg", 1, "1日1回夕食後", 28)]);
    const yv = [
      [168, { bt: 36.4, sbp: 152, dbp: 94, pulse: 78, spo2: 98, weight: 78.0, height: 170 }, "食事は気をつけているが間食が多い。", "血圧高め。HbA1c 7.6%。", "高血圧・2型糖尿病ともにコントロール不十分。", "減塩・間食を控えるよう指導。処方継続。4週後再診。", ybase, { HbA1c: 7.6, GLU: 148, LDL: 168, HDL: 44, TG: 210, TC: 246, AST: 28, ALT: 34, GGT: 52, Cr: 0.92, BUN: 16, UA: 6.8, Na: 141, K: 4.2, WBC: 6.2, Hb: 14.8, Plt: 232, CRP: 0.08 }],
      [140, { bt: 36.5, sbp: 146, dbp: 90, pulse: 76, spo2: 98, weight: 77.4 }, "間食を減らした。", "胸部：心音整、心雑音なし。下腿浮腫なし。", "改善傾向。", "処方継続。4週後再診。", ybase, null],
      [112, { bt: 36.3, sbp: 142, dbp: 88, pulse: 74, spo2: 97, weight: 76.9 }, "特に変わりなし。", "下腿浮腫なし。", "LDL高値持続。", "ロスバスタチン追加。筋肉痛が出たら連絡するよう説明。", yfull, null],
      [84, { bt: 36.6, sbp: 138, dbp: 86, pulse: 72, spo2: 98, weight: 76.2 }, "筋肉痛なし。", "全身状態良好。", "改善傾向。", "処方継続。採血。", yfull, { HbA1c: 7.1, GLU: 132, LDL: 142, HDL: 46, TG: 168, TC: 218, AST: 30, ALT: 36, GGT: 48, Cr: 0.95, BUN: 15, UA: 6.5, Na: 140, K: 4.3, CRP: 0.05 }],
      [56, { bt: 36.4, sbp: 134, dbp: 84, pulse: 70, spo2: 98, weight: 75.8 }, "朝の散歩を始めた。", "下腿浮腫なし。", "状態安定。", "処方継続。", yfull, null],
      [28, { bt: 36.5, sbp: 132, dbp: 82, pulse: 70, spo2: 98, weight: 75.5 }, "服薬継続できている。", "胸部：心音整、心雑音なし。呼吸音清。", "コントロール良好。", "処方継続。4週後再診。", yfull, { HbA1c: 6.8, GLU: 121, LDL: 118, HDL: 48, TG: 142, TC: 192, AST: 26, ALT: 30, GGT: 41, Cr: 0.94, BUN: 15, UA: 6.2, Na: 141, K: 4.1, WBC: 5.8, Hb: 14.6, Plt: 240, CRP: 0.04 }]
    ];
    for (let i = 0; i < yv.length; i++) {
      const [n, vitals, S, O, A, P, rx, lab] = yv[i];
      await visit(yamada, n, { first: i === 0, complaint: "定期受診", vitals, S, O, A, P, rx, lab });
    }

    const sato = await ST.savePatient({
      name: "佐藤 花子", kana: "サトウ ハナコ", birth: "1985-09-30", sex: "F", zip: "", address: "（デモ）神奈川県架空市中央2-3-4",
      phone: "000-0000-0003", bloodType: "O+", infection: "", history: "特記なし", familyHistory: "", smoking: "なし", alcohol: "なし",
      insurance: { type: "国保", insurerNo: "139999", symbol: "架空", number: "789", branch: "", ratio: 30, validUntil: "" },
      allergies: [], emergency: { name: "", relation: "", phone: "" }, memo: "授乳中ではない（前回確認）"
    });
    await problem(sato, "アレルギー性鼻炎", "J30.4", d(380), { main: true });
    await problem(sato, "急性上気道炎", "J06.9", d(200), { outcome: "治癒", end: d(193) });
    await visit(sato, 200, {
      first: true, complaint: "のどの痛み", vitals: { bt: 37.4, sbp: 112, dbp: 70, pulse: 84, spo2: 98 },
      S: "2日前から咽頭痛、鼻汁。", O: "咽頭発赤（＋）、扁桃腫大（−）。頸部リンパ節腫脹なし。呼吸音清。", A: "急性上気道炎", P: "対症療法。増悪時再診。",
      rx: [drug("【般】カルボシステイン錠500mg", 1, "1日3回毎食後", 5), drug("【般】アセトアミノフェン錠200mg（頓用）", 2, "発熱時（38.5℃以上）", 5, "prn")]
    });

    const suzuki = await ST.savePatient({
      name: "鈴木 一郎", kana: "スズキ イチロウ", birth: "1942-01-20", sex: "M", zip: "", address: "（デモ）埼玉県架空町3-4-5",
      phone: "000-0000-0004", bloodType: "B+", infection: "", history: "前立腺肥大症", familyHistory: "", smoking: "なし", alcohol: "なし",
      insurance: { type: "後期高齢者", insurerNo: "39139999", symbol: "", number: "00012345", branch: "", ratio: 10, validUntil: "" },
      allergies: [], emergency: { name: "鈴木 次郎", relation: "長男", phone: "000-0000-0005" }, memo: "耳が遠いので大きめの声で"
    });
    await problem(suzuki, "心房細動", "I48.9", d(1500), { main: true });
    await problem(suzuki, "腰痛症", "M54.5", d(400));
    const srx = [drug("【般】ワルファリンK錠1mg", 2, "1日1回夕食後", 28), drug("【般】ビソプロロールフマル酸塩錠2.5mg", 1, "1日1回朝食後", 28)];
    await visit(suzuki, 56, { complaint: "定期受診", vitals: { bt: 36.2, sbp: 128, dbp: 72, pulse: 68, spo2: 96, weight: 58.2 }, S: "変わりなし。", O: "脈不整。下腿浮腫なし。", A: "心房細動 レートコントロール良好。", P: "処方継続。", rx: srx, lab: { Cr: 1.12, BUN: 22, Hb: 12.9, Plt: 180, K: 4.4, Na: 139 } });
    await visit(suzuki, 28, { complaint: "定期受診", vitals: { bt: 36.3, sbp: 126, dbp: 70, pulse: 72, spo2: 96, weight: 58.0 }, S: "最近腰が痛い。", O: "脈不整。腰部叩打痛なし。下肢筋力低下なし。", A: "心房細動 安定。腰痛症。", P: "処方継続。湿布は自宅にあるものを使用。", rx: srx });

    const takahashi = await ST.savePatient({
      name: "高橋 美咲", kana: "タカハシ ミサキ", birth: "2001-06-05", sex: "F", zip: "", address: "（デモ）千葉県架空市南4-5-6",
      phone: "000-0000-0006", bloodType: "AB+", infection: "", history: "", familyHistory: "母：片頭痛", smoking: "なし", alcohol: "機会飲酒",
      insurance: { type: "社保", insurerNo: "06139998", symbol: "77", number: "12", branch: "02", ratio: 30, validUntil: "" },
      allergies: [{ substance: "ロキソニン", reaction: "じんましん", severity: "軽度" }], emergency: { name: "", relation: "", phone: "" }, memo: ""
    });
    await problem(takahashi, "片頭痛", "G43.9", d(40), { main: true });
    await visit(takahashi, 40, {
      first: true, complaint: "頭痛", vitals: { bt: 36.6, sbp: 104, dbp: 64, pulse: 76, spo2: 99 },
      S: "月に2〜3回、拍動性の頭痛。光がまぶしい。", O: "神経学的異常所見なし。", A: "片頭痛", P: "頭痛ダイアリーをつけるよう指導。",
      rx: [drug("【般】アセトアミノフェン錠200mg（頓用）", 2, "頭痛時", 10, "prn")]
    });

    // 本日の受付
    await ST.receive(sato.id, { complaint: "3日前から咳・鼻水" });
    await ST.receive(suzuki.id, { complaint: "腰痛が悪化した" });
    await ST.receive(yamada.id, { complaint: "定期受診（薬がなくなる）" });

    // 他職種の利用者
    const creds = [];
    for (const [loginId, name, role] of [["nurse1", "看護 さくら（デモ）", "nurse"], ["clerk1", "受付 ゆうき（デモ）", "clerk"]]) {
      const pw = tempPassword();
      await ST.createUser({ loginId, name, role, admin: false, password: pw });
      creds.push({ loginId, name, role, pw });
    }
    await ST.audit("デモデータ作成", { detail: "架空の患者4名と受診履歴を作成" });
    ST.emit("all");
    return creds;
  }

  g.EMRDemo = { seed, tempPassword };
})(window);
