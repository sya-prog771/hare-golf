/* データ層: 認証・権限・暗号化保存・監査ログ・業務ロジック */
(function (g) {
  "use strict";
  const C = g.EMRCrypto, DB = g.EMRDB, M = g.EMRMaster;
  const TYPES = ["staff", "settings", "patient", "encounter", "note", "problem", "rx", "lab", "doc", "audit"];

  const S = {
    dek: null, user: null, col: {}, auditSeq: 0, auditHash: "", corrupted: 0,
    q: Promise.resolve(), listeners: new Set()
  };
  let dxImported = null, dxMerged = null; // 病名マスター（下の「病名マスター」で使う）
  function resetCols() { for (const t of TYPES) S.col[t] = new Map(); }
  resetCols();

  // ---------- 日付ユーティリティ ----------
  const pad = n => String(n).padStart(2, "0");
  function ymd(d) { d = d || new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function nowIso() { return new Date().toISOString(); }
  function addDays(s, n) { const d = new Date(s + "T00:00:00"); d.setDate(d.getDate() + n); return ymd(d); }
  function age(birth, at) {
    if (!birth) return null;
    const b = new Date(birth + "T00:00:00"), a = at ? new Date(at + "T00:00:00") : new Date();
    let y = a.getFullYear() - b.getFullYear();
    if (a.getMonth() < b.getMonth() || (a.getMonth() === b.getMonth() && a.getDate() < b.getDate())) y--;
    return y;
  }

  // ---------- 検索用の正規化 ----------
  function norm(s) {
    return String(s || "").normalize("NFKC").toLowerCase()
      .replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60)) // ひらがな→カタカナ
      .replace(/[\s・]/g, "");
  }

  // ---------- 変更通知 ----------
  function onChange(fn) { S.listeners.add(fn); return () => S.listeners.delete(fn); }
  function emit(type) { for (const fn of S.listeners) { try { fn(type); } catch (e) { console.error(e); } } }

  // ---------- 暗号化レコード ----------
  function aad(type, id) { return type + ":" + id; }
  async function encRec(type, obj) {
    const e = await C.encryptJson(S.dek, obj, aad(type, obj.id));
    return { id: obj.id, type, iv: e.iv, ct: e.ct };
  }
  async function save(type, obj, opts) {
    requireLogin();
    if (!obj.id) obj.id = C.uid();
    const rec = await encRec(type, obj);
    try { await DB.put("records", rec); }
    catch (e) { await revert(type, obj.id); throw e; }
    S.col[type].set(obj.id, obj);
    if (!opts || !opts.silent) emit(type);
    return obj;
  }

  /** 保存に失敗したとき、画面側で書き換えた内容を捨てて、保存済みの内容に戻す */
  async function revert(type, id) {
    const r = await DB.get("records", id);
    if (!r) { S.col[type].delete(id); return; }
    try { S.col[type].set(id, await C.decryptJson(S.dek, r, aad(type, id))); } catch (e) { /* 復号できないものは触らない */ }
  }

  /** ほかの端末からの変更を反映する（院内サーバー版） */
  async function applyRemote(items) {
    if (!S.dek) return;
    const types = new Set();
    for (const it of items) {
      if (it.store === "records") {
        try {
          const obj = await C.decryptJson(S.dek, it.value, aad(it.value.type, it.value.id));
          if (!S.col[it.value.type]) continue;
          S.col[it.value.type].set(it.value.id, obj);
          types.add(it.value.type);
          if (it.value.type === "audit" && obj.seq > S.auditSeq) { S.auditSeq = obj.seq; S.auditHash = obj.hash; }
        } catch (e) { S.corrupted++; }
      } else if (it.store === "meta" && it.value.key === "diseaseMaster") {
        dxImported = it.value.rows && it.value.rows.length ? it.value : null; dxMerged = null;
      } else if (it.store === "meta" && it.value.key === "auditTail" && it.value.seq > S.auditSeq) {
        S.auditSeq = it.value.seq; S.auditHash = it.value.hash;
      }
    }
    if (S.user && types.has("staff")) {
      const me = S.col.staff.get(S.user.id);
      if (me && !me.active) { emit("revoked"); return; }
      if (me) S.user = me;
    }
    if (types.size && !(types.size === 1 && types.has("audit"))) emit("remote");
  }
  DB.onRemote(items => { applyRemote(items).catch(e => console.error(e)); });
  DB.onReset(() => emit("reset"));

  async function loadAll() {
    resetCols();
    S.corrupted = 0;
    const recs = await DB.getAll("records");
    await Promise.all(recs.map(async r => {
      try {
        const obj = await C.decryptJson(S.dek, r, aad(r.type, r.id));
        if (S.col[r.type]) S.col[r.type].set(r.id, obj);
      } catch (e) { S.corrupted++; }
    }));
    let last = null;
    for (const a of S.col.audit.values()) if (!last || a.seq > last.seq) last = a;
    S.auditSeq = last ? last.seq : 0;
    S.auditHash = last ? last.hash : "";
  }

  function requireLogin() { if (!S.dek || !S.user) throw new Error("ログインしていません"); }

  // ---------- 監査ログ（ハッシュチェーン） ----------
  function audit(action, info) {
    info = info || {};
    const run = async () => {
      if (!S.dek) return;
      const seq = S.auditSeq + 1;
      const entry = {
        id: "audit-" + String(seq).padStart(9, "0"), seq, at: nowIso(),
        userId: S.user ? S.user.id : null, userName: S.user ? S.user.name : "",
        action, patientId: info.patientId || null, target: info.target || null,
        detail: info.detail || "", prev: S.auditHash
      };
      entry.hash = await C.sha256hex(JSON.stringify(entry));
      const rec = await encRec("audit", entry);
      await DB.putMany([
        { store: "records", value: rec },
        { store: "meta", value: { key: "auditTail", seq, hash: entry.hash } }
      ]);
      S.col.audit.set(entry.id, entry);
      S.auditSeq = seq; S.auditHash = entry.hash;
    };
    // 院内サーバー版では複数の端末が同時に記録するので、末尾が先に進んでいたら最新の末尾につなぎ直す
    const runRetry = async () => {
      for (let i = 0; i < 10; i++) {
        try { return await run(); }
        catch (e) {
          if (!e.conflict) throw e;
          const tail = await DB.get("meta", "auditTail");
          if (tail && tail.seq >= S.auditSeq) {
            S.auditSeq = tail.seq; S.auditHash = tail.hash;
          }
        }
      }
      throw new Error("監査ログを記録できませんでした（同時アクセスが多すぎます）");
    };
    S.q = S.q.then(runRetry, runRetry).catch(e => console.error("監査ログの保存に失敗", e));
    return S.q;
  }

  async function verifyAudit() {
    const list = Array.from(S.col.audit.values()).sort((a, b) => a.seq - b.seq);
    const errors = [];
    let prev = "";
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.seq !== i + 1) { errors.push(`連番の欠落: ${i + 1} 番が見つかりません（${e.seq} 番の前）`); break; }
      if (e.prev !== prev) errors.push(`${e.seq} 番: 直前の記録とのつながりが一致しません`);
      const { hash, ...body } = e;
      const h = await C.sha256hex(JSON.stringify(body));
      if (h !== hash) errors.push(`${e.seq} 番: 内容が改変されています`);
      prev = hash;
    }
    const tail = await DB.get("meta", "auditTail");
    if (tail && list.length && tail.seq !== list[list.length - 1].seq) errors.push(`末尾の記録が欠けています（記録上は ${tail.seq} 番まで）`);
    if (S.corrupted) errors.push(`復号できないレコードが ${S.corrupted} 件あります（改変または破損）`);
    return { ok: errors.length === 0, count: list.length, errors };
  }

  // ---------- 認証 ----------
  async function hasUsers() { return (await DB.getAll("users")).length > 0; }

  function defaultSettings(clinicName) {
    return {
      id: "settings", clinicName: clinicName || "", address: "", phone: "", institutionCode: "",
      depts: ["内科"], autoLockMin: 10, nextPid: 1
    };
  }

  function validatePassword(pw) {
    if (!pw || String(pw).length < 8) return "パスワードは8文字以上にしてください";
    return null;
  }

  async function setup(o) {
    const err = validatePassword(o.password);
    if (err) throw new Error(err);
    const dek = await C.newDek();
    const id = C.uid();
    const wrap = await C.wrapDek(dek, o.password);
    S.dek = dek;
    resetCols();
    if (DB.mode === "server") {
      const k = await C.serverAuthKey(dek);
      await DB.initServer(k);
      DB.setAuthKey(k);
    }
    const staff = {
      id, loginId: o.loginId.trim(), name: o.name.trim(), role: "doctor", admin: true, active: true,
      license: o.license || "", mustChange: false, createdAt: nowIso()
    };
    S.user = staff;
    await DB.put("users", { id, loginId: staff.loginId, wrap, failed: 0, lockedUntil: 0 });
    await save("staff", staff, { silent: true });
    await save("settings", defaultSettings(o.clinicName), { silent: true });
    await audit("初期設定", { detail: `施設「${o.clinicName}」を作成` });
    await audit("ログイン");
    DB.persist();
    DB.connect(staff.name);
    return staff;
  }

  /** ローカル版のバックアップから院内サーバーへ移行する（サーバーが空のときだけ） */
  async function setupFromBackup(dump, loginId, password) {
    if (!dump || dump.format !== "emr-local-backup" || !Array.isArray(dump.users) || !Array.isArray(dump.records)) throw new Error("バックアップファイルの形式が正しくありません");
    const u = dump.users.find(x => x.loginId.toLowerCase() === String(loginId || "").trim().toLowerCase());
    if (!u || !u.wrap) throw new Error("そのログインIDはバックアップの中にありません");
    let dek;
    try { dek = await C.unwrapDek(u.wrap, password); } catch (e) { throw new Error("パスワードが違います（バックアップを取ったときのパスワードを入力してください）"); }
    const k = await C.serverAuthKey(dek);
    await DB.initRestore(k, dump);
    return login(loginId, password);
  }

  async function login(loginId, password) {
    const users = await DB.getAll("users");
    const key = String(loginId || "").trim().toLowerCase();
    const u = users.find(x => x.loginId.toLowerCase() === key);
    const generic = new Error("ログインIDまたはパスワードが違います");
    if (!u) throw generic;
    if (u.lockedUntil && u.lockedUntil > Date.now()) {
      const min = Math.ceil((u.lockedUntil - Date.now()) / 60000);
      throw new Error(`ログインに続けて失敗したため、あと約${min}分ロックされています`);
    }
    if (!u.wrap) throw new Error("このIDは利用停止中です。管理者に連絡してください");
    let dek;
    try { dek = await C.unwrapDek(u.wrap, password); } catch (e) {
      await DB.loginFailed(u);
      throw generic;
    }
    if (DB.mode === "server") {
      DB.setAuthKey(await C.serverAuthKey(dek));
      await DB.sync();
    }
    if (u.failed || u.lockedUntil) {
      const cur = (await DB.get("users", u.id)) || u;
      cur.failed = 0; cur.lockedUntil = 0;
      await DB.put("users", cur);
    }
    S.dek = dek;
    S.user = { id: u.id, name: "", role: "clerk" }; // 一時的（読み込み中）
    await loadAll();
    const staff = S.col.staff.get(u.id);
    if (!staff || !staff.active) { clearSession(); throw new Error("このIDは利用停止中です。管理者に連絡してください"); }
    S.user = staff;
    await loadDxMaster();
    await audit("ログイン");
    DB.connect(staff.name);
    return staff;
  }

  function clearSession() {
    S.dek = null; S.user = null; resetCols();
    DB.disconnect();
  }
  async function logout(reason) {
    if (S.dek) { try { await audit("ログアウト", { detail: reason || "" }); await S.q; } catch (e) { /* 通信できなくてもログアウトはする */ } }
    clearSession();
  }

  async function changePassword(oldPw, newPw) {
    requireLogin();
    const err = validatePassword(newPw);
    if (err) throw new Error(err);
    const u = await DB.get("users", S.user.id);
    try { await C.unwrapDek(u.wrap, oldPw); } catch (e) { throw new Error("現在のパスワードが違います"); }
    if (oldPw === newPw) throw new Error("新しいパスワードは現在と別のものにしてください");
    u.wrap = await C.wrapDek(S.dek, newPw);
    await DB.put("users", u);
    S.user.mustChange = false;
    await save("staff", S.user);
    await audit("パスワード変更");
  }

  // ---------- 権限 ----------
  const PERMS = {
    "clinical.view": ["doctor", "nurse"],
    "note.write": ["doctor", "nurse"],
    "rx.issue": ["doctor"],
    "problem.edit": ["doctor"],
    "lab.enter": ["doctor", "nurse"],
    "doc.write": ["doctor"],
    "billing": ["doctor", "clerk"],
    "patient.edit": ["doctor", "nurse", "clerk"],
    "reception": ["doctor", "nurse", "clerk"]
  };
  function can(p) {
    if (!S.user) return false;
    if (p === "admin") return !!S.user.admin;
    const r = PERMS[p];
    return !!r && r.includes(S.user.role);
  }
  function need(p) { if (!can(p)) throw new Error("この操作の権限がありません"); }

  // ---------- 利用者管理（管理者） ----------
  async function createUser(o) {
    need("admin");
    const users = await DB.getAll("users");
    const loginId = String(o.loginId || "").trim();
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(loginId)) throw new Error("ログインIDは半角英数字3〜32文字にしてください");
    if (users.some(x => x.loginId.toLowerCase() === loginId.toLowerCase())) throw new Error("そのログインIDはすでに使われています");
    const err = validatePassword(o.password);
    if (err) throw new Error(err);
    const id = C.uid();
    const wrap = await C.wrapDek(S.dek, o.password);
    await DB.put("users", { id, loginId, wrap, failed: 0, lockedUntil: 0 });
    const staff = await save("staff", {
      id, loginId, name: o.name.trim(), role: o.role, admin: !!o.admin, active: true,
      license: o.license || "", mustChange: true, createdAt: nowIso()
    });
    await audit("利用者追加", { target: id, detail: `${staff.name}（${M.roles[staff.role]}${staff.admin ? "・管理者" : ""}）` });
    return staff;
  }
  async function updateUser(id, patch) {
    need("admin");
    const st = S.col.staff.get(id);
    if (!st) throw new Error("利用者が見つかりません");
    if (id === S.user.id && patch.admin === false) throw new Error("自分自身の管理者権限は外せません");
    Object.assign(st, patch);
    await save("staff", st);
    await audit("利用者変更", { target: id, detail: `${st.name}: ${Object.keys(patch).join(", ")}` });
  }
  async function resetUserPassword(id, tempPw) {
    need("admin");
    const err = validatePassword(tempPw);
    if (err) throw new Error(err);
    const u = await DB.get("users", id);
    const st = S.col.staff.get(id);
    u.wrap = await C.wrapDek(S.dek, tempPw); u.failed = 0; u.lockedUntil = 0;
    await DB.put("users", u);
    st.mustChange = true; st.active = true;
    await save("staff", st);
    await audit("パスワード再発行", { target: id, detail: st.name });
  }
  /** 利用停止: そのIDの「包んだ鍵」を消すので、パスワードを知っていても復号できなくなる */
  async function deactivateUser(id) {
    need("admin");
    if (id === S.user.id) throw new Error("自分自身は停止できません");
    const u = await DB.get("users", id);
    const st = S.col.staff.get(id);
    u.wrap = null;
    await DB.put("users", u);
    st.active = false;
    await save("staff", st);
    await audit("利用者停止", { target: id, detail: st.name });
  }
  async function loginInfo() { return DB.getAll("users"); }

  // ---------- 設定 ----------
  function settings() { return S.col.settings.get("settings") || defaultSettings(""); }
  async function saveSettings(patch) {
    need("admin");
    const s = Object.assign(settings(), patch);
    await save("settings", s);
    await audit("施設設定変更", { detail: Object.keys(patch).join(", ") });
  }

  // ---------- 患者 ----------
  function patients() { return Array.from(S.col.patient.values()).filter(p => !p.deleted); }
  function patient(id) { return S.col.patient.get(id); }
  function searchPatients(q) {
    const n = norm(q);
    const list = patients();
    if (!n) return list.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    const digits = n.replace(/[^0-9]/g, "");
    return list.filter(p => {
      if (norm(p.kana).includes(n) || norm(p.name).includes(n)) return true;
      if (/^\d+$/.test(n)) {
        if (p.pid.includes(n) || String(Number(p.pid)) === n) return true;
        if ((p.phone || "").replace(/\D/g, "").includes(digits) && digits.length >= 4) return true;
        if (digits.length === 8 && (p.birth || "").replace(/-/g, "") === digits) return true;
      }
      return false;
    }).sort((a, b) => norm(a.kana).localeCompare(norm(b.kana), "ja"));
  }
  const PATIENT_FIELDS = ["name", "kana", "birth", "sex", "zip", "address", "phone", "bloodType", "infection",
    "history", "familyHistory", "memo", "insurance", "allergies", "allergyNone", "emergency", "smoking", "alcohol"];
  async function savePatient(data) {
    need("patient.edit");
    if (!data.name || !data.kana || !data.birth || !data.sex) throw new Error("氏名・カナ・生年月日・性別は必須です");
    let p = data.id ? patient(data.id) : null;
    if (!p) {
      const dup = patients().find(x => norm(x.kana) === norm(data.kana) && x.birth === data.birth);
      if (dup && !data.allowDuplicate) {
        const e = new Error(`同じカナ・生年月日の患者（${dup.pid} ${dup.name}）がすでに登録されています`);
        e.duplicate = dup; throw e;
      }
      // 患者番号の払い出し（ほかの端末と同時に登録しても番号が重ならないよう、競合したらやり直す）
      let pid = null;
      for (let i = 0; i < 8 && !pid; i++) {
        const st = settings();
        const n = st.nextPid || 1;
        st.nextPid = n + 1;
        try { await save("settings", st, { silent: true }); pid = String(n).padStart(6, "0"); }
        catch (e) { if (!e.conflict) throw e; }
      }
      if (!pid) throw new Error("患者番号を払い出せませんでした。もう一度お試しください");
      p = { id: C.uid(), pid, createdAt: nowIso(), createdBy: S.user.id };
      for (const f of PATIENT_FIELDS) if (data[f] !== undefined) p[f] = data[f];
      p.updatedAt = nowIso(); p.updatedBy = S.user.id;
      await save("patient", p);
      await audit("患者登録", { patientId: p.id, detail: `${p.pid} ${p.name}` });
      return p;
    }
    const changed = PATIENT_FIELDS.filter(f => data[f] !== undefined && JSON.stringify(data[f]) !== JSON.stringify(p[f]));
    if (!changed.length) return p;
    const before = {};
    for (const f of changed) { before[f] = p[f]; p[f] = data[f]; }
    p.revisions = (p.revisions || []).concat([{ at: nowIso(), by: S.user.id, before }]);
    p.updatedAt = nowIso(); p.updatedBy = S.user.id;
    await save("patient", p);
    await audit("患者情報変更", { patientId: p.id, detail: changed.join(", ") });
    return p;
  }

  // ---------- 受付（受診） ----------
  function encounters() { return Array.from(S.col.encounter.values()); }
  function encountersOn(date) {
    return encounters().filter(e => e.date === date && e.status !== "cancelled")
      .sort((a, b) => (a.receptionAt || "").localeCompare(b.receptionAt || ""));
  }
  function encountersOf(pid) {
    return encounters().filter(e => e.patientId === pid && e.status !== "cancelled").sort((a, b) => b.date.localeCompare(a.date) || (b.receptionAt || "").localeCompare(a.receptionAt || ""));
  }
  async function receive(pid, o) {
    need("reception");
    o = o || {};
    const date = o.date || ymd();
    const exist = encounters().find(e => e.patientId === pid && e.date === date && !["cancelled", "done"].includes(e.status));
    if (exist && !o.force) { const e = new Error("この患者は本日すでに受付済みです"); e.existing = exist; throw e; }
    const prior = encounters().some(e => e.patientId === pid && e.date < date && e.status !== "cancelled");
    const todayCount = encountersOn(date).length;
    const enc = await save("encounter", {
      patientId: pid, date, dept: o.dept || settings().depts[0] || "内科",
      visitType: o.visitType || (prior ? "再診" : "初診"), status: "waiting", no: todayCount + 1,
      complaint: o.complaint || "", receptionAt: nowIso(), receptionBy: S.user.id, statusLog: [{ at: nowIso(), status: "waiting", by: S.user.id }]
    });
    await audit("受付", { patientId: pid, target: enc.id, detail: `${enc.dept} ${enc.visitType}` });
    return enc;
  }
  async function setEncStatus(enc, status, reason) {
    if (status === "done" || status === "billing") need(status === "done" ? "billing" : "reception");
    enc.status = status;
    enc.statusLog = (enc.statusLog || []).concat([{ at: nowIso(), status, by: S.user.id, reason: reason || "" }]);
    if (status === "exam" && !enc.doctorId && S.user.role === "doctor") enc.doctorId = S.user.id;
    await save("encounter", enc);
    await audit("受付状態変更", { patientId: enc.patientId, target: enc.id, detail: M.encStatus[status] + (reason ? `（${reason}）` : "") });
  }
  /** 今日の受診を探す。なければ（受付なしで記載する場合）作る */
  async function ensureTodayEncounter(pid) {
    const today = ymd();
    let enc = encounters().find(e => e.patientId === pid && e.date === today && e.status !== "cancelled");
    if (!enc) enc = await receive(pid, { complaint: "" });
    return enc;
  }

  // ---------- カルテ記事（SOAP） ----------
  // 下書き(draft)は上書き保存。確定(sign)すると版(versions)に追加され、以後の修正は理由つきの新しい版になる。
  function notesOf(pid) {
    return Array.from(S.col.note.values()).filter(n => n.patientId === pid)
      .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || "").localeCompare(a.createdAt || ""));
  }
  function noteContent(n) {
    if (n.draft) return n.draft;
    return n.versions.length ? n.versions[n.versions.length - 1].content : { S: "", O: "", A: "", P: "", vitals: {} };
  }
  function emptyContent() { return { S: "", O: "", A: "", P: "", vitals: {}, rxItems: [], rxType: "院外" }; }
  async function createNote(pid, encId, kind) {
    need("note.write");
    const n = await save("note", {
      patientId: pid, encounterId: encId, date: ymd(), kind: kind || (S.user.role === "nurse" ? "看護記録" : "診療録"),
      authorId: S.user.id, draftBy: S.user.id, createdAt: nowIso(), updatedAt: nowIso(), draft: emptyContent(), versions: []
    });
    await audit("カルテ作成", { patientId: pid, target: n.id, detail: n.kind });
    return n;
  }
  async function saveDraft(n, content) {
    need("note.write");
    if (n.deleted) throw new Error("削除済みの記事です");
    n.draft = content; n.updatedAt = nowIso(); n.draftBy = S.user.id;
    await save("note", n, { silent: true });
  }
  function canSign(n) {
    if (S.user.role === "doctor") return true;
    return S.user.role === "nurse" && n.kind === "看護記録";
  }
  async function signNote(n, reason) {
    need("note.write");
    if (!canSign(n)) throw new Error("診療録の確定は医師のみ行えます");
    if (!n.draft) throw new Error("確定する内容がありません");
    if (n.versions.length && !String(reason || "").trim()) throw new Error("確定済みの記事を修正するときは修正理由が必要です");
    const content = n.draft;
    const v = { v: n.versions.length + 1, content, signedBy: S.user.id, signedAt: nowIso(), reason: reason || "" };
    v.hash = await C.sha256hex(JSON.stringify({ prev: n.versions.length ? n.versions[n.versions.length - 1].hash : "", v: v.v, content, signedBy: v.signedBy, signedAt: v.signedAt, reason: v.reason }));
    n.versions.push(v);
    n.draft = null; n.updatedAt = nowIso();
    await save("note", n);
    await audit(v.v === 1 ? "カルテ確定" : "カルテ修正", { patientId: n.patientId, target: n.id, detail: v.v === 1 ? `${n.kind}` : `第${v.v}版: ${reason}` });
    return v;
  }
  async function editSigned(n) {
    need("note.write");
    if (n.draft) return n;
    const last = n.versions[n.versions.length - 1];
    n.draft = JSON.parse(JSON.stringify(last.content));
    n.draft.rxItems = []; // 処方は別途（発行済み処方は処方歴で取消・再発行）
    n.editBase = last.v;
    n.draftBy = S.user.id;
    await save("note", n, { silent: true });
    return n;
  }
  async function discardDraft(n) {
    if (!n.versions.length) {
      // 一度も確定していない下書きは削除扱いにする（記録は残す）
      n.deleted = { at: nowIso(), by: S.user.id, reason: "未確定の下書きを破棄" };
      n.draft = n.draft || null;
      await save("note", n);
      await audit("下書き破棄", { patientId: n.patientId, target: n.id });
      return;
    }
    n.draft = null;
    await save("note", n);
  }
  async function deleteNote(n, reason) {
    if (!String(reason || "").trim()) throw new Error("削除理由を入力してください");
    if (n.authorId !== S.user.id && !S.user.admin) throw new Error("記載者本人または管理者のみ削除できます");
    n.deleted = { at: nowIso(), by: S.user.id, reason };
    await save("note", n);
    await audit("カルテ削除", { patientId: n.patientId, target: n.id, detail: reason });
  }

  // ---------- 病名マスター ----------
  // 取り込んだ標準病名マスター（公開されている参照データなので暗号化しない）＋組み込みの病名
  async function loadDxMaster() {
    try { dxImported = (await DB.get("meta", "diseaseMaster")) || null; } catch (e) { dxImported = null; }
    if (dxImported && !(dxImported.rows && dxImported.rows.length)) dxImported = null;
    dxMerged = null;
  }
  function diseaseMaster() {
    if (dxMerged) return dxMerged;
    const imported = dxImported ? dxImported.rows.map(r => ({ name: r[0], kana: r[1], icd: r[2], src: "master" })) : [];
    const names = new Set(imported.map(d => d.name));
    dxMerged = imported.concat(M.diseases.filter(d => !names.has(d.name)));
    return dxMerged;
  }
  function dxMasterInfo() {
    return { builtin: M.diseases.length, imported: dxImported ? dxImported.rows.length : 0, source: dxImported ? dxImported.source : "", importedAt: dxImported ? dxImported.importedAt : "" };
  }
  async function importDxMaster(list, source) {
    need("admin");
    dxImported = { key: "diseaseMaster", source: String(source || "").slice(0, 200), importedAt: nowIso(), rows: list.map(d => [d.name, d.kana || "", d.icd || ""]) };
    await DB.put("meta", dxImported);
    dxMerged = null;
    await audit("病名マスター取り込み", { detail: `${source}（${list.length}件）` });
  }
  async function clearDxMaster() {
    need("admin");
    await DB.put("meta", { key: "diseaseMaster", rows: [], source: "", importedAt: "" });
    dxImported = null; dxMerged = null;
    await audit("病名マスター削除");
  }

  // ---------- 病名 ----------
  function problemsOf(pid) {
    return Array.from(S.col.problem.values()).filter(p => p.patientId === pid && !p.deleted)
      .sort((a, b) => (a.outcome === "継続" ? 0 : 1) - (b.outcome === "継続" ? 0 : 1) || (b.main ? 1 : 0) - (a.main ? 1 : 0) || b.start.localeCompare(a.start));
  }
  const SIDES = ["左", "右", "両側"];
  /** 表示用の病名（部位＋病名＋疑い）。病名そのものはマスターのまま保存し、部位は別に持つ */
  function problemLabel(p, short) {
    return `${p.side || ""}${p.name}${p.suspected ? (short ? "(疑)" : "（疑い）") : ""}`;
  }
  async function saveProblem(pid, data) {
    need("problem.edit");
    if (!data.name || !data.start) throw new Error("病名と開始日は必須です");
    const old = data.id ? S.col.problem.get(data.id) : null;
    const p = old || { patientId: pid, createdAt: nowIso(), createdBy: S.user.id, log: [] };
    const before = old ? { name: old.name, side: old.side || "", suspected: old.suspected, main: old.main, start: old.start, end: old.end, outcome: old.outcome } : null;
    const side = SIDES.includes(data.side) ? data.side : "";
    Object.assign(p, {
      name: data.name.trim(), side, icd: data.icd || "", suspected: !!data.suspected, main: !!data.main,
      start: data.start, end: data.outcome === "継続" ? "" : (data.end || ymd()), outcome: data.outcome || "継続", comment: data.comment || ""
    });
    p.log.push({ at: nowIso(), by: S.user.id, before });
    await save("problem", p);
    const label = problemLabel(p);
    await audit(old ? "病名変更" : "病名登録", { patientId: pid, target: p.id, detail: old ? `${label} → ${p.outcome}` : label });
    return p;
  }
  async function deleteProblem(p, reason) {
    need("problem.edit");
    p.deleted = { at: nowIso(), by: S.user.id, reason: reason || "" };
    await save("problem", p);
    await audit("病名削除", { patientId: p.patientId, target: p.id, detail: `${p.name}: ${reason || ""}` });
  }

  // ---------- 処方 ----------
  function rxOf(pid) {
    return Array.from(S.col.rx.values()).filter(r => r.patientId === pid)
      .sort((a, b) => b.date.localeCompare(a.date) || (b.issuedAt || "").localeCompare(a.issuedAt || ""));
  }
  function lastActiveRx(pid) { return rxOf(pid).find(r => r.status === "issued"); }
  function itemQtyText(it) {
    const q = Number(it.qty);
    if (it.kind === "internal") {
      const u = M.usages.internal.find(x => x.label === it.usage);
      const per = u ? u.per : 1;
      return `1回${q}${it.unit}（1日${+(q * per).toFixed(2)}${it.unit}）　${it.usage}　${it.days}日分`;
    }
    if (it.kind === "prn") return `1回${q}${it.unit}　${it.usage}　${it.days}回分`;
    return `${q}${it.unit}　${it.usage}`;
  }
  function validateItems(items) {
    if (!items.length) throw new Error("薬が入っていません");
    for (const it of items) {
      if (!it.name) throw new Error("薬品名が空の行があります");
      if (!(Number(it.qty) > 0)) throw new Error(`${it.name}: 数量を入力してください`);
      if (it.kind !== "external" && !(Number(it.days) > 0)) throw new Error(`${it.name}: 日数（回数）を入力してください`);
      if (!it.usage) throw new Error(`${it.name}: 用法を入力してください`);
      if (it.kind === "internal" && Number(it.days) > 90) throw new Error(`${it.name}: 日数が90日を超えています（確認してください）`);
    }
  }
  /** 処方チェック: アレルギー・同効薬重複・相互作用 */
  function checkRx(p, items) {
    const out = [];
    const clsOf = it => {
      const d = M.drugs.find(x => x.name === it.name);
      return d ? d.cls : (it.cls || []);
    };
    const keyOf = it => { const d = M.drugs.find(x => x.name === it.name); return d ? d.key : it.name; };
    const aliasesOf = it => { const d = M.drugs.find(x => x.name === it.name); return d ? d.aliases : []; };
    for (const al of (p.allergies || [])) {
      const sub = norm(al.substance);
      if (!sub) continue;
      for (const it of items) {
        const cls = clsOf(it).map(norm);
        const names = [norm(it.name), norm(keyOf(it))].concat(aliasesOf(it).map(norm));
        const clsHit = cls.some(c => c && (c.includes(sub) || sub.includes(c.replace(/系$|薬$/, ""))));
        const nameHit = names.some(nm => nm && (nm.includes(sub) || sub.includes(nm)));
        const aspAsthma = /アスピリン喘息|nsaids過敏/.test(sub) && clsOf(it).some(c => c.startsWith("NSAIDs") || c === "抗血小板薬");
        if (clsHit || nameHit || aspAsthma) out.push({ level: "danger", msg: `アレルギー: ${it.name} ←「${al.substance}」${al.reaction ? "（" + al.reaction + "）" : ""}` });
      }
    }
    for (const dc of M.dupClasses) {
      const hits = items.filter(it => clsOf(it).includes(dc));
      const uniq = Array.from(new Set(hits.map(keyOf)));
      if (uniq.length > 1) out.push({ level: "warn", msg: `同効薬の重複（${dc}）: ${hits.map(h => h.name).join("、")}` });
      else if (hits.length > 1 && hits.some(h => h.kind === "internal") && hits.some(h => h.kind === "prn")) out.push({ level: "warn", msg: `定時と頓用の重複（${dc}）: ${hits.map(h => h.name).join("、")}` });
    }
    for (const ia of M.interactions) {
      const A = items.filter(it => clsOf(it).includes(ia.a)), B = items.filter(it => clsOf(it).includes(ia.b));
      if (A.length && B.length) out.push({ level: "warn", msg: `相互作用: ${A[0].name} × ${B[0].name} — ${ia.msg}` });
    }
    const a = age(p.birth);
    if (a !== null && a >= 75 && items.some(it => clsOf(it).includes("睡眠薬") || clsOf(it).includes("NSAIDs"))) {
      out.push({ level: "info", msg: "75歳以上: 睡眠薬・NSAIDs は高齢者で特に慎重な投与が必要です" });
    }
    return out;
  }
  async function issueRx(pid, encId, items, rxType, noteId) {
    need("rx.issue");
    validateItems(items);
    const rx = await save("rx", {
      patientId: pid, encounterId: encId, noteId: noteId || null, date: ymd(), type: rxType || "院外",
      items: items.map(it => ({ name: it.name, kind: it.kind, unit: it.unit, qty: Number(it.qty), usage: it.usage, days: Number(it.days) || 0, comment: it.comment || "", generic: it.generic !== false })),
      status: "issued", issuedBy: S.user.id, issuedAt: nowIso()
    });
    await audit("処方発行", { patientId: pid, target: rx.id, detail: rx.items.map(i => i.name).join("、") });
    return rx;
  }
  async function cancelRx(rx, reason) {
    need("rx.issue");
    if (!String(reason || "").trim()) throw new Error("取消理由を入力してください");
    rx.status = "cancelled"; rx.cancelled = { at: nowIso(), by: S.user.id, reason };
    await save("rx", rx);
    await audit("処方取消", { patientId: rx.patientId, target: rx.id, detail: reason });
  }

  // ---------- 検査 ----------
  function labsOf(pid) {
    return Array.from(S.col.lab.values()).filter(l => l.patientId === pid && !l.deleted).sort((a, b) => a.date.localeCompare(b.date));
  }
  function labRef(def, sex) {
    if (def.ref) return def.ref;
    return sex === "F" ? def.refF : def.refM;
  }
  function eGFR(cr, ageY, sex) {
    if (!(cr > 0) || !(ageY >= 18)) return null;
    let v = 194 * Math.pow(cr, -1.094) * Math.pow(ageY, -0.287);
    if (sex === "F") v *= 0.739;
    return Math.round(v * 10) / 10;
  }
  function labValues(l, p) {
    const vals = Object.assign({}, l.values);
    if (vals.Cr !== undefined && vals.Cr !== "" && vals.eGFR === undefined) {
      const v = eGFR(Number(vals.Cr), age(p.birth, l.date), p.sex);
      if (v !== null) vals.eGFR = v;
    }
    return vals;
  }
  function labFlag(def, v, sex) {
    const r = labRef(def, sex);
    if (!r || v === "" || v === undefined || v === null || isNaN(Number(v))) return "";
    if (r[0] !== null && Number(v) < r[0]) return "L";
    if (r[1] !== null && Number(v) > r[1]) return "H";
    return "";
  }
  async function saveLab(pid, data) {
    need("lab.enter");
    const values = {};
    for (const [k, v] of Object.entries(data.values || {})) if (v !== "" && v !== null && v !== undefined) {
      if (isNaN(Number(v))) throw new Error(`${k}: 数値で入力してください`);
      values[k] = Number(v);
    }
    if (!Object.keys(values).length) throw new Error("値が1つも入力されていません");
    const l = await save("lab", { patientId: pid, date: data.date || ymd(), values, comment: data.comment || "", enteredBy: S.user.id, enteredAt: nowIso() });
    await audit("検査結果登録", { patientId: pid, target: l.id, detail: `${l.date} ${Object.keys(values).join(",")}` });
    return l;
  }
  async function deleteLab(l, reason) {
    need("lab.enter");
    l.deleted = { at: nowIso(), by: S.user.id, reason: reason || "" };
    await save("lab", l);
    await audit("検査結果削除", { patientId: l.patientId, target: l.id, detail: `${l.date}: ${reason || ""}` });
  }

  // ---------- 文書 ----------
  function docsOf(pid) {
    return Array.from(S.col.doc.values()).filter(d => d.patientId === pid && !d.deleted).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function saveDoc(pid, data) {
    need("doc.write");
    const d = data.id ? Object.assign(S.col.doc.get(data.id), data) : Object.assign({ patientId: pid, createdAt: nowIso(), createdBy: S.user.id }, data);
    d.updatedAt = nowIso();
    await save("doc", d);
    await audit(data.id ? "文書変更" : "文書作成", { patientId: pid, target: d.id, detail: d.kind });
    return d;
  }

  // ---------- バックアップ ----------
  async function exportBackup() {
    need("admin");
    await audit("バックアップ出力");
    await S.q;
    const dump = await DB.dumpAll();
    await DB.put("meta", { key: "lastBackup", at: nowIso() });
    return { format: "emr-local-backup", version: 1, exportedAt: nowIso(), clinic: settings().clinicName, ...dump };
  }
  async function lastBackup() { const m = await DB.get("meta", "lastBackup"); return m ? m.at : null; }
  async function importBackup(obj) {
    if (!obj || obj.format !== "emr-local-backup" || !Array.isArray(obj.records) || !Array.isArray(obj.users)) throw new Error("バックアップファイルの形式が正しくありません");
    if (DB.mode === "server") {
      // 院内サーバーの鍵が変わらないよう、同じ医療機関（同じ初期設定）のバックアップだけを受け付ける
      const sample = obj.records.find(r => r.type === "settings") || obj.records[0];
      if (sample) {
        try { await C.decryptJson(S.dek, sample, aad(sample.type, sample.id)); }
        catch (e) { throw new Error("別の医療機関（または別に初期設定した電子カルテ）のバックアップのため、院内サーバーには復元できません"); }
      }
    }
    await DB.replaceAll(obj);
    clearSession();
  }

  function staffName(id) { const s = S.col.staff.get(id); return s ? s.name : "（不明）"; }
  function staffList() { return Array.from(S.col.staff.values()); }

  g.EMRStore = {
    S, TYPES, ymd, nowIso, addDays, age, norm, onChange, emit,
    hasUsers, setup, setupFromBackup, login, logout, clearSession, changePassword, validatePassword,
    can, need, createUser, updateUser, resetUserPassword, deactivateUser, loginInfo, staffName, staffList,
    settings, saveSettings, audit, verifyAudit,
    patients, patient, searchPatients, savePatient,
    encounters, encountersOn, encountersOf, receive, setEncStatus, ensureTodayEncounter,
    notesOf, noteContent, emptyContent, createNote, saveDraft, canSign, signNote, editSigned, discardDraft, deleteNote,
    problemsOf, saveProblem, deleteProblem, problemLabel, SIDES, diseaseMaster, dxMasterInfo, importDxMaster, clearDxMaster, loadDxMaster,
    rxOf, lastActiveRx, itemQtyText, validateItems, checkRx, issueRx, cancelRx,
    labsOf, labRef, labValues, labFlag, eGFR, saveLab, deleteLab,
    docsOf, saveDoc, exportBackup, importBackup, lastBackup, save
  };
})(window);
