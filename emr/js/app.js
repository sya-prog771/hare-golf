/* 画面（ログイン・受付・患者検索・カルテ・管理・監査ログ） */
(function () {
  "use strict";
  const ST = window.EMRStore, U = window.EMRUI, M = window.EMRMaster, PR = window.EMRPrint, CH = window.EMRCharts;
  const h = U.h;
  const root = document.getElementById("app");

  let shell = null;            // { main, nav, header }
  let flushers = new Set();    // 未保存の下書きを書き出す関数
  let lastViewedPid = null;
  let lastActivity = Date.now();
  let idleTimer = null;
  let receptionTimer = null;
  let lockMessage = "";

  // ---------- 共通 ----------
  const inp = a => h("input", Object.assign({ class: "input", type: "text" }, a));
  const ta = a => h("textarea", Object.assign({ class: "input", rows: 3 }, a));
  function sel(options, value, a) {
    return h("select", Object.assign({ class: "input" }, a), options.map(o => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return h("option", { value: v, selected: String(v) === String(value ?? "") }, l);
    }));
  }
  function field(label, control, o) {
    o = o || {};
    return h("label", { class: "field " + (o.cls || "") }, h("span", null, label, o.req ? h("em", { "aria-hidden": "true" }, " *") : null), control, o.hint ? h("small", { class: "muted" }, o.hint) : null);
  }
  async function act(fn, okMsg) {
    try { const r = await fn(); if (okMsg) U.toast(okMsg, "ok"); return r; }
    catch (e) { console.error(e); U.toast(e.message || String(e), "error"); return undefined; }
  }
  async function flushAll() { for (const f of Array.from(flushers)) { try { await f(); } catch (e) { console.error(e); } } }
  function ageText(birth, at) {
    const a = ST.age(birth, at);
    if (a === null) return "";
    if (a >= 1) return a + "歳";
    const b = new Date(birth + "T00:00:00"), n = at ? new Date(at + "T00:00:00") : new Date();
    const m = (n.getFullYear() - b.getFullYear()) * 12 + n.getMonth() - b.getMonth() - (n.getDate() < b.getDate() ? 1 : 0);
    return `${Math.max(m, 0)}か月`;
  }
  function badge(text, cls, title) { return h("span", { class: "badge " + (cls || ""), title: title || null }, text); }
  function allergyBadges(p) {
    if (p.allergies && p.allergies.length) return p.allergies.map(a => badge(`⚠ ${a.substance}`, "danger", `${a.reaction || ""} ${a.severity || ""}`.trim() || null));
    return p.allergyNone ? [badge("アレルギーなし", "ok")] : [badge("アレルギー未確認", "warn")];
  }
  function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

  // ---------- スマホ向け ----------
  const SVGNS = "http://www.w3.org/2000/svg";
  const ICONS = {
    reception: ["M8 4h8v3H8z", "M6 5H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-1", "M8 12h8", "M8 16h5"],
    search: ["M11 4a7 7 0 1 1 0 14a7 7 0 1 1 0-14z", "M16.5 16.5L21 21"],
    add: ["M9 4a4 4 0 1 1 0 8a4 4 0 1 1 0-8z", "M2 21c0-4 3-6 7-6s7 2 7 6", "M19 8v6", "M16 11h6"],
    menu: ["M4 7h16", "M4 12h16", "M4 17h16"]
  };
  function icon(name) {
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("class", "ico");
    for (const d of ICONS[name]) { const p = document.createElementNS(SVGNS, "path"); p.setAttribute("d", d); svg.appendChild(p); }
    return svg;
  }
  // お試し版（<meta name="emr-trial">）: 実データを入れないよう表示し、インストール案内などは出さない
  const TRIAL = !!document.querySelector('meta[name="emr-trial"]');
  const isStandalone = () => (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const isPhoneLike = () => (window.matchMedia && matchMedia("(max-width: 900px)").matches) && (navigator.maxTouchPoints > 0 || "ontouchstart" in window);
  let installPrompt = null;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; document.querySelectorAll(".install-banner").forEach(b => b.replaceWith(installBanner(true) || "")); });

  /** ホーム画面に追加（アプリとしてインストール）の案内 */
  function installBanner(force, compact) {
    if (TRIAL || !isPhoneLike() || isStandalone()) return null;
    if (!window.isSecureContext || !("serviceWorker" in navigator)) return null; // 院内LAN(http)では追加できない
    let dismissed = false;
    try { dismissed = localStorage.getItem("emr-install-dismissed") === "1"; } catch (e) { /* noop */ }
    if (dismissed && !force) return null;
    const close = h("button", { type: "button", class: "icon-btn", "aria-label": "閉じる", onclick: e => { try { localStorage.setItem("emr-install-dismissed", "1"); } catch (x) { /* noop */ } e.target.closest(".install-banner").remove(); } }, "×");
    let body;
    if (isIOS()) {
      body = [h("p", null, h("b", null, "ホーム画面に追加すると、アプリとして電波がなくても使えます。")),
        h("ol", null, h("li", null, "画面下（iPad は上）の ", h("b", null, "共有ボタン（□に↑）"), " を押す"), h("li", null, "「", h("b", null, "ホーム画面に追加"), "」→「追加」"), h("li", null, "ホーム画面にできた ", h("b", null, "電子カルテ"), " のアイコンから開く")),
        h("p", { class: "small" }, "⚠ iPhone・iPad では、Safari のまま入力したデータは、ホーム画面のアプリからは見えません。", h("b", null, "先に追加してから、アイコンで開いて初期設定"), "してください。")];
    } else if (installPrompt) {
      body = [h("p", null, h("b", null, "アプリとしてインストールすると、電波がなくても使えます。")),
        h("button", { type: "button", class: "btn primary", onclick: async () => { installPrompt.prompt(); try { await installPrompt.userChoice; } catch (e) { /* noop */ } installPrompt = null; document.querySelectorAll(".install-banner").forEach(b => b.remove()); } }, "アプリとしてインストール")];
    } else {
      body = [h("p", null, h("b", null, "ホーム画面に追加すると、アプリとして電波がなくても使えます。")),
        h("p", null, "ブラウザ右上の ", h("b", null, "︙"), " →「", h("b", null, "アプリをインストール"), "」または「", h("b", null, "ホーム画面に追加"), "」")];
    }
    if (compact) body = [h("details", null, h("summary", null, h("b", null, "ホーム画面に追加すると、アプリとして電波がなくても使えます")), body.slice(1))];
    return h("div", { class: "install-banner" + (compact ? " compact" : ""), role: "note" }, h("img", { src: "icons/icon-192.png", alt: "", width: compact ? 28 : 44, height: compact ? 28 : 44 }), h("div", { class: "ib-body" }, body), close);
  }

  function registerSW() {
    if (TRIAL) return;
    if (!("serviceWorker" in navigator) || !window.isSecureContext || !/^https?:$/.test(location.protocol)) return;
    navigator.serviceWorker.register("sw.js").catch(e => console.warn("オフライン用の保存に失敗", e));
  }

  // ---------- 起動 ----------
  const DB = window.EMRDB;
  async function boot() {
    let info = null;
    try { info = await DB.init(); } catch (e) { /* ローカル版として続ける */ }
    if (!window.EMRCrypto.available || (DB.mode === "local" && !window.indexedDB)) {
      root.appendChild(h("div", { class: "center-card" }, h("h1", null, "電子カルテ"),
        h("p", null, "このブラウザでは必要な機能（乱数またはデータベース）が使えません。"),
        h("p", null, "最新の Chrome / Edge / Firefox / Safari で開いてください。")));
      return;
    }
    DB.onStatus(updateConn);
    registerSW();
    if (TRIAL) document.body.insertBefore(h("div", { class: "trial-bar", role: "note" }, h("b", null, "お試し版"), "　架空のデータで操作を試すためのページです。実在の患者さんの情報は入力しないでください。印刷・バックアップの書き出しは、このページでは動きません。"), root);
    // ローカル版は、同時に2つのタブで開くとデータが食い違うので、1タブに限定する
    if (DB.mode === "local" && navigator.locks && navigator.locks.request) {
      let got = false;
      navigator.locks.request("emr-single-tab", { ifAvailable: true }, lock => {
        if (!lock) return null;
        got = true;
        return new Promise(() => { }); // タブを閉じるまで保持
      });
      await new Promise(r => setTimeout(r, 60));
      if (!got) {
        root.appendChild(h("div", { class: "center-card" }, h("h1", null, "電子カルテ"),
          h("p", null, "別のタブ（またはウィンドウ）ですでに開いています。"),
          h("p", { class: "muted" }, "記録の食い違いを防ぐため、同じブラウザでは1つのタブでのみ使えます。そちらを使うか、閉じてからこのページを再読み込みしてください。"),
          h("button", { class: "btn primary", onclick: () => location.reload() }, "再読み込み")));
        return;
      }
    }
    let has;
    try { has = await ST.hasUsers(); }
    catch (e) { root.appendChild(h("div", { class: "center-card" }, h("h1", null, "電子カルテ"), h("p", { class: "danger-text" }, e.message), h("button", { class: "btn primary", onclick: () => location.reload() }, "再読み込み"))); return; }
    if (has) renderLogin(); else renderSetup();
    void info;
  }

  // ---------- 院内サーバーとの接続状態 ----------
  function connBadge() {
    if (DB.mode !== "server") return h("span", { class: "conn local", title: "データはこの端末のブラウザ内にだけ保存されています" }, "この端末のみ");
    const on = DB.status !== "offline";
    return h("span", { class: "conn " + (on ? "on" : "off"), role: "status", title: on ? "院内サーバー（親機）とつながっています" : "院内サーバー（親機）につながりません" }, on ? "院内サーバー接続中" : "サーバー未接続・再接続中…");
  }
  function updateConn() {
    const old = document.querySelector(".topbar .conn");
    if (old) old.replaceWith(connBadge());
    const bar = document.getElementById("offline-bar");
    if (DB.mode === "server" && DB.status === "offline" && ST.S.user) {
      if (!bar) root.prepend(h("div", { id: "offline-bar", role: "alert" }, "⚠ 院内サーバー（親機）につながりません。親機のパソコンと黒い画面が起動しているか、この端末が院内の Wi-Fi につながっているか確認してください。つながると自動で再開します（入力中の内容は消えません）。"));
    } else if (bar) {
      bar.remove();
      if (ST.S.user) { flushAll(); DB.sync().catch(() => { }); }
    }
  }

  // ほかの端末で変更があったら、入力の邪魔にならないタイミングで画面を更新する
  let remotePending = false;
  ST.onChange(t => {
    if (t === "remote") { remotePending = true; tryRemoteRender(); }
    if (t === "reset" && ST.S.user) { ST.clearSession(); lockMessage = "管理者がバックアップからデータを復元しました。もう一度ログインしてください。"; renderLogin(); }
    if (t === "revoked" && ST.S.user) { ST.clearSession(); lockMessage = "このIDは管理者によって利用停止されました。"; renderLogin(); }
  });
  function tryRemoteRender() {
    if (!remotePending || !ST.S.user || !shell) return;
    const a = document.activeElement;
    const typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && shell.main.contains(a);
    // 入力途中のフォーム（data-dirty）があるときは、書きかけを消さないよう自動更新しない
    if (document.querySelector(".modal-back") || typing || shell.main.querySelector("form[data-dirty]")) return;
    remotePending = false;
    render();
  }
  setInterval(tryRemoteRender, 1500);

  // ---------- 初期設定 ----------
  function renderSetup() {
    U.clear(root); shell = null;
    const f = {
      clinic: inp({ placeholder: "例: さくら内科クリニック", autocomplete: "organization" }),
      loginId: inp({ placeholder: "半角英数字（例: dr.yamada）", autocomplete: "username" }),
      name: inp({ placeholder: "例: 山田 太郎", autocomplete: "name" }),
      pw: inp({ type: "password", autocomplete: "new-password" }),
      pw2: inp({ type: "password", autocomplete: "new-password" }),
      demo: h("input", { type: "checkbox", checked: true })
    };
    const err = h("div", { class: "form-err", role: "alert" });
    const btn = h("button", { class: "btn primary big", type: "submit" }, "はじめる");
    const form = h("form", {
      class: "center-card", onsubmit: async e => {
        e.preventDefault(); err.textContent = "";
        try {
          if (!f.clinic.value.trim() || !f.loginId.value.trim() || !f.name.value.trim()) throw new Error("すべての項目を入力してください");
          if (!/^[A-Za-z0-9_.-]{3,32}$/.test(f.loginId.value.trim())) throw new Error("ログインIDは半角英数字3〜32文字にしてください");
          if (f.pw.value !== f.pw2.value) throw new Error("確認用パスワードが一致しません");
          btn.disabled = true; btn.textContent = "暗号鍵を作成中…";
          await ST.setup({ clinicName: f.clinic.value.trim(), loginId: f.loginId.value.trim(), name: f.name.value.trim(), password: f.pw.value });
          let creds = null;
          if (f.demo.checked) { btn.textContent = "デモデータを作成中…"; creds = await window.EMRDemo.seed(); }
          await afterLogin();
          if (creds) {
            await U.modal("デモ用の利用者を作成しました", h("div", null,
              h("p", null, "看護師・医療事務の画面を試すためのIDです。初期パスワードは今回だけ表示されます（初回ログイン時に変更を求められます）。"),
              h("table", { class: "tbl" }, h("thead", null, h("tr", null, h("th", null, "職種"), h("th", null, "ログインID"), h("th", null, "初期パスワード"))),
                h("tbody", null, creds.map(c => h("tr", null, h("td", null, M.roles[c.role]), h("td", null, h("code", null, c.loginId)), h("td", null, h("code", null, c.pw))))))
            ), [{ label: "確認しました", cls: "primary", value: true }]);
          }
        } catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.textContent = "はじめる"; }
      }
    },
      h("h1", null, DB.mode === "server" ? "電子カルテ 初期設定（院内サーバー）" : "電子カルテ 初期設定"),
      h("p", { class: "muted" }, DB.mode === "server"
        ? "最初に、医療機関名と管理者（医師）のアカウントを作ります。データは院内サーバー（親機）に暗号化して保存され、院内の端末からだけ使えます。インターネットには送信されません。"
        : "最初に、医療機関名と管理者（医師）のアカウントを作ります。データはこの端末のブラウザ内に暗号化して保存され、外部には送信されません。"),
      DB.mode === "server" ? h("p", { class: "small" }, "「この端末だけで使う版」ですでに使っている場合は ", h("button", { type: "button", class: "linkish", onclick: () => migrateDialog() }, "そのデータを引き継ぐ"), "（バックアップファイルから移行）") : null,
      field("医療機関名", f.clinic, { req: true }),
      h("div", { class: "grid2" }, field("ログインID", f.loginId, { req: true }), field("氏名", f.name, { req: true })),
      h("div", { class: "grid2" }, field("パスワード（8文字以上）", f.pw, { req: true }), field("パスワード（確認）", f.pw2, { req: true })),
      h("p", { class: "notice" }, "パスワードを忘れると、ほかの管理者がいない限りデータを復元できません。必ず控えを安全な場所に保管してください。"),
      h("label", { class: "check" }, f.demo, " 操作を試すためのデモデータ（架空の患者4名）を入れる"),
      err, btn);
    const ib = installBanner(true);
    if (ib) root.appendChild(ib);
    root.appendChild(form);
    if (!isPhoneLike()) f.clinic.focus();
  }

  async function migrateDialog() {
    const file = h("input", { type: "file", accept: ".json,application/json", class: "input" });
    const id = inp({ autocomplete: "off" }), pw = inp({ type: "password", autocomplete: "off" });
    const ok = await U.modal("ローカル版のデータを引き継ぐ", h("div", null,
      h("ol", { class: "steps-mini" },
        h("li", null, "これまで使っていた端末で、管理 → 「バックアップを書き出す」を押してファイルを保存"),
        h("li", null, "そのファイル（emr-backup-….json）をこのパソコンにコピー（USBメモリなど）"),
        h("li", null, "下で選んで、そのときのログインIDとパスワードを入力")),
      field("バックアップファイル", file), h("div", { class: "grid2" }, field("ログインID", id), field("パスワード", pw))
    ), [{ label: "キャンセル", value: null }, {
      label: "引き継ぐ", cls: "primary", onClick: async () => {
        if (!file.files[0]) throw new Error("ファイルを選んでください");
        let obj;
        try { obj = JSON.parse(await file.files[0].text()); } catch (e) { throw new Error("ファイルを読み込めませんでした"); }
        await ST.setupFromBackup(obj, id.value, pw.value);
        return true;
      }
    }]);
    if (ok) { U.toast("データを引き継ぎました", "ok"); await afterLogin(); }
  }

  // ---------- ログイン ----------
  function renderLogin() {
    U.clear(root); shell = null;
    stopTimers();
    const id = inp({ autocomplete: "username", autocapitalize: "off", spellcheck: "false" });
    const pw = inp({ type: "password", autocomplete: "current-password" });
    const err = h("div", { class: "form-err", role: "alert" }, lockMessage);
    lockMessage = "";
    const btn = h("button", { class: "btn primary big", type: "submit" }, "ログイン");
    const form = h("form", {
      class: "center-card narrow", onsubmit: async e => {
        e.preventDefault(); err.textContent = "";
        btn.disabled = true; btn.textContent = "確認中…";
        try { await ST.login(id.value, pw.value); await afterLogin(); }
        catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.textContent = "ログイン"; pw.value = ""; pw.focus(); }
      }
    },
      h("div", { class: "logo", "aria-hidden": "true" }, "✚"),
      h("h1", null, "電子カルテ"),
      field("ログインID", id), field("パスワード", pw), err, btn,
      h("p", { class: "muted small" }, "共用端末では、離席時に必ずロックまたはログアウトしてください。"),
      h("p", { class: "muted small login-mode" }, DB.mode === "server"
        ? ["院内サーバーに接続しています（", location.host, "）　", h("a", { href: "guide.html", target: "_blank", rel: "noopener" }, "接続ガイド")]
        : "この端末だけで使う版（データはこのブラウザ内に保存）"));
    const ib = installBanner();
    if (ib) root.appendChild(ib);
    root.appendChild(form);
    if (!isPhoneLike()) id.focus();
  }

  async function afterLogin() {
    buildShell();
    startTimers();
    if (ST.S.corrupted) U.toast(`復号できないレコードが ${ST.S.corrupted} 件あります。管理者に連絡してください。`, "error");
    if (ST.S.user.mustChange) await passwordDialog(true);
    const resume = lockedBy && lockedBy === ST.S.user.id;
    lockedBy = null;
    if (!resume || !location.hash || location.hash === "#/") history.replaceState(null, "", "#/reception");
    render();
  }

  async function passwordDialog(forced) {
    const cur = inp({ type: "password", autocomplete: "current-password" });
    const nw = inp({ type: "password", autocomplete: "new-password" });
    const nw2 = inp({ type: "password", autocomplete: "new-password" });
    return U.modal(forced ? "パスワードを変更してください" : "パスワード変更", h("div", null,
      forced ? h("p", null, "初期パスワードのままです。ご自身だけが知るパスワードに変更してください。") : null,
      field(forced ? "初期パスワード" : "現在のパスワード", cur), field("新しいパスワード（8文字以上）", nw), field("新しいパスワード（確認）", nw2)
    ), (forced ? [] : [{ label: "キャンセル", value: null }]).concat([{
      label: "変更する", cls: "primary", onClick: async () => {
        if (nw.value !== nw2.value) throw new Error("確認用パスワードが一致しません");
        await ST.changePassword(cur.value, nw.value);
        U.toast("パスワードを変更しました", "ok");
        return true;
      }
    }]), { sticky: forced });
  }

  // ロック後に同じ人が再ログインしたときだけ、元の画面に戻す（別の人には前の患者を見せない）
  let lockedBy = null;
  async function doLogout(reason, msg, keepPlace) {
    await flushAll();
    lockedBy = keepPlace && ST.S.user ? ST.S.user.id : null;
    await ST.logout(reason);
    lockMessage = msg || "";
    lastViewedPid = null;
    if (!keepPlace) history.replaceState(null, "", location.pathname + location.search);
    renderLogin();
  }

  // ---------- 自動ロック ----------
  function startTimers() {
    stopTimers();
    lastActivity = Date.now();
    idleTimer = setInterval(checkIdle, 10000);
  }
  function checkIdle() {
    const min = ST.S.user ? Number(ST.settings().autoLockMin) || 0 : 0;
    if (min > 0 && Date.now() - lastActivity > min * 60000) {
      doLogout("一定時間操作がなかったため自動ロック", `${min}分間操作がなかったため、自動的にロックしました。`, true);
    }
  }
  // スマホはアプリを裏に回すとタイマーが止まるので、戻ってきた瞬間に確認する（画面にカルテが見えないうちにロック）
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkIdle(); });
  function stopTimers() { clearInterval(idleTimer); clearInterval(receptionTimer); idleTimer = receptionTimer = null; }
  ["pointerdown", "keydown", "wheel", "touchstart"].forEach(ev => window.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true, capture: true }));
  window.addEventListener("beforeunload", e => {
    if (ST.S.user && Array.from(flushers).length) { flushAll(); }
  });

  // ---------- 外枠 ----------
  function buildShell() {
    U.clear(root);
    const s = ST.settings(), u = ST.S.user;
    const navItems = [
      ["#/reception", "受付一覧", "reception"],
      ["#/patients", "患者検索", null],
      ["#/new", "新規患者登録", "patient.edit"],
      ["#/admin", "管理", "admin"],
      ["#/audit", "監査ログ", "admin"]
    ].filter(x => !x[2] || ST.can(x[2]));
    const nav = h("nav", { class: "nav", "aria-label": "メインメニュー" }, navItems.map(([href, label]) => h("a", { href }, label)));
    const quick = inp({ type: "search", placeholder: "患者検索（カナ・ID・生年月日）  /", "aria-label": "患者検索", class: "input quick" });
    quick.addEventListener("keydown", e => { if (e.key === "Enter") { go("#/patients?q=" + encodeURIComponent(quick.value)); quick.value = ""; quick.blur(); } });
    const header = h("header", { class: "topbar" },
      h("div", { class: "brand" }, h("span", { class: "logo-s", "aria-hidden": "true" }, "✚"), h("span", null, s.clinicName || "電子カルテ")),
      quick,
      h("div", { class: "who" },
        connBadge(),
        h("span", { class: "today" }, U.jdateW(ST.ymd())),
        h("span", { class: "user" }, u.name, h("small", null, `（${M.roles[u.role]}${u.admin ? "・管理者" : ""}）`)),
        h("button", { class: "btn ghost sm", onclick: () => passwordDialog(false) }, "パスワード"),
        h("button", { class: "btn ghost sm", title: "画面をロックして離席（Ctrl+L）", onclick: () => doLogout("ロック", "ロックしました。再開するにはログインしてください。", true) }, "ロック"),
        h("button", { class: "btn ghost sm", onclick: () => doLogout("ログアウト") }, "ログアウト")));
    header.appendChild(h("button", { type: "button", class: "menu-btn", "aria-label": "メニュー", onclick: () => menuSheet() }, icon("menu")));
    const main = h("main", { class: "main", id: "main", tabindex: "-1" });
    const tabs = [["#/reception", "受付", "reception", "reception"], ["#/patients", "患者", "search", null], ["#/new", "新規登録", "add", "patient.edit"]]
      .filter(x => !x[3] || ST.can(x[3]));
    const tabbar = h("nav", { class: "tabbar", "aria-label": "メインメニュー（スマホ）" },
      tabs.map(([href, label, ic]) => h("a", { href }, icon(ic), h("span", null, label))),
      h("button", { type: "button", onclick: () => menuSheet() }, icon("menu"), h("span", null, "メニュー")));
    root.append(header, h("div", { class: "body" }, nav, main), tabbar);
    shell = { main, nav, header, quick, tabbar };
  }

  /** スマホのメニュー（利用者・接続状態・管理・ロックなど） */
  function menuSheet() {
    const u = ST.S.user;
    const item = (label, fn, cls) => h("button", { type: "button", class: "sheet-item " + (cls || ""), onclick: () => { document.querySelector(".modal-back .icon-btn").click(); setTimeout(fn, 0); } }, label);
    U.modal("メニュー", h("div", { class: "sheet-list" },
      h("div", { class: "sheet-user" }, h("b", null, u.name), h("span", { class: "muted" }, `${M.roles[u.role]}${u.admin ? "・管理者" : ""}`), connBadge(), h("span", { class: "muted small" }, U.jdateW(ST.ymd()))),
      ST.can("admin") ? item("管理（利用者・設定・バックアップ）", () => go("#/admin")) : null,
      ST.can("admin") ? item("監査ログ", () => go("#/audit")) : null,
      item("パスワード変更", () => passwordDialog(false)),
      item("ロック（離席するとき）", () => doLogout("ロック", "ロックしました。再開するにはログインしてください。", true), "strong"),
      item("ログアウト", () => doLogout("ログアウト"))
    ), [], { cls: "sheet" });
  }

  document.addEventListener("keydown", e => {
    if (!shell) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if (e.key === "/" && !typing && !document.querySelector(".modal-back")) { e.preventDefault(); shell.quick.focus(); }
    if (e.ctrlKey && (e.key === "l" || e.key === "L")) { e.preventDefault(); doLogout("ロック", "ロックしました。再開するにはログインしてください。", true); }
  });

  // ---------- ルーティング ----------
  function parseRoute() {
    const raw = location.hash.replace(/^#\/?/, "");
    const [path, qs] = raw.split("?");
    const parts = path.split("/").filter(Boolean);
    const q = new URLSearchParams(qs || "");
    return { name: parts[0] || "reception", id: parts[1], tab: parts[2], q };
  }
  window.addEventListener("hashchange", () => { if (ST.S.user) render(); });

  async function render() {
    if (!ST.S.user || !shell) return;
    await flushAll();
    flushers = new Set();
    clearInterval(receptionTimer); receptionTimer = null;
    const r = parseRoute();
    for (const a of [...shell.nav.querySelectorAll("a"), ...shell.tabbar.querySelectorAll("a")]) a.classList.toggle("active", location.hash.startsWith(a.getAttribute("href")) || (r.name === "patient" && a.getAttribute("href") === "#/patients"));
    const main = shell.main;
    const scroll = main.scrollTop;
    const sameView = main.dataset.view === location.hash;
    U.clear(main);
    main.dataset.view = location.hash;
    try {
      if (r.name === "reception") viewReception(main, r);
      else if (r.name === "patients") viewPatients(main, r);
      else if (r.name === "new") viewNewPatient(main);
      else if (r.name === "patient") await viewPatient(main, r);
      else if (r.name === "admin") await viewAdmin(main);
      else if (r.name === "audit") viewAudit(main);
      else main.appendChild(h("p", null, "ページが見つかりません"));
    } catch (e) {
      console.error(e);
      main.appendChild(h("div", { class: "notice danger" }, e.message || String(e)));
    }
    if (sameView) main.scrollTop = scroll; else main.scrollTop = 0;
  }

  // ======================================================================
  // 受付一覧
  // ======================================================================
  function viewReception(main, r) {
    const date = r.q.get("date") || ST.ymd();
    const list = ST.encountersOn(date);
    const cols = ["waiting", "exam", "billing", "done"];
    const dateIn = inp({ type: "date", value: date, onchange: () => go("#/reception?date=" + dateIn.value) });
    main.appendChild(h("div", { class: "page-head" },
      h("h1", null, "受付一覧"),
      h("div", { class: "row" }, dateIn,
        date !== ST.ymd() ? h("button", { class: "btn sm", onclick: () => go("#/reception") }, "今日") : null,
        ST.can("reception") ? h("button", { class: "btn primary", onclick: () => receptionDialog() }, "＋ 受付する") : null)));
    if (ST.S.user.admin) ST.lastBackup().then(at => {
      const days = at ? (Date.now() - new Date(at).getTime()) / 86400000 : Infinity;
      if (days > 7) main.prepend(h("div", { class: "notice warn" }, at ? `最後のバックアップから${Math.floor(days)}日経過しています。` : "まだバックアップを取っていません。", " ", h("a", { href: "#/admin" }, "管理画面でバックアップ")));
    });
    const ib = installBanner(false, true);
    if (ib) main.prepend(ib);
    const counts = cols.map(c => list.filter(e => e.status === c).length);
    main.appendChild(h("p", { class: "muted" }, `受付 ${list.length}名　`, cols.map((c, i) => `${M.encStatus[c]} ${counts[i]}　`)));
    const board = h("div", { class: "board", "data-lane": laneSel });
    main.appendChild(h("div", { class: "lane-switch", role: "tablist", "aria-label": "表示する状態" }, cols.map((c, i) => h("button", {
      type: "button", role: "tab", class: c === laneSel ? "on" : "", "aria-selected": c === laneSel ? "true" : "false",
      onclick: e => { laneSel = c; board.dataset.lane = c; e.target.closest(".lane-switch").querySelectorAll("button").forEach(b => { b.classList.toggle("on", b === e.currentTarget); b.setAttribute("aria-selected", b === e.currentTarget ? "true" : "false"); }); }
    }, M.encStatus[c], h("span", { class: "count" }, counts[i])))));
    for (const c of cols) {
      const items = list.filter(e => e.status === c);
      board.appendChild(h("section", { class: "lane lane-" + c, "aria-label": M.encStatus[c] },
        h("h2", null, M.encStatus[c], h("span", { class: "count" }, items.length)),
        items.length ? items.map(encCard) : h("p", { class: "muted small empty" }, "なし")));
    }
    main.appendChild(board);
    if (date === ST.ymd()) receptionTimer = setInterval(() => {
      if (document.querySelector(".modal-back")) return;
      if (parseRoute().name === "reception") render();
    }, 60000);
  }

  let laneSel = "waiting";
  function encCard(e) {
    const p = ST.patient(e.patientId);
    if (!p) return null;
    const waitMin = Math.floor((Date.now() - new Date(e.receptionAt).getTime()) / 60000);
    const btns = [];
    const st = (s, label, cls) => btns.push(h("button", { class: "btn sm " + (cls || ""), onclick: () => act(async () => { await ST.setEncStatus(e, s); render(); }) }, label));
    if (ST.can("clinical.view")) btns.push(h("button", {
      class: "btn sm primary", onclick: () => act(async () => {
        if (e.status === "waiting" && ST.S.user.role === "doctor" && e.date === ST.ymd()) await ST.setEncStatus(e, "exam");
        go(`#/patient/${p.id}/chart`);
      })
    }, "カルテ"));
    if (e.status === "waiting") st("exam", "呼び込み");
    if (e.status === "exam") st("billing", "診察終了");
    if (e.status === "billing" && ST.can("billing")) st("done", "会計済");
    if (e.status === "done" && ST.can("billing")) st("billing", "会計に戻す", "ghost");
    if (e.status === "waiting" || e.status === "exam") btns.push(h("button", {
      class: "btn sm ghost", onclick: () => act(async () => {
        const reason = await U.askText("受付の取消", "取消理由", { required: true, placeholder: "例: 受診せず帰宅" });
        if (reason) { await ST.setEncStatus(e, "cancelled", reason); render(); }
      })
    }, "取消"));
    return h("article", { class: "enc-card" },
      h("div", { class: "enc-top" }, h("span", { class: "no" }, `No.${e.no}`), h("span", { class: "muted" }, U.hm(e.receptionAt) + " 受付"),
        e.status === "waiting" && e.date === ST.ymd() ? h("span", { class: "wait " + (waitMin >= 30 ? "long" : "") }, `待ち ${waitMin}分`) : null),
      h("a", { class: "enc-name", href: `#/patient/${p.id}/${ST.can("clinical.view") ? "chart" : "info"}` }, p.name, h("small", null, p.kana)),
      h("div", { class: "muted small" }, `${p.pid}　${ageText(p.birth)} ${U.sexLabel(p.sex)}　${e.dept}・${e.visitType}`),
      e.complaint ? h("div", { class: "complaint" }, e.complaint) : null,
      h("div", { class: "badges" }, allergyBadges(p)),
      h("div", { class: "actions" }, btns));
  }

  async function receptionDialog(preset) {
    let chosen = preset || null;
    const box = h("div");
    const dept = sel(ST.settings().depts, ST.settings().depts[0]);
    const vtype = sel(["", "初診", "再診"].map(x => [x, x || "自動判定"]), "");
    const comp = inp({ placeholder: "例: 3日前から発熱" });
    const results = h("div", { class: "pick-list" });
    const q = inp({ type: "search", placeholder: "カナ・氏名・患者番号・生年月日(8桁)", autofocus: true });
    function showResults() {
      U.clear(results);
      const list = ST.searchPatients(q.value).slice(0, 30);
      if (!list.length) results.appendChild(h("p", { class: "muted small" }, "該当なし。", ST.can("patient.edit") ? h("a", { href: "#/new" }, "新規登録へ") : null));
      for (const p of list) results.appendChild(h("button", {
        type: "button", class: "pick " + (chosen && chosen.id === p.id ? "on" : ""),
        onclick: () => { chosen = p; showResults(); }
      }, h("b", null, p.name), ` ${p.kana}　${p.pid}　${U.wareki(p.birth)}（${ageText(p.birth)}）${U.sexLabel(p.sex)}`));
    }
    q.addEventListener("input", showResults);
    if (!preset) box.append(field("患者を選ぶ", q), results);
    else box.append(h("p", null, h("b", null, preset.name), `　${preset.kana}　${preset.pid}`));
    box.append(h("div", { class: "grid3" }, field("診療科", dept), field("初診/再診", vtype), field("主訴・受診理由", comp)));
    showResults();
    const ok = await U.modal("受付", box, [{ label: "キャンセル", value: null }, {
      label: "受付する", cls: "primary", onClick: async () => {
        if (!chosen) throw new Error("患者を選んでください");
        try { return await ST.receive(chosen.id, { dept: dept.value, visitType: vtype.value || undefined, complaint: comp.value.trim() }); }
        catch (e) {
          if (e.existing && await U.confirmDlg("重複受付の確認", `${chosen.name} さんは本日すでに受付済み（${M.encStatus[e.existing.status]}）です。\nもう一度受付しますか？`, "受付する")) {
            return ST.receive(chosen.id, { dept: dept.value, visitType: vtype.value || undefined, complaint: comp.value.trim(), force: true });
          }
          if (e.existing) return false;
          throw e;
        }
      }
    }], { wide: true });
    if (ok) { U.toast(`${chosen.name} さんを受付しました（No.${ok.no}）`, "ok"); render(); }
  }

  // ======================================================================
  // 患者検索
  // ======================================================================
  function viewPatients(main, r) {
    const q = inp({ type: "search", value: r.q.get("q") || "", placeholder: "カナ・氏名・患者番号・電話番号・生年月日（例 19580412）", "aria-label": "患者検索" });
    const out = h("div");
    const showList = () => {
      U.clear(out);
      const list = ST.searchPatients(q.value);
      const lastVisit = pid => { const e = ST.encountersOf(pid)[0]; return e ? e.date : ""; };
      if (!list.length) { out.appendChild(h("p", { class: "muted" }, "該当する患者はいません。")); return; }
      out.appendChild(h("table", { class: "tbl hover pt-list" },
        h("thead", null, h("tr", null, ["患者番号", "氏名", "カナ", "生年月日", "年齢", "性別", "電話", "最終受診", ""].map(x => h("th", null, x)))),
        h("tbody", null, list.slice(0, 200).map(p => h("tr", { tabindex: "0", onclick: () => go(`#/patient/${p.id}/${ST.can("clinical.view") ? "chart" : "info"}`), onkeydown: e => { if (e.key === "Enter") go(`#/patient/${p.id}/${ST.can("clinical.view") ? "chart" : "info"}`); } },
          h("td", { class: "mono" }, p.pid), h("td", null, h("b", null, p.name)), h("td", null, p.kana), h("td", null, U.wareki(p.birth)),
          h("td", null, ageText(p.birth)), h("td", null, U.sexLabel(p.sex)), h("td", null, p.phone || ""), h("td", null, U.jdate(lastVisit(p.id))),
          h("td", null, (p.allergies || []).length ? badge("⚠ アレルギー", "danger") : null))))));
      if (list.length > 200) out.appendChild(h("p", { class: "muted" }, `ほか ${list.length - 200} 名。条件をしぼってください。`));
    };
    q.addEventListener("input", U.debounce(() => { history.replaceState(null, "", "#/patients?q=" + encodeURIComponent(q.value)); main.dataset.view = location.hash; showList(); }, 150));
    main.append(h("div", { class: "page-head" }, h("h1", null, "患者検索"),
      ST.can("patient.edit") ? h("a", { class: "btn primary", href: "#/new" }, "＋ 新規患者登録") : null),
      h("div", { class: "searchbar" }, q), out);
    showList();
    q.focus();
  }

  function viewNewPatient(main) {
    ST.need("patient.edit");
    main.append(h("div", { class: "page-head" }, h("h1", null, "新規患者登録")),
      patientForm(null, async p => {
        U.toast(`患者番号 ${p.pid} で登録しました`, "ok");
        if (await U.confirmDlg("受付", `${p.name} さんをこのまま受付しますか？`, "受付へ")) await receptionDialog(p);
        go(`#/patient/${p.id}/${ST.can("clinical.view") ? "chart" : "info"}`);
      }));
  }

  // ---------- 患者情報フォーム ----------
  function patientForm(p0, onSaved) {
    const baseUpdated = p0 ? p0.updatedAt : null;
    const v = JSON.parse(JSON.stringify(p0 || { sex: "", insurance: { type: "社保", ratio: 30 }, allergies: [], emergency: {}, allergyNone: false }));
    v.insurance = v.insurance || {}; v.emergency = v.emergency || {}; v.allergies = v.allergies || [];
    const F = {};
    const I = (k, a) => (F[k] = inp(Object.assign({ value: v[k] || "" }, a)));
    const ins = v.insurance, em = v.emergency;
    const insF = {
      type: sel(M.insuranceTypes, ins.type || "社保"), insurerNo: inp({ value: ins.insurerNo || "", inputmode: "numeric" }),
      symbol: inp({ value: ins.symbol || "" }), number: inp({ value: ins.number || "" }), branch: inp({ value: ins.branch || "", inputmode: "numeric" }),
      ratio: sel([[30, "3割"], [20, "2割"], [10, "1割"], [0, "なし（公費等）"], [100, "10割（自費）"]], ins.ratio ?? 30), validUntil: inp({ type: "date", value: ins.validUntil || "" })
    };
    const emF = { name: inp({ value: em.name || "" }), relation: inp({ value: em.relation || "" }), phone: inp({ value: em.phone || "", type: "tel" }) };
    const sex = sel([["", "選択"], ["M", "男"], ["F", "女"], ["O", "その他"]], v.sex);
    const blood = sel(["", "A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-", "不明"].map(x => [x, x || "未登録"]), v.bloodType || "");

    // アレルギー
    const allergyBox = h("div", { class: "allergy-list" });
    const noneChk = h("input", { type: "checkbox", checked: !!v.allergyNone });
    function drawAllergies() {
      U.clear(allergyBox);
      v.allergies.forEach((a, i) => allergyBox.appendChild(h("div", { class: "allergy-row" },
        inp({ value: a.substance || "", placeholder: "薬剤名・分類・食物など（例: ペニシリン）", oninput: e => { a.substance = e.target.value; }, "aria-label": "アレルゲン" }),
        inp({ value: a.reaction || "", placeholder: "症状（例: 発疹）", oninput: e => { a.reaction = e.target.value; }, "aria-label": "症状" }),
        sel(["", "軽度", "中等度", "重度", "不明"].map(x => [x, x || "重症度"]), a.severity || "", { onchange: e => { a.severity = e.target.value; }, "aria-label": "重症度" }),
        h("button", { type: "button", class: "btn sm ghost", onclick: () => { v.allergies.splice(i, 1); drawAllergies(); } }, "削除"))));
      noneChk.disabled = v.allergies.length > 0;
      if (v.allergies.length) noneChk.checked = false;
    }
    drawAllergies();

    const err = h("div", { class: "form-err", role: "alert" });
    const form = h("form", {
      class: "card form", oninput: () => { form.dataset.dirty = "1"; }, onchange: () => { form.dataset.dirty = "1"; }, onsubmit: async e => {
        e.preventDefault(); err.textContent = "";
        // ほかの端末（または別の人）がこのフォームを開いた後に変更していたら、上書きせずに知らせる
        if (p0 && ST.patient(p0.id) && ST.patient(p0.id).updatedAt !== baseUpdated) {
          U.clear(err).append("ほかの端末でこの患者の情報が変更されました（", ST.staffName(ST.patient(p0.id).updatedBy), "）。上書きを防ぐため保存していません。 ",
            h("button", { type: "button", class: "btn sm", onclick: () => render() }, "最新の内容を読み込む"));
          return;
        }
        const kana = F.kana.value.trim().normalize("NFKC").replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));
        if (kana && !/^[゠-ヿ\s]+$/.test(kana)) { err.textContent = "カナはカタカナ（またはひらがな）で入力してください"; F.kana.focus(); return; }
        if (F.birth.value && F.birth.value > ST.ymd()) { err.textContent = "生年月日が未来の日付です"; return; }
        const data = {
          id: p0 ? p0.id : undefined, name: F.name.value.trim(), kana, birth: F.birth.value, sex: sex.value,
          zip: F.zip.value.trim(), address: F.address.value.trim(), phone: F.phone.value.trim(), bloodType: blood.value,
          infection: F.infection.value.trim(), history: F.history.value, familyHistory: F.familyHistory.value, smoking: F.smoking.value.trim(), alcohol: F.alcohol.value.trim(), memo: F.memo.value,
          insurance: { type: insF.type.value, insurerNo: insF.insurerNo.value.trim(), symbol: insF.symbol.value.trim(), number: insF.number.value.trim(), branch: insF.branch.value.trim(), ratio: Number(insF.ratio.value), validUntil: insF.validUntil.value },
          emergency: { name: emF.name.value.trim(), relation: emF.relation.value.trim(), phone: emF.phone.value.trim() },
          allergies: v.allergies.filter(a => (a.substance || "").trim()).map(a => ({ substance: a.substance.trim(), reaction: (a.reaction || "").trim(), severity: a.severity || "" })),
          allergyNone: noneChk.checked && !v.allergies.some(a => (a.substance || "").trim())
        };
        try {
          let p;
          try { p = await ST.savePatient(data); }
          catch (ex) {
            if (!ex.duplicate) throw ex;
            if (!(await U.confirmDlg("重複の可能性", ex.message + "\n同一人物でないことを確認して登録しますか？", "別人として登録"))) return;
            p = await ST.savePatient(Object.assign(data, { allowDuplicate: true }));
          }
          onSaved(p);
        } catch (ex) { err.textContent = ex.message; }
      }
    },
      h("fieldset", null, h("legend", null, "基本情報"),
        h("div", { class: "grid4" },
          field("氏名", I("name", { autocomplete: "off" }), { req: true }), field("カナ", I("kana", { autocomplete: "off" }), { req: true }),
          field("生年月日", I("birth", { type: "date", max: ST.ymd() }), { req: true }), field("性別", sex, { req: true })),
        h("div", { class: "grid4" }, field("血液型", blood), field("郵便番号", I("zip", { inputmode: "numeric" })), field("住所", I("address"), { cls: "span2" })),
        h("div", { class: "grid4" }, field("電話番号", I("phone", { type: "tel" })), field("緊急連絡先 氏名", emF.name), field("続柄", emF.relation), field("緊急連絡先 電話", emF.phone))),
      h("fieldset", null, h("legend", null, "保険"),
        h("div", { class: "grid4" }, field("種別", insF.type), field("保険者番号", insF.insurerNo), field("記号", insF.symbol), field("番号", insF.number)),
        h("div", { class: "grid4" }, field("枝番", insF.branch), field("負担割合", insF.ratio), field("有効期限", insF.validUntil))),
      h("fieldset", null, h("legend", null, "アレルギー・注意事項"),
        allergyBox,
        h("div", { class: "row" }, h("button", { type: "button", class: "btn sm", onclick: () => { v.allergies.push({ substance: "", reaction: "", severity: "" }); drawAllergies(); allergyBox.querySelector(".allergy-row:last-child input").focus(); } }, "＋ アレルギーを追加"),
          h("label", { class: "check" }, noneChk, " アレルギーなし（確認済み）")),
        h("div", { class: "grid2" }, field("感染症", I("infection", { placeholder: "例: HBs抗原陽性" })), field("メモ（受付・看護向け）", F.memo = ta({ rows: 2, value: v.memo || "" })))),
      h("fieldset", null, h("legend", null, "既往歴・生活歴"),
        h("div", { class: "grid2" }, field("既往歴", F.history = ta({ value: v.history || "" })), field("家族歴", F.familyHistory = ta({ value: v.familyHistory || "" }))),
        h("div", { class: "grid2" }, field("喫煙", I("smoking")), field("飲酒", I("alcohol")))),
      err,
      h("div", { class: "form-foot" }, h("button", { class: "btn primary", type: "submit" }, p0 ? "変更を保存" : "登録する")));
    return form;
  }

  // ======================================================================
  // 患者（カルテ）
  // ======================================================================
  const TABS = [
    ["chart", "カルテ", "clinical.view"], ["problems", "病名", "clinical.view"], ["rx", "処方歴", "clinical.view"],
    ["labs", "検査", "clinical.view"], ["vitals", "経過グラフ", "clinical.view"], ["docs", "文書", "clinical.view"],
    ["info", "患者情報", null], ["visits", "受診歴", null], ["log", "操作履歴", "admin"]
  ];

  async function viewPatient(main, r) {
    const p = ST.patient(r.id);
    if (!p) { main.appendChild(h("p", null, "患者が見つかりません")); return; }
    const tabs = TABS.filter(t => !t[2] || ST.can(t[2]));
    const tab = tabs.find(t => t[0] === r.tab) ? r.tab : tabs[0][0];
    if (lastViewedPid !== p.id) { lastViewedPid = p.id; ST.audit(ST.can("clinical.view") ? "カルテ閲覧" : "患者情報閲覧", { patientId: p.id }); }
    main.appendChild(patientHeader(p));
    main.appendChild(h("div", { class: "tabs", role: "tablist" }, tabs.map(([k, label]) => h("a", { role: "tab", "aria-selected": k === tab ? "true" : "false", class: k === tab ? "on" : "", href: `#/patient/${p.id}/${k}` }, label))));
    const pane = h("div", { class: "tabpane", role: "tabpanel" });
    main.appendChild(pane);
    ({ chart: tabChart, problems: tabProblems, rx: tabRx, labs: tabLabs, vitals: tabVitals, docs: tabDocs, info: tabInfo, visits: tabVisits, log: tabLog })[tab](pane, p);
  }

  function patientHeader(p) {
    const ins = p.insurance || {};
    const today = ST.encountersOf(p.id).find(e => e.date === ST.ymd());
    const mainProblem = ST.can("clinical.view") ? ST.problemsOf(p.id).filter(x => x.outcome === "継続") : [];
    return h("section", { class: "pt-head" },
      h("div", { class: "pt-id" },
        h("div", { class: "pt-name" }, h("span", { class: "pid mono" }, p.pid), h("h1", null, p.name), h("span", { class: "kana" }, p.kana)),
        h("div", { class: "pt-meta" },
          h("span", { class: "sex-" + p.sex }, U.sexLabel(p.sex)), h("span", null, `${ageText(p.birth)}`), h("span", null, `${U.wareki(p.birth)}生`),
          p.bloodType ? h("span", null, `血液型 ${p.bloodType}`) : null,
          h("span", null, `${ins.type || "保険未登録"}${ins.ratio !== undefined && ins.type ? " " + (ins.ratio === 100 ? "自費" : ins.ratio / 10 + "割") : ""}`),
          ins.validUntil && ins.validUntil < ST.ymd() ? badge("保険期限切れ", "warn") : null)),
      h("div", { class: "pt-flags" },
        allergyBadges(p),
        p.infection ? badge(`感染症: ${p.infection}`, "warn") : null,
        mainProblem.slice(0, 4).map(x => badge(x.name + (x.suspected ? "(疑)" : ""), x.main ? "key-dx" : "")),
        p.memo ? h("span", { class: "memo", title: "メモ" }, "📝 " + p.memo) : null),
      h("div", { class: "pt-actions" },
        today ? badge(`本日: ${M.encStatus[today.status]}`, "info") : (ST.can("reception") ? h("button", { class: "btn sm", onclick: () => receptionDialog(p) }, "受付する") : null),
        ST.can("clinical.view") ? h("button", { class: "btn sm ghost", onclick: () => printChartDialog(p) }, "カルテ印刷") : null));
  }

  async function printChartDialog(p) {
    const encs = ST.encountersOf(p.id);
    const from = inp({ type: "date", value: encs.length ? encs[encs.length - 1].date : ST.ymd() });
    const to = inp({ type: "date", value: ST.ymd() });
    const ok = await U.modal("カルテ印刷", h("div", { class: "grid2" }, field("開始日", from), field("終了日", to)), [{ label: "キャンセル", value: false }, { label: "印刷", cls: "primary", value: true }]);
    if (ok) PR.chart(p.id, from.value, to.value);
  }

  // ---------- カルテタブ ----------
  function vitalsText(v) {
    if (!v) return "";
    const a = [];
    if (v.bt) a.push(`T ${v.bt}℃`);
    if (v.sbp || v.dbp) a.push(`BP ${v.sbp || "-"}/${v.dbp || "-"}`);
    if (v.pulse) a.push(`P ${v.pulse}`);
    if (v.spo2) a.push(`SpO₂ ${v.spo2}%`);
    if (v.rr) a.push(`RR ${v.rr}`);
    if (v.height) a.push(`身長 ${v.height}cm`);
    if (v.weight) a.push(`体重 ${v.weight}kg`);
    const bmi = calcBmi(v);
    if (bmi) a.push(`BMI ${bmi}`);
    return a.join("　");
  }
  function calcBmi(v) { return v && v.height > 0 && v.weight > 0 ? (v.weight / Math.pow(v.height / 100, 2)).toFixed(1) : ""; }
  function lastHeight(pid) {
    for (const n of ST.notesOf(pid)) { const c = ST.noteContent(n); if (c.vitals && c.vitals.height) return c.vitals.height; }
    return "";
  }

  function tabChart(pane, p) {
    const left = h("section", { class: "history-col", "aria-label": "過去の記載" });
    const right = h("section", { class: "editor-col", "aria-label": "本日の記載" });
    const cols = h("div", { class: "chart-cols", "data-pane": chartPane }, left, right);
    const nPast = ST.notesOf(p.id).filter(n => !n.deleted && n.versions.length).length;
    const sw = h("div", { class: "pane-switch", role: "tablist" }, [["edit", "記載する"], ["history", `過去の記載（${nPast}）`]].map(([k, label]) => h("button", {
      type: "button", role: "tab", class: chartPane === k ? "on" : "", "aria-selected": chartPane === k ? "true" : "false",
      onclick: e => { chartPane = k; cols.dataset.pane = k; sw.querySelectorAll("button").forEach(b => { const on = b === e.currentTarget; b.classList.toggle("on", on); b.setAttribute("aria-selected", on ? "true" : "false"); }); window.scrollTo(0, 0); shell.main.scrollTop = 0; }
    }, label)));
    pane.append(sw, cols);
    drawHistory(left, p);
    drawEditor(right, p);
  }

  let showDeleted = false;
  let chartPane = "edit"; // スマホで表示する側
  function drawHistory(box, p) {
    U.clear(box);
    const me = ST.S.user.id;
    const notes = ST.notesOf(p.id).filter(n => (showDeleted || !n.deleted) && !(n.draft && !n.versions.length && (n.draftBy || n.authorId) === me));
    const rxs = ST.rxOf(p.id);
    box.appendChild(h("div", { class: "col-head" }, h("h2", null, "過去の記載"),
      h("label", { class: "check small" }, h("input", { type: "checkbox", checked: showDeleted, onchange: e => { showDeleted = e.target.checked; drawHistory(box, p); } }), " 削除済みも表示")));
    if (!notes.length) box.appendChild(h("p", { class: "muted" }, "記載はまだありません。"));
    for (const n of notes) {
      const signed = n.versions.length > 0;
      const c = signed ? n.versions[n.versions.length - 1].content : n.draft;
      const last = signed ? n.versions[n.versions.length - 1] : null;
      const encRx = rxs.filter(r => r.encounterId === n.encounterId && (!r.noteId || r.noteId === n.id));
      const canEdit = !n.deleted && signed && !n.draft && ST.can("note.write") && (n.authorId === me || ST.S.user.role === "doctor") && ST.canSign(n);
      box.appendChild(h("article", { class: "note-card " + (n.deleted ? "deleted " : "") + (signed ? "" : "draft") },
        h("header", null,
          h("b", null, U.jdateW(n.date)), badge(n.kind, n.kind === "看護記録" ? "nurse" : ""),
          !signed ? badge("下書き（未確定）", "warn") : null,
          n.draft && signed ? badge("修正中", "warn") : null,
          last && last.v > 1 ? h("button", { class: "linkish", onclick: () => noteHistory(n) }, `第${last.v}版`) : null,
          n.deleted ? badge("削除済み", "danger") : null,
          h("span", { class: "muted small grow" }, `記載 ${ST.staffName(n.authorId)}`, last ? `／確定 ${ST.staffName(last.signedBy)} ${U.hm(last.signedAt)}` : "")),
        n.deleted ? h("p", { class: "small danger-text" }, `削除理由: ${n.deleted.reason}（${ST.staffName(n.deleted.by)} ${U.jdt(n.deleted.at)}）`) : null,
        vitalsText(c.vitals) ? h("div", { class: "vit" }, vitalsText(c.vitals)) : null,
        h("dl", { class: "soap" }, ["S", "O", "A", "P"].filter(k => c[k]).map(k => [h("dt", null, k), h("dd", null, c[k])])),
        encRx.length ? encRx.map(r => h("div", { class: "rx-mini " + (r.status === "cancelled" ? "cancelled" : "") },
          h("div", { class: "rx-mini-head" }, `Rp（${r.type}）`, r.status === "cancelled" ? badge("取消", "danger") : null,
            r.status === "issued" && ST.can("rx.issue") ? h("button", { class: "linkish", onclick: () => doRx(p, r) }, "Do処方") : null,
            r.status === "issued" ? h("button", { class: "linkish", onclick: () => PR.prescription(r) }, "処方箋印刷") : null),
          h("ol", null, r.items.map(it => h("li", null, it.name, h("span", { class: "muted" }, "　" + ST.itemQtyText(it))))))) : null,
        h("footer", null,
          canEdit ? h("button", { class: "btn sm ghost", onclick: () => act(async () => { await ST.editSigned(n); render(); }) }, "修正") : null,
          signed && n.versions.length > 1 ? h("button", { class: "btn sm ghost", onclick: () => noteHistory(n) }, "修正履歴") : null,
          ST.can("note.write") && !n.deleted && (n.authorId === me || ST.S.user.admin) ? h("button", {
            class: "btn sm ghost", onclick: () => act(async () => {
              const reason = await U.askText("記載の削除", "削除理由", { required: true, danger: true, okLabel: "削除", note: "記載は消えずに「削除済み」として残ります（監査のため）。" });
              if (reason) { await ST.deleteNote(n, reason); render(); }
            })
          }, "削除") : null)));
    }
  }

  let pendingDo = null; // Do処方の受け渡し
  async function doRx(p, rx) {
    pendingDo = rx.items.map(it => Object.assign({}, it));
    const draft = myDraft(p.id);
    if (!draft) {
      if (!(await U.confirmDlg("Do処方", "本日の記載を開始して、この処方をコピーしますか？", "開始する"))) { pendingDo = null; return; }
      await act(async () => { const enc = await ST.ensureTodayEncounter(p.id); await startEncounterExam(enc); await ST.createNote(p.id, enc.id, "診療録"); });
    }
    render();
  }
  function myDraft(pid) { return ST.notesOf(pid).find(n => n.draft && !n.deleted && (n.draftBy || n.authorId) === ST.S.user.id); }
  async function startEncounterExam(enc) { if (enc.status === "waiting" && ST.S.user.role === "doctor") await ST.setEncStatus(enc, "exam"); }

  async function noteHistory(n) {
    const C = window.EMRCrypto;
    const body = h("div", { class: "history" });
    let prevHash = "", ok = true;
    for (const v of n.versions) {
      const hash = await C.sha256hex(JSON.stringify({ prev: prevHash, v: v.v, content: v.content, signedBy: v.signedBy, signedAt: v.signedAt, reason: v.reason }));
      if (v.hash && hash !== v.hash) ok = false;
      prevHash = v.hash || hash;
    }
    body.appendChild(h("p", { class: ok ? "ok-text" : "danger-text" }, ok ? "✓ 各版の内容は確定時から改変されていません（ハッシュ照合）" : "✗ 確定後に内容が変更された版があります"));
    n.versions.slice().reverse().forEach((v, idx, arr) => {
      const prev = n.versions[v.v - 2];
      const sec = h("section", { class: "ver" }, h("h3", null, `第${v.v}版`, h("span", { class: "muted small" }, `　${ST.staffName(v.signedBy)}　${U.jdt(v.signedAt)}`)),
        v.reason ? h("p", null, h("b", null, "修正理由: "), v.reason) : h("p", { class: "muted small" }, "初版"));
      for (const k of ["S", "O", "A", "P"]) {
        const a = prev ? prev.content[k] : "", b = v.content[k];
        if (prev && a === b) continue;
        if (!prev && !b) continue;
        sec.appendChild(h("div", { class: "diff" }, h("b", null, k), h("pre", null, prev ? U.diffLines(a, b).map(d => h("span", { class: "d" + (d.t === "+" ? "add" : d.t === "-" ? "del" : "") }, (d.t === "=" ? "  " : d.t + " ") + d.s + "\n")) : b)));
      }
      const va = vitalsText(prev ? prev.content.vitals : null), vb = vitalsText(v.content.vitals);
      if (prev && va !== vb) sec.appendChild(h("div", { class: "diff" }, h("b", null, "V"), h("pre", null, h("span", { class: "ddel" }, "- " + va + "\n"), h("span", { class: "dadd" }, "+ " + vb))));
      body.appendChild(sec);
    });
    ST.audit("修正履歴閲覧", { patientId: n.patientId, target: n.id });
    U.modal("修正履歴", body, null, { wide: true });
  }

  // ---------- 記載エディタ ----------
  function drawEditor(box, p) {
    U.clear(box);
    if (!ST.can("note.write")) { box.appendChild(h("p", { class: "muted" }, "記載の権限がありません。")); return; }
    const note = myDraft(p.id);
    if (!note) {
      const kindSel = ST.S.user.role === "doctor" ? sel(["診療録", "看護記録"], "診療録") : null;
      const othersDraft = ST.notesOf(p.id).filter(n => n.draft && !n.deleted && n.authorId !== ST.S.user.id && !n.versions.length);
      box.append(h("div", { class: "col-head" }, h("h2", null, "本日の記載")),
        h("div", { class: "start-card" },
          othersDraft.length ? h("p", { class: "notice" }, `${othersDraft.map(n => ST.staffName(n.authorId)).join("、")} さんが記載中の下書きがあります。`) : null,
          h("p", null, `${U.jdateW(ST.ymd())} の記載を始めます。`),
          kindSel ? field("種類", kindSel) : h("p", { class: "muted small" }, "看護記録として記載します。"),
          h("button", {
            class: "btn primary big", onclick: () => act(async () => {
              const enc = await ST.ensureTodayEncounter(p.id);
              await startEncounterExam(enc);
              await ST.createNote(p.id, enc.id, kindSel ? kindSel.value : "看護記録");
              render();
            })
          }, "記載を始める")));
      return;
    }
    const c = note.draft;
    c.vitals = c.vitals || {}; c.rxItems = c.rxItems || []; c.rxType = c.rxType || "院外";
    if (pendingDo) {
      const add = pendingDo.filter(it => !c.rxItems.some(x => x.name === it.name));
      c.rxItems.push(...add);
      U.toast(`${add.length}件の薬をコピーしました（日数を確認してください）`, "ok");
      pendingDo = null;
    }
    const status = h("span", { class: "save-state muted small", "aria-live": "polite" }, note.updatedAt ? `保存済み ${U.hm(note.updatedAt)}` : "");
    const persist = U.debounce(async () => {
      try { await ST.saveDraft(note, c); status.textContent = `下書き保存 ${U.hm(new Date().toISOString())}`; }
      catch (e) { status.textContent = "保存できませんでした"; U.toast(e.message, "error"); }
    }, 700);
    const changed = () => { status.textContent = "編集中…"; persist(); };
    flushers.add(() => persist.flush());

    // バイタル
    const vdefs = [["bt", "体温", "℃", "0.1", 30, 43], ["sbp", "血圧(上)", "mmHg", "1", 40, 300], ["dbp", "血圧(下)", "mmHg", "1", 20, 200], ["pulse", "脈拍", "/分", "1", 20, 250],
      ["spo2", "SpO₂", "%", "1", 50, 100], ["rr", "呼吸数", "/分", "1", 4, 80], ["height", "身長", "cm", "0.1", 30, 250], ["weight", "体重", "kg", "0.1", 1, 300]];
    const bmiOut = h("output", { class: "bmi" }, calcBmi(c.vitals) ? `BMI ${calcBmi(c.vitals)}` : "");
    const vgrid = h("div", { class: "vitals-grid" }, vdefs.map(([k, label, unit, step, mn, mx]) => {
      const i = inp({
        type: "number", step, min: mn, max: mx, inputmode: "decimal", value: c.vitals[k] ?? "", placeholder: k === "height" && lastHeight(p.id) ? String(lastHeight(p.id)) : "",
        oninput: e => {
          const val = e.target.value === "" ? undefined : Number(e.target.value);
          if (val === undefined) delete c.vitals[k]; else c.vitals[k] = val;
          e.target.classList.toggle("out", val !== undefined && (val < mn || val > mx));
          bmiOut.textContent = calcBmi(c.vitals) ? `BMI ${calcBmi(c.vitals)}` : "";
          changed();
        }
      });
      return h("label", { class: "vfield" }, h("span", null, label), h("div", { class: "unit-wrap" }, i, h("small", null, unit)));
    }), bmiOut);

    // SOAP
    const soapLabels = { S: "S（主観的情報・主訴）", O: "O（客観的所見）", A: "A（評価・診断）", P: "P（計画・指導）" };
    const areas = {};
    const soap = ["S", "O", "A", "P"].map(k => {
      const area = areas[k] = ta({ rows: k === "O" ? 4 : 3, value: c[k] || "", "aria-label": soapLabels[k], oninput: e => { c[k] = e.target.value; changed(); } });
      const chips = (M.phrases[k] || []).map(t => h("button", { type: "button", class: "chip", onclick: () => insertText(area, t) }, t));
      if (k === "A") ST.problemsOf(p.id).filter(x => x.outcome === "継続").forEach(x => chips.unshift(h("button", { type: "button", class: "chip pb", onclick: () => insertText(area, x.name + "　") }, "＃" + x.name)));
      if (k === "S" && ST.encountersOf(p.id)[0] && ST.encountersOf(p.id)[0].complaint && ST.encountersOf(p.id)[0].date === ST.ymd()) {
        const cc = ST.encountersOf(p.id)[0].complaint;
        chips.unshift(h("button", { type: "button", class: "chip pb", onclick: () => insertText(area, cc + "。") }, "受付時主訴"));
      }
      return h("div", { class: "soap-field" }, h("label", null, h("b", null, k), soapLabels[k].slice(1)), area, h("div", { class: "chips" }, chips));
    });
    function insertText(area, t) {
      const s = area.selectionStart ?? area.value.length, e = area.selectionEnd ?? area.value.length;
      const before = area.value.slice(0, s), sep = before && !before.endsWith("\n") && !before.endsWith("　") ? "\n" : "";
      area.setRangeText(sep + t, s, e, "end");
      area.dispatchEvent(new Event("input"));
      area.focus();
    }

    // 処方
    const rxAllowed = note.kind === "診療録" && ST.can("rx.issue") && !note.versions.length;
    const rxBox = h("div", { class: "rx-box" });
    if (rxAllowed) drawRxComposer(rxBox, p, c, changed);
    else if (note.kind === "診療録" && note.versions.length) rxBox.appendChild(h("p", { class: "muted small" }, "確定済み記載の修正中です。処方を変更する場合は、処方歴で取消してから新しい記載で発行してください。"));

    // ボタン
    const signBtn = h("button", { class: "btn primary big", title: "Ctrl+Enter", onclick: () => sign() }, note.versions.length ? "修正を確定" : (ST.canSign(note) ? "確定する" : "下書き保存"));
    async function sign() {
      await persist.flush();
      if (!ST.canSign(note)) { U.toast("下書きを保存しました（確定は医師が行います）", "ok"); return; }
      if (!["S", "O", "A", "P"].some(k => (c[k] || "").trim()) && !Object.keys(c.vitals).length && !c.rxItems.length) { U.toast("記載が空です", "error"); return; }
      let reason = "";
      if (note.versions.length) {
        reason = await U.askText("修正の確定", "修正理由", { required: true, placeholder: "例: 記載漏れの追記、誤記の訂正" });
        if (!reason) return;
      }
      const items = rxAllowed ? c.rxItems.slice() : [];
      if (items.length) {
        try { ST.validateItems(items); } catch (e) { U.toast(e.message, "error"); return; }
        const warns = ST.checkRx(p, items);
        const danger = warns.filter(w => w.level === "danger");
        if (warns.length) {
          const listEl = h("ul", { class: "warn-list" }, warns.map(w => h("li", { class: w.level }, w.msg)));
          if (danger.length) {
            const why = await U.askText("⚠ 処方の警告", "それでも処方する理由（記録されます）", { required: true, danger: true, okLabel: "理由を記録して発行", note: warns.map(w => "・" + w.msg).join("\n") });
            if (!why) return;
            await ST.audit("処方警告の承認", { patientId: p.id, detail: `${danger.map(d => d.msg).join(" / ")} → 理由: ${why}` });
          } else if (!(await U.modal("処方の確認", h("div", null, h("p", null, "次の点を確認してください。"), listEl), [{ label: "戻る", value: false }, { label: "確認して発行", cls: "primary", value: true }]))) return;
        }
      }
      await act(async () => {
        await ST.signNote(note, reason);
        let rx = null;
        if (items.length) {
          rx = await ST.issueRx(p.id, note.encounterId, items, c.rxType, note.id);
        }
        const enc = ST.S.col.encounter.get(note.encounterId);
        if (enc && note.kind === "診療録" && ["waiting", "exam"].includes(enc.status) && enc.date === ST.ymd()) await ST.setEncStatus(enc, "billing");
        render();
        if (rx && rx.type === "院外") {
          const pr = await U.modal("確定しました", h("p", null, "記載を確定し、処方を発行しました。処方箋を印刷しますか？"), [{ label: "あとで", value: false }, { label: "処方箋を印刷", cls: "primary", value: true }]);
          if (pr) PR.prescription(rx);
        } else U.toast(reason ? "修正を確定しました" : "確定しました", "ok");
      });
    }
    const discardBtn = h("button", {
      class: "btn ghost", onclick: () => act(async () => {
        const msg = note.versions.length ? "修正を取りやめて、確定済みの内容に戻しますか？" : "この下書きを破棄しますか？（破棄した記録は監査用に残ります）";
        if (await U.confirmDlg("下書きの破棄", msg, "破棄する", true)) { await persist.flush(); await ST.discardDraft(note); render(); }
      })
    }, note.versions.length ? "修正を取りやめる" : "下書きを破棄");

    box.addEventListener("keydown", e => { if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); sign(); } if (e.ctrlKey && (e.key === "s" || e.key === "S")) { e.preventDefault(); persist.flush(); } });
    box.append(
      h("div", { class: "col-head" }, h("h2", null, note.versions.length ? `記載の修正（第${note.versions.length}版をもとに）` : "本日の記載"), badge(note.kind, note.kind === "看護記録" ? "nurse" : ""), status),
      h("fieldset", { class: "plain" }, h("legend", null, "バイタル"), vgrid),
      ...soap, rxBox,
      h("div", { class: "editor-foot" }, discardBtn, h("span", { class: "muted small" }, "Ctrl+Enter で確定・自動で下書き保存"), signBtn));
  }

  function drawRxComposer(box, p, c, changed) {
    U.clear(box);
    const typeSel = sel(["院外", "院内"], c.rxType, { onchange: e => { c.rxType = e.target.value; changed(); }, "aria-label": "院外/院内" });
    const last = ST.lastActiveRx(p.id);
    const search = inp({ type: "search", placeholder: "薬品名で検索（一般名・商品名・カナ）して Enter", "aria-label": "薬品検索", autocomplete: "off" });
    const dd = h("div", { class: "dropdown", role: "listbox", hidden: true });
    let hits = [], cursor = 0;
    function find(q) {
      const n = ST.norm(q);
      if (!n) return [];
      return M.drugs.filter(d => [d.name, d.key].concat(d.aliases).some(x => ST.norm(x).includes(n))).slice(0, 12);
    }
    function drawDd() {
      U.clear(dd);
      hits = find(search.value);
      const free = search.value.trim();
      if (!hits.length && !free) { dd.hidden = true; return; }
      hits.forEach((d, i) => dd.appendChild(h("div", { class: "opt " + (i === cursor ? "on" : ""), role: "option", onmousedown: e => { e.preventDefault(); addDrug(d); } },
        d.name, h("small", { class: "muted" }, `　${M.kindLabel[d.kind]}・${d.cls[0] || ""}${d.aliases.length ? "・" + d.aliases[0] : ""}`))));
      if (free) dd.appendChild(h("div", { class: "opt free " + (hits.length === 0 ? "on" : ""), onmousedown: e => { e.preventDefault(); addFree(free); } }, `「${free}」をマスタ外の薬として追加（チェック対象外）`));
      dd.hidden = false;
    }
    function addDrug(d) {
      const prevDays = (c.rxItems.find(x => x.kind === "internal") || {}).days;
      c.rxItems.push({ name: d.name, kind: d.kind, unit: d.unit, qty: d.qty, usage: d.usage, days: d.kind === "internal" ? (prevDays || 14) : d.kind === "prn" ? 5 : 0, comment: "", generic: true });
      search.value = ""; dd.hidden = true; changed(); drawItems(); search.focus();
    }
    function addFree(name) {
      c.rxItems.push({ name, kind: "internal", unit: "錠", qty: 1, usage: "1日1回朝食後", days: 14, comment: "", generic: true, free: true });
      search.value = ""; dd.hidden = true; changed(); drawItems();
    }
    search.addEventListener("input", () => { cursor = 0; drawDd(); });
    search.addEventListener("keydown", e => {
      if (dd.hidden) return;
      const n = hits.length + (search.value.trim() ? 1 : 0);
      if (e.key === "ArrowDown") { e.preventDefault(); cursor = (cursor + 1) % n; drawDd(); }
      if (e.key === "ArrowUp") { e.preventDefault(); cursor = (cursor - 1 + n) % n; drawDd(); }
      if (e.key === "Enter") { e.preventDefault(); if (cursor < hits.length) addDrug(hits[cursor]); else addFree(search.value.trim()); }
      if (e.key === "Escape") { dd.hidden = true; }
    });
    search.addEventListener("blur", () => setTimeout(() => { dd.hidden = true; }, 150));

    const itemsBox = h("div");
    const checks = h("div", { class: "checks", "aria-live": "polite" });
    function drawItems() {
      U.clear(itemsBox);
      if (!c.rxItems.length) itemsBox.appendChild(h("p", { class: "muted small" }, "処方なし"));
      else itemsBox.appendChild(h("ol", { class: "rx-items" }, c.rxItems.map((it, i) => {
        const usageOpts = M.usages[it.kind].map(u => u.label);
        if (it.usage && !usageOpts.includes(it.usage)) usageOpts.push(it.usage);
        const upd = (k, conv) => e => { it[k] = conv ? conv(e.target.value) : e.target.value; changed(); drawChecks(); };
        return h("li", { class: "rx-item" },
          h("div", { class: "rx-item-name" }, h("span", { class: "mono muted" }, `${i + 1})`), h("b", null, it.name), it.free ? badge("マスタ外", "warn") : null, badge(M.kindLabel[it.kind]),
            h("button", { class: "icon-btn", type: "button", "aria-label": `${it.name}を削除`, onclick: () => { c.rxItems.splice(i, 1); changed(); drawItems(); } }, "×")),
          h("div", { class: "rx-item-fields" },
            h("label", { class: "unit-wrap" }, h("small", null, it.kind === "external" ? "総量" : "1回"), inp({ type: "number", step: "0.25", min: "0", value: it.qty, class: "input num", oninput: upd("qty", Number), "aria-label": "数量" }), h("small", null, it.unit)),
            sel(usageOpts, it.usage, { onchange: upd("usage"), "aria-label": "用法", class: "input usage" }),
            it.kind === "external" ? null : h("label", { class: "unit-wrap" }, inp({ type: "number", min: "1", max: "90", value: it.days, class: "input num", oninput: upd("days", Number), "aria-label": it.kind === "prn" ? "回数" : "日数" }), h("small", null, it.kind === "prn" ? "回分" : "日分")),
            inp({ value: it.comment || "", oninput: upd("comment"), placeholder: "コメント", "aria-label": "コメント", class: "input comment" }),
            h("label", { class: "check small" }, h("input", { type: "checkbox", checked: it.generic === false, onchange: e => { it.generic = !e.target.checked; changed(); } }), "変更不可")));
      })));
      drawChecks();
    }
    function drawChecks() {
      U.clear(checks);
      const w = ST.checkRx(p, c.rxItems);
      if (c.rxItems.length && !w.length) checks.appendChild(h("p", { class: "ok-text small" }, "✓ アレルギー・重複・相互作用（登録分）の警告はありません"));
      for (const x of w) checks.appendChild(h("div", { class: "chk " + x.level }, x.level === "danger" ? "⛔ " : x.level === "warn" ? "⚠ " : "ℹ ", x.msg));
    }
    box.append(
      h("div", { class: "rx-head" }, h("h3", null, "処方"), typeSel,
        last ? h("button", {
          type: "button", class: "btn sm", onclick: () => {
            const add = last.items.filter(it => !c.rxItems.some(x => x.name === it.name)).map(it => Object.assign({}, it));
            c.rxItems.push(...add); changed(); drawItems();
            U.toast(add.length ? `前回（${U.jdate(last.date)}）の処方 ${add.length}件をコピーしました` : "前回の処方はすでに入っています", "ok");
          }
        }, `前回Do（${U.jdate(last.date)}）`) : null),
      h("div", { class: "drug-search" }, search, dd), itemsBox, checks);
    drawItems();
  }

  // ---------- 病名タブ ----------
  function tabProblems(pane, p) {
    const list = ST.problemsOf(p.id);
    const canEdit = ST.can("problem.edit");
    pane.appendChild(h("div", { class: "page-head sub" }, h("h2", null, "病名"), canEdit ? h("button", { class: "btn primary", onclick: () => problemDialog(p) }, "＋ 病名を追加") : null));
    if (!list.length) { pane.appendChild(h("p", { class: "muted" }, "登録された病名はありません。")); return; }
    pane.appendChild(h("table", { class: "tbl" },
      h("thead", null, h("tr", null, ["病名", "ICD-10", "区分", "開始日", "転帰", "終了日", "コメント", ""].map(x => h("th", null, x)))),
      h("tbody", null, list.map(x => h("tr", { class: x.outcome !== "継続" ? "dim" : "" },
        h("td", null, h("b", null, x.name), x.suspected ? badge("疑い", "warn") : null),
        h("td", { class: "mono" }, x.icd || ""), h("td", null, x.main ? badge("主病名", "key-dx") : ""),
        h("td", null, U.jdate(x.start)), h("td", null, x.outcome), h("td", null, U.jdate(x.end)), h("td", { class: "small" }, x.comment || ""),
        h("td", null, canEdit ? [h("button", { class: "btn sm ghost", onclick: () => problemDialog(p, x) }, "編集"),
          h("button", { class: "btn sm ghost", onclick: () => act(async () => { const r = await U.askText("病名の削除", "削除理由（誤登録など）", { required: true, danger: true, okLabel: "削除" }); if (r) { await ST.deleteProblem(x, r); render(); } }) }, "削除")] : null))))));
    pane.appendChild(h("p", { class: "muted small" }, "※ 治った病名は削除せず、転帰（治癒・中止など）を設定してください。病名マスタは試作用のサンプルです。"));
  }

  async function problemDialog(p, x) {
    x = x || {};
    const listId = "dl-dis-" + Date.now();
    const name = inp({ value: x.name || "", list: listId, placeholder: "例: 高血圧症", autocomplete: "off" });
    const icd = inp({ value: x.icd || "", class: "input mono" });
    name.addEventListener("input", () => { const d = M.diseases.find(d => d.name === name.value.trim()); if (d) icd.value = d.icd; });
    const susp = h("input", { type: "checkbox", checked: !!x.suspected });
    const main = h("input", { type: "checkbox", checked: !!x.main });
    const start = inp({ type: "date", value: x.start || ST.ymd() });
    const outcome = sel(["継続", "治癒", "中止", "軽快", "転医", "死亡"], x.outcome || "継続");
    const end = inp({ type: "date", value: x.end || "" });
    const comment = inp({ value: x.comment || "" });
    const r = await U.modal(x.id ? "病名の編集" : "病名の追加", h("div", null,
      h("datalist", { id: listId }, M.diseases.map(d => h("option", { value: d.name }, d.icd))),
      h("div", { class: "grid2" }, field("病名", name, { req: true }), field("ICD-10", icd)),
      h("div", { class: "row" }, h("label", { class: "check" }, susp, " 疑い"), h("label", { class: "check" }, main, " 主病名")),
      h("div", { class: "grid3" }, field("開始日", start, { req: true }), field("転帰", outcome), field("終了日（転帰日）", end, { hint: "転帰が継続以外で空なら今日" })),
      field("コメント", comment)
    ), [{ label: "キャンセル", value: null }, {
      label: "保存", cls: "primary", onClick: () => ST.saveProblem(p.id, { id: x.id, name: name.value, icd: icd.value.trim(), suspected: susp.checked, main: main.checked, start: start.value, outcome: outcome.value, end: end.value, comment: comment.value.trim() })
    }]);
    if (r) { U.toast("病名を保存しました", "ok"); render(); }
  }

  // ---------- 処方歴タブ ----------
  function tabRx(pane, p) {
    const list = ST.rxOf(p.id);
    pane.appendChild(h("div", { class: "page-head sub" }, h("h2", null, "処方歴")));
    if (!list.length) { pane.appendChild(h("p", { class: "muted" }, "処方はありません。")); return; }
    for (const r of list) {
      pane.appendChild(h("article", { class: "card rx-card " + (r.status === "cancelled" ? "cancelled" : "") },
        h("header", null, h("b", null, U.jdateW(r.date)), badge(r.type), r.status === "cancelled" ? badge("取消", "danger") : badge("発行済", "ok"),
          h("span", { class: "muted small grow" }, `${ST.staffName(r.issuedBy)} ${U.hm(r.issuedAt)}`),
          r.status === "issued" ? h("button", { class: "btn sm", onclick: () => PR.prescription(r) }, "処方箋印刷") : null,
          r.status === "issued" && ST.can("rx.issue") ? h("button", { class: "btn sm ghost", onclick: () => doRx(p, r).then(() => go(`#/patient/${p.id}/chart`)) }, "Do処方") : null,
          r.status === "issued" && ST.can("rx.issue") ? h("button", {
            class: "btn sm ghost", onclick: () => act(async () => {
              const reason = await U.askText("処方の取消", "取消理由", { required: true, danger: true, okLabel: "取消する", note: "院外処方箋をすでに渡している場合は、薬局・患者への連絡も行ってください。" });
              if (reason) { await ST.cancelRx(r, reason); render(); }
            })
          }, "取消") : null),
        r.cancelled ? h("p", { class: "small danger-text" }, `取消理由: ${r.cancelled.reason}（${ST.staffName(r.cancelled.by)} ${U.jdt(r.cancelled.at)}）`) : null,
        h("ol", null, r.items.map(it => h("li", null, h("b", null, it.name), it.generic === false ? badge("変更不可", "warn") : null, h("div", { class: "muted" }, ST.itemQtyText(it) + (it.comment ? "　" + it.comment : "")))))));
    }
  }

  // ---------- 検査タブ ----------
  function tabLabs(pane, p) {
    const labs = ST.labsOf(p.id);
    pane.appendChild(h("div", { class: "page-head sub" }, h("h2", null, "検査結果"),
      ST.can("lab.enter") ? h("button", { class: "btn primary", onclick: () => labDialog(p) }, "＋ 結果を入力") : null));
    if (!labs.length) { pane.appendChild(h("p", { class: "muted" }, "検査結果はありません。")); return; }
    const cols = labs.slice().reverse(); // 新しい順
    const valsByLab = cols.map(l => ST.labValues(l, p));
    const rows = M.labs.filter(d => valsByLab.some(v => v[d.code] !== undefined));
    pane.appendChild(h("div", { class: "table-scroll" }, h("table", { class: "tbl lab-tbl" },
      h("thead", null, h("tr", null, h("th", null, "項目"), h("th", null, "基準値"), cols.map(l => h("th", { class: "c" }, U.jdate(l.date),
        ST.can("lab.enter") ? h("button", { class: "icon-btn sm", "aria-label": `${l.date}の結果を削除`, title: "誤入力の削除", onclick: () => act(async () => { const r = await U.askText("検査結果の削除", "削除理由", { required: true, danger: true, okLabel: "削除" }); if (r) { await ST.deleteLab(l, r); render(); } }) }, "×") : null)))),
      h("tbody", null, rows.map(d => {
        const ref = ST.labRef(d, p.sex);
        return h("tr", null,
          h("th", null, h("button", { class: "linkish", onclick: () => labTrend(p, d) }, d.name), h("small", { class: "muted" }, " " + d.unit)),
          h("td", { class: "muted small" }, ref ? `${ref[0] ?? ""}〜${ref[1] ?? ""}` : ""),
          valsByLab.map(v => {
            const val = v[d.code], f = ST.labFlag(d, val, p.sex);
            return h("td", { class: "c " + (f ? "flag-" + f : "") }, val === undefined ? "" : String(val), f ? h("b", { class: "flag" }, " " + f) : null);
          }));
      })))));
    pane.appendChild(h("p", { class: "muted small" }, "H=基準値より高い　L=基準値より低い。基準値は JCCLS 共用基準範囲を参考にした例です。eGFR は日本人の推算式（Cr・年齢・性別）で自動計算。項目名をクリックすると経過グラフを表示。"));
  }

  function labTrend(p, d) {
    const pts = ST.labsOf(p.id).map(l => ({ d: l.date, y: ST.labValues(l, p)[d.code] })).filter(x => x.y !== undefined);
    const ref = ST.labRef(d, p.sex);
    U.modal(d.name, CH.lineChart({ title: d.name, unit: d.unit, series: [{ name: d.code, slot: 1, points: pts }], band: ref }), null, { wide: true });
  }

  async function labDialog(p) {
    const date = inp({ type: "date", value: ST.ymd(), max: ST.ymd() });
    const ins = {};
    const grid = h("div", { class: "lab-grid" }, M.labs.filter(d => !d.calc).map(d => {
      ins[d.code] = inp({ type: "number", step: "any", class: "input num", inputmode: "decimal" });
      const ref = ST.labRef(d, p.sex);
      return h("label", { class: "lab-in" }, h("span", null, d.name), ins[d.code], h("small", { class: "muted" }, `${d.unit}${ref ? `（${ref[0] ?? ""}〜${ref[1] ?? ""}）` : ""}`));
    }));
    const comment = inp({ placeholder: "検査機関・備考など" });
    const r = await U.modal("検査結果の入力", h("div", null, h("div", { class: "grid2" }, field("検査日", date), field("コメント", comment)), grid), [{ label: "キャンセル", value: null }, {
      label: "保存", cls: "primary", onClick: () => {
        const values = {};
        for (const [k, el] of Object.entries(ins)) values[k] = el.value;
        return ST.saveLab(p.id, { date: date.value, values, comment: comment.value.trim() });
      }
    }], { wide: true });
    if (r) { U.toast("検査結果を保存しました", "ok"); render(); }
  }

  // ---------- 経過グラフタブ ----------
  function tabVitals(pane, p) {
    const byDate = new Map();
    for (const n of ST.notesOf(p.id).slice().reverse()) {
      if (n.deleted || !n.versions.length) continue;
      const v = n.versions[n.versions.length - 1].content.vitals || {};
      if (Object.keys(v).length) byDate.set(n.date, Object.assign(byDate.get(n.date) || {}, v));
    }
    const rows = Array.from(byDate.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    pane.appendChild(h("div", { class: "page-head sub" }, h("h2", null, "経過グラフ（確定済みカルテのバイタル）")));
    if (!rows.length) { pane.appendChild(h("p", { class: "muted" }, "バイタルの記録がありません。")); return; }
    const pts = k => rows.filter(([, v]) => typeof v[k] === "number").map(([d, v]) => ({ d, y: v[k] }));
    const charts = h("div", { class: "charts" },
      CH.lineChart({ title: "血圧", unit: "mmHg", series: [{ name: "収縮期", slot: 1, points: pts("sbp") }, { name: "拡張期", slot: 2, points: pts("dbp") }] }),
      CH.lineChart({ title: "脈拍", unit: "/分", series: [{ name: "脈拍", slot: 1, points: pts("pulse") }] }),
      pts("weight").length ? CH.lineChart({ title: "体重", unit: "kg", series: [{ name: "体重", slot: 1, points: pts("weight") }] }) : null,
      CH.lineChart({ title: "体温", unit: "℃", series: [{ name: "体温", slot: 1, points: pts("bt") }] }),
      pts("spo2").length ? CH.lineChart({ title: "SpO₂", unit: "%", series: [{ name: "SpO₂", slot: 1, points: pts("spo2") }] }) : null);
    pane.appendChild(charts);
    const labHb = ST.labsOf(p.id).filter(l => l.values.HbA1c !== undefined);
    if (labHb.length) pane.appendChild(h("div", { class: "charts" }, CH.lineChart({ title: "HbA1c", unit: "%", series: [{ name: "HbA1c", slot: 1, points: labHb.map(l => ({ d: l.date, y: l.values.HbA1c })) }], band: ST.labRef(M.labs.find(x => x.code === "HbA1c"), p.sex) })));
    pane.appendChild(h("details", { class: "card" }, h("summary", null, "表で見る"),
      h("table", { class: "tbl" }, h("thead", null, h("tr", null, ["日付", "体温", "血圧", "脈拍", "SpO₂", "体重", "BMI"].map(x => h("th", null, x)))),
        h("tbody", null, rows.slice().reverse().map(([d, v]) => h("tr", null, h("td", null, U.jdate(d)), h("td", null, v.bt ?? ""), h("td", null, v.sbp ? `${v.sbp}/${v.dbp ?? "-"}` : ""), h("td", null, v.pulse ?? ""), h("td", null, v.spo2 ?? ""), h("td", null, v.weight ?? ""), h("td", null, calcBmi(Object.assign({ height: lastHeight(p.id) }, v)))))))));
  }

  // ---------- 文書タブ ----------
  function tabDocs(pane, p) {
    const can = ST.can("doc.write");
    pane.appendChild(h("div", { class: "page-head sub" }, h("h2", null, "文書"),
      can ? h("div", { class: "row" }, h("button", { class: "btn primary", onclick: () => docDialog(p, { kind: "診療情報提供書" }) }, "＋ 診療情報提供書"), h("button", { class: "btn", onclick: () => docDialog(p, { kind: "診断書" }) }, "＋ 診断書")) : null));
    const list = ST.docsOf(p.id);
    if (!list.length) { pane.appendChild(h("p", { class: "muted" }, "文書はありません。")); return; }
    pane.appendChild(h("table", { class: "tbl" }, h("thead", null, h("tr", null, ["作成日", "種類", "宛先・病名", "作成者", ""].map(x => h("th", null, x)))),
      h("tbody", null, list.map(d => h("tr", null, h("td", null, U.jdate(d.date)), h("td", null, d.kind), h("td", null, d.kind === "診断書" ? d.diagnosis : `${d.toHospital || ""} ${d.toDept || ""}`),
        h("td", null, ST.staffName(d.createdBy)),
        h("td", null, h("button", { class: "btn sm", onclick: () => PR.referral(d) }, "印刷"), can ? h("button", { class: "btn sm ghost", onclick: () => docDialog(p, d) }, "編集") : null))))));
  }

  async function docDialog(p, d0) {
    const isNew = !d0.id;
    const probs = ST.problemsOf(p.id).filter(x => x.outcome === "継続").map(x => x.name + (x.suspected ? "（疑い）" : "")).join("\n");
    const lastNote = ST.notesOf(p.id).find(n => !n.deleted && n.versions.length);
    const lc = lastNote ? lastNote.versions[lastNote.versions.length - 1].content : null;
    const rx = ST.lastActiveRx(p.id);
    const labs = ST.labsOf(p.id);
    const lastLab = labs[labs.length - 1];
    let labText = "";
    if (lastLab) {
      const vals = ST.labValues(lastLab, p);
      labText = `【${U.jdate(lastLab.date)} 検査】` + M.labs.filter(x => vals[x.code] !== undefined).map(x => `${x.code} ${vals[x.code]}${ST.labFlag(x, vals[x.code], p.sex) ? "(" + ST.labFlag(x, vals[x.code], p.sex) + ")" : ""}`).join("、");
    }
    const d = Object.assign(isNew ? {
      date: ST.ymd(), diagnosis: probs,
      history: [p.history ? "既往歴: " + p.history : "", p.familyHistory ? "家族歴: " + p.familyHistory : "", (p.allergies || []).length ? "アレルギー: " + p.allergies.map(a => a.substance + (a.reaction ? `（${a.reaction}）` : "")).join("、") : ""].filter(Boolean).join("\n"),
      course: [lc ? [lc.S, lc.O, lc.A].filter(Boolean).join("\n") : "", labText].filter(Boolean).join("\n"),
      treatment: lc ? lc.P : "", meds: rx ? rx.items.map(it => `${it.name}　${ST.itemQtyText(it)}`).join("\n") : "",
      toHospital: "", toDept: "", toDoctor: "", purpose: "", remarks: "", body: ""
    } : {}, d0);
    const F = {};
    const t = (k, rows) => (F[k] = ta({ rows: rows || 3, value: d[k] || "" }));
    const i = (k, a) => (F[k] = inp(Object.assign({ value: d[k] || "" }, a)));
    const body = d.kind === "診断書"
      ? h("div", null, field("日付", i("date", { type: "date" })), field("病名", t("diagnosis", 2)), field("付記（診断の内容・就労や通学の可否など）", t("body", 6)))
      : h("div", null,
        h("div", { class: "grid4" }, field("日付", i("date", { type: "date" })), field("紹介先医療機関", i("toHospital")), field("診療科", i("toDept")), field("医師名", i("toDoctor"))),
        field("紹介目的", t("purpose", 2)), h("div", { class: "grid2" }, field("傷病名", t("diagnosis")), field("既往歴・家族歴・アレルギー", t("history"))),
        field("症状経過・検査結果", t("course", 5)), h("div", { class: "grid2" }, field("治療経過", t("treatment")), field("現在の処方", t("meds"))), field("備考", t("remarks", 2)));
    const r = await U.modal(d.kind + (isNew ? "の作成" : "の編集"), body, [{ label: "キャンセル", value: null }, {
      label: "保存して印刷", cls: "primary", onClick: async () => {
        const data = Object.assign({}, d0, { kind: d.kind });
        for (const [k, el] of Object.entries(F)) data[k] = el.value;
        return ST.saveDoc(p.id, data);
      }
    }], { wide: true, sticky: true });
    if (r) { render(); PR.referral(r); }
  }

  // ---------- 患者情報タブ ----------
  function tabInfo(pane, p) {
    if (!ST.can("patient.edit")) { pane.appendChild(h("p", null, "閲覧のみ")); return; }
    pane.appendChild(patientForm(p, () => { U.toast("患者情報を保存しました", "ok"); render(); }));
    const revs = (p.revisions || []).slice().reverse();
    pane.appendChild(h("p", { class: "muted small" }, `登録 ${U.jdt(p.createdAt)} ${ST.staffName(p.createdBy)}　最終更新 ${U.jdt(p.updatedAt)} ${ST.staffName(p.updatedBy)}`));
    if (revs.length) pane.appendChild(h("details", { class: "card" }, h("summary", null, `変更履歴（${revs.length}件）`),
      h("table", { class: "tbl" }, h("thead", null, h("tr", null, h("th", null, "日時"), h("th", null, "変更者"), h("th", null, "変更前の値"))),
        h("tbody", null, revs.map(rv => h("tr", null, h("td", null, U.jdt(rv.at)), h("td", null, ST.staffName(rv.by)),
          h("td", { class: "small" }, Object.entries(rv.before).map(([k, v]) => h("div", null, h("b", null, k + ": "), typeof v === "object" ? JSON.stringify(v) : String(v ?? ""))))))))));
  }

  // ---------- 受診歴タブ ----------
  function tabVisits(pane, p) {
    const list = ST.encounters().filter(e => e.patientId === p.id).sort((a, b) => b.date.localeCompare(a.date));
    pane.appendChild(h("div", { class: "page-head sub" }, h("h2", null, `受診歴（${list.filter(e => e.status !== "cancelled").length}回）`)));
    pane.appendChild(h("table", { class: "tbl" }, h("thead", null, h("tr", null, ["日付", "受付", "診療科", "区分", "主訴", "状態", "担当医"].map(x => h("th", null, x)))),
      h("tbody", null, list.map(e => h("tr", { class: e.status === "cancelled" ? "dim" : "" }, h("td", null, U.jdateW(e.date)), h("td", null, U.hm(e.receptionAt)), h("td", null, e.dept), h("td", null, e.visitType),
        h("td", null, e.complaint || ""), h("td", null, M.encStatus[e.status], e.status === "cancelled" ? h("small", { class: "muted" }, `（${(e.statusLog || []).slice(-1)[0].reason || ""}）`) : null),
        h("td", null, e.doctorId ? ST.staffName(e.doctorId) : ""))))));
  }

  // ---------- 操作履歴タブ ----------
  function tabLog(pane, p) {
    const list = Array.from(ST.S.col.audit.values()).filter(a => a.patientId === p.id).sort((a, b) => b.seq - a.seq);
    pane.appendChild(h("div", { class: "page-head sub" }, h("h2", null, "この患者の操作履歴")));
    pane.appendChild(auditTable(list));
  }

  function auditTable(list) {
    return h("div", { class: "table-scroll" }, h("table", { class: "tbl small" },
      h("thead", null, h("tr", null, ["#", "日時", "利用者", "操作", "患者", "内容"].map(x => h("th", null, x)))),
      h("tbody", null, list.map(a => {
        const p = a.patientId ? ST.patient(a.patientId) : null;
        return h("tr", null, h("td", { class: "mono muted" }, a.seq), h("td", { class: "nowrap" }, U.jdt(a.at)), h("td", null, a.userName), h("td", null, a.action),
          h("td", null, p ? h("a", { href: `#/patient/${p.id}/${ST.can("clinical.view") ? "chart" : "info"}` }, `${p.pid} ${p.name}`) : ""), h("td", null, a.detail));
      }))));
  }

  // ======================================================================
  // 管理
  // ======================================================================
  async function viewAdmin(main) {
    ST.need("admin");
    const s = ST.settings();
    main.appendChild(h("div", { class: "page-head" }, h("h1", null, "管理")));

    // 施設情報
    const F = {
      clinicName: inp({ value: s.clinicName }), address: inp({ value: s.address }), phone: inp({ value: s.phone }), institutionCode: inp({ value: s.institutionCode, class: "input mono" }),
      depts: inp({ value: (s.depts || []).join("、") }), autoLockMin: inp({ type: "number", min: 0, max: 120, value: s.autoLockMin })
    };
    main.appendChild(h("section", { class: "card" }, h("h2", null, "施設情報・設定"),
      h("div", { class: "grid2" }, field("医療機関名", F.clinicName), field("医療機関コード", F.institutionCode)),
      h("div", { class: "grid2" }, field("所在地", F.address), field("電話番号", F.phone)),
      h("div", { class: "grid2" }, field("診療科（読点で区切る）", F.depts), field("自動ロックまでの分数（0で無効）", F.autoLockMin)),
      h("button", {
        class: "btn primary", onclick: () => act(async () => {
          const depts = F.depts.value.split(/[、,，\s]+/).map(x => x.trim()).filter(Boolean);
          if (!depts.length) throw new Error("診療科を1つ以上入力してください");
          await ST.saveSettings({ clinicName: F.clinicName.value.trim(), address: F.address.value.trim(), phone: F.phone.value.trim(), institutionCode: F.institutionCode.value.trim(), depts, autoLockMin: Math.max(0, Number(F.autoLockMin.value) || 0) });
          buildShell(); render();
        }, "設定を保存しました")
      }, "保存")));

    // 利用者
    const logins = await ST.loginInfo();
    const userRows = ST.staffList().sort((a, b) => (b.active - a.active) || a.createdAt.localeCompare(b.createdAt)).map(st => {
      const li = logins.find(x => x.id === st.id) || {};
      const locked = li.lockedUntil && li.lockedUntil > Date.now();
      return h("tr", { class: st.active ? "" : "dim" },
        h("td", { class: "mono" }, st.loginId), h("td", null, st.name), h("td", null, M.roles[st.role], st.admin ? badge("管理者", "key-dx") : null),
        h("td", null, !st.active ? badge("停止中", "danger") : locked ? badge("ロック中", "warn") : st.mustChange ? badge("初期パスワード", "warn") : badge("有効", "ok")),
        h("td", null,
          h("button", { class: "btn sm ghost", onclick: () => userDialog(st) }, "編集"),
          h("button", { class: "btn sm ghost", onclick: () => resetPw(st) }, st.active ? "パスワード再発行" : "再開（新パスワード）"),
          st.active && st.id !== ST.S.user.id ? h("button", {
            class: "btn sm ghost", onclick: () => act(async () => {
              if (await U.confirmDlg("利用停止", `${st.name} さんを利用停止にしますか？\nこのIDの暗号鍵が削除され、ログインできなくなります。`, "停止する", true)) { await ST.deactivateUser(st.id); render(); }
            })
          }, "停止") : null));
    });
    main.appendChild(h("section", { class: "card" }, h("div", { class: "page-head sub" }, h("h2", null, "利用者"), h("button", { class: "btn primary", onclick: () => userDialog(null) }, "＋ 利用者を追加")),
      h("table", { class: "tbl" }, h("thead", null, h("tr", null, ["ログインID", "氏名", "職種", "状態", ""].map(x => h("th", null, x)))), h("tbody", null, userRows)),
      h("p", { class: "muted small" }, "権限: 医師＝すべての診療記録・処方・病名・文書／看護師＝看護記録・バイタル・検査入力（診療録の確定と処方は不可）／医療事務＝受付・患者登録・会計（診療内容は閲覧不可）。")));

    // 院内ネットワーク
    if (DB.mode === "server") {
      const card = h("section", { class: "card" }, h("h2", null, "院内ネットワーク（院内サーバー版）"), h("p", { class: "muted" }, "読み込み中…"));
      main.appendChild(card);
      DB.statusInfo().then(st => {
        U.clear(card).append(h("h2", null, "院内ネットワーク（院内サーバー版）"),
          h("p", null, "子機から開くアドレス: ", h("b", { class: "mono" }, (st.addresses.find(a => a.recommended) || {}).url || "（ネットワーク未接続）")),
          h("p", null, `接続中・最近つながった端末: ${st.clients.length}台　／　自動バックアップ: ${st.backups.count}日分（最新 ${st.backups.last || "なし"}）`),
          h("p", { class: "muted small" }, `親機の保存場所: ${st.dataDir}`),
          h("a", { class: "btn", href: "guide.html", target: "_blank", rel: "noopener" }, "接続ガイドを開く（子機の追加・困ったとき）"));
      }).catch(() => { U.clear(card).append(h("h2", null, "院内ネットワーク"), h("p", { class: "danger-text" }, "院内サーバーの状態を取得できませんでした")); });
    } else {
      main.appendChild(h("section", { class: "card" }, h("h2", null, "院内ネットワーク"),
        h("p", null, "今は「この端末だけで使う版」です。受付・診察室など複数の端末で同じカルテを使いたい場合は、院内サーバー版に切りかえられます（インターネット不要）。"),
        h("a", { class: "btn", href: "guide.html", target: "_blank", rel: "noopener" }, "院内ネットワークで使う方法を見る")));
    }

    // バックアップ
    const last = await ST.lastBackup();
    const file = h("input", { type: "file", accept: ".json,application/json", class: "input" });
    const counts = ["patient", "encounter", "note", "rx", "lab", "audit"].map(t => `${({ patient: "患者", encounter: "受診", note: "記載", rx: "処方", lab: "検査", audit: "監査ログ" })[t]} ${ST.S.col[t].size}`).join("　");
    let persisted = false;
    try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false; } catch (e) { /* noop */ }
    main.appendChild(h("section", { class: "card" }, h("h2", null, "バックアップ・復元"),
      h("p", null, `件数: ${counts}`),
      h("p", { class: last ? "" : "danger-text" }, last ? `前回のバックアップ: ${U.jdt(last)}` : "まだバックアップを取っていません。"),
      DB.mode === "server" ? null : h("p", { class: "muted small" }, `ブラウザの永続保存: ${persisted ? "有効（容量不足でも自動削除されにくい）" : "未許可（ブラウザが容量不足時にデータを消す可能性があります。定期的なバックアップが必須です）"}`),
      DB.mode === "server" ? h("p", { class: "small" }, "院内サーバー版では、親機が毎日自動でバックアップを作ります（30日分）。それとは別に、週に1回はここから書き出して USB メモリなど別の場所に保管してください。") : null,
      h("p", { class: "muted small" }, "バックアップファイルは暗号化されたままで出力されます。開くには、バックアップ時点で有効だった利用者のパスワードが必要です。外付け媒体など別の場所に保管してください。"),
      h("div", { class: "row" },
        h("button", {
          class: "btn primary", onclick: () => act(async () => {
            const dump = await ST.exportBackup();
            const ts = U.jdt(ST.nowIso()).replace(/[/: ]/g, "");
            U.download(`emr-backup-${ts}.json`, JSON.stringify(dump), "application/json");
            render();
          }, "バックアップを書き出しました")
        }, "バックアップを書き出す")),
      h("div", { class: "row", style: { marginTop: "12px" } }, file,
        h("button", {
          class: "btn danger", onclick: () => act(async () => {
            if (!file.files[0]) throw new Error("ファイルを選んでください");
            const obj = JSON.parse(await file.files[0].text());
            const ok = await U.askText("復元の確認", "現在のデータはすべて置き換わります。続けるには「復元」と入力してください", { required: true, danger: true, okLabel: "復元する" });
            if (ok !== "復元") return;
            await flushAll();
            await ST.importBackup(obj);
            lockMessage = "バックアップから復元しました。ログインしてください。";
            renderLogin();
          })
        }, "バックアップから復元"))));

    // デモで試したあと、本番用に最初からやり直す（この端末だけで使う版のみ）
    if (DB.mode === "local") main.appendChild(h("section", { class: "card" }, h("h2", null, "最初からやり直す"),
      h("p", null, "デモデータで試し終わって本番の運用を始めるときなどに、この端末の電子カルテのデータ（患者・カルテ・利用者・監査ログ）をすべて消して、初期設定の画面に戻します。"),
      h("p", { class: "danger-text small" }, "消したデータは元に戻せません。必要なら先にバックアップを書き出してください。"),
      h("button", {
        class: "btn danger", onclick: () => act(async () => {
          const ok = await U.askText("すべてのデータを消去", "続けるには「消去」と入力してください", { required: true, danger: true, okLabel: "すべて消去する" });
          if (ok !== "消去") { if (ok) U.toast("「消去」と入力されなかったため、中止しました", "error"); return; }
          await flushAll();
          ST.clearSession();
          await DB.replaceAll({ users: [], records: [], meta: [] });
          location.hash = "";
          location.reload();
        })
      }, "すべてのデータを消して初期設定からやり直す")));
  }

  async function userDialog(st) {
    const isNew = !st;
    st = st || { role: "doctor", admin: false };
    const loginId = inp({ value: st.loginId || "", disabled: !isNew, class: "input mono", autocomplete: "off" });
    const name = inp({ value: st.name || "" });
    const role = sel(Object.entries(M.roles), st.role);
    const admin = h("input", { type: "checkbox", checked: !!st.admin });
    const license = inp({ value: st.license || "", placeholder: "医籍登録番号など（任意）" });
    const temp = window.EMRDemo.tempPassword();
    const r = await U.modal(isNew ? "利用者の追加" : "利用者の編集", h("div", null,
      h("div", { class: "grid2" }, field("ログインID", loginId, { req: true }), field("氏名", name, { req: true })),
      h("div", { class: "grid2" }, field("職種", role), field("資格番号", license)),
      h("label", { class: "check" }, admin, " 管理者（利用者管理・設定・監査ログ・バックアップ）"),
      isNew ? h("p", { class: "notice" }, "初期パスワード: ", h("code", null, temp), "（この画面でのみ表示。本人に安全な方法で伝えてください。初回ログイン時に変更を求めます）") : null
    ), [{ label: "キャンセル", value: null }, {
      label: "保存", cls: "primary", onClick: async () => {
        if (!name.value.trim()) throw new Error("氏名を入力してください");
        if (isNew) return ST.createUser({ loginId: loginId.value, name: name.value, role: role.value, admin: admin.checked, license: license.value.trim(), password: temp });
        await ST.updateUser(st.id, { name: name.value.trim(), role: role.value, admin: admin.checked, license: license.value.trim() });
        return true;
      }
    }]);
    if (r) { U.toast("保存しました", "ok"); if (st.id === ST.S.user.id) buildShell(); render(); }
  }

  async function resetPw(st) {
    const temp = window.EMRDemo.tempPassword();
    const ok = await U.modal("パスワードの再発行", h("div", null, h("p", null, `${st.name} さんの新しい初期パスワード:`), h("p", null, h("code", { class: "big-code" }, temp)), h("p", { class: "muted small" }, "「再発行する」を押すと有効になります。本人に安全な方法で伝えてください。")),
      [{ label: "キャンセル", value: false }, { label: "再発行する", cls: "primary", onClick: async () => { await ST.resetUserPassword(st.id, temp); return true; } }]);
    if (ok) { U.toast("再発行しました", "ok"); render(); }
  }

  // ======================================================================
  // 監査ログ
  // ======================================================================
  function viewAudit(main) {
    ST.need("admin");
    const all = Array.from(ST.S.col.audit.values()).sort((a, b) => b.seq - a.seq);
    const q = inp({ type: "search", placeholder: "操作・内容・患者名で絞り込み" });
    const user = sel([["", "すべての利用者"]].concat(ST.staffList().map(s => [s.id, s.name])), "");
    const from = inp({ type: "date" }), to = inp({ type: "date" });
    const result = h("div", { class: "verify" });
    const out = h("div");
    let limit = 300;
    const filtered = () => {
      const n = ST.norm(q.value);
      return all.filter(a => {
        if (user.value && a.userId !== user.value) return false;
        const local = ST.ymd(new Date(a.at));
        if (from.value && local < from.value) return false;
        if (to.value && local > to.value) return false;
        if (n) {
          const p = a.patientId ? ST.patient(a.patientId) : null;
          const hay = ST.norm([a.action, a.detail, a.userName, p ? p.name + p.kana + p.pid : ""].join(" "));
          if (!hay.includes(n)) return false;
        }
        return true;
      });
    };
    const draw = () => {
      U.clear(out);
      const list = filtered();
      out.appendChild(h("p", { class: "muted small" }, `${list.length} 件`));
      out.appendChild(auditTable(list.slice(0, limit)));
      if (list.length > limit) out.appendChild(h("button", { class: "btn", onclick: () => { limit += 300; draw(); } }, "さらに表示"));
    };
    [q, user, from, to].forEach(el => el.addEventListener("input", () => { limit = 300; draw(); }));
    main.append(h("div", { class: "page-head" }, h("h1", null, "監査ログ"),
      h("div", { class: "row" },
        h("button", {
          class: "btn", onclick: () => act(async () => {
            U.clear(result).appendChild(h("p", { class: "muted" }, "検証中…"));
            const r = await ST.verifyAudit();
            await ST.audit("監査ログ検証", { detail: r.ok ? `正常（${r.count}件）` : `異常 ${r.errors.length}件` });
            U.clear(result).appendChild(r.ok ? h("p", { class: "ok-text" }, `✓ ${r.count} 件すべて連続しており、改変は見つかりませんでした。`)
              : h("div", { class: "notice danger" }, h("b", null, "⚠ 整合性に問題があります"), h("ul", null, r.errors.map(e => h("li", null, e)))));
          })
        }, "改ざんチェック"),
        h("button", {
          class: "btn", onclick: () => {
            const rows = [["連番", "日時", "利用者", "操作", "患者番号", "患者氏名", "内容", "ハッシュ"]].concat(filtered().slice().reverse().map(a => {
              const p = a.patientId ? ST.patient(a.patientId) : null;
              return [a.seq, U.jdt(a.at), a.userName, a.action, p ? p.pid : "", p ? p.name : "", a.detail, a.hash];
            }));
            const csv = "﻿" + rows.map(r => r.map(x => `"${String(x ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
            U.download(`audit-${ST.ymd()}.csv`, csv, "text/csv");
            ST.audit("監査ログ出力", { detail: "CSV" });
          }
        }, "CSV出力"))),
      h("p", { class: "muted small" }, "すべての閲覧・登録・変更・印刷・ログインを記録しています。各記録は直前の記録のハッシュを含む鎖になっており、途中の書き換えや削除を検出できます。"),
      result,
      h("div", { class: "filters" }, q, user, field("開始日", from), field("終了日", to)), out);
    draw();
  }

  boot();
})();
