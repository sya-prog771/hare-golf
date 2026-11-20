/* 画面部品（DOM を直接組み立てる。利用者の入力は必ずテキストとして入れるので HTML 注入が起きない） */
(function (g) {
  "use strict";

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k === "value") el.value = v;
      else if (k === "checked" || k === "selected" || k === "disabled" || k === "readOnly" || k === "required" || k === "multiple" || k === "autofocus") el[k] = !!v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    append(el, children);
    return el;
  }
  function append(el, children) {
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) append(el, c);
      else if (c instanceof Node) el.appendChild(c);
      else el.appendChild(document.createTextNode(String(c)));
    }
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  // ---------- トースト ----------
  function toast(msg, type) {
    let box = document.getElementById("toasts");
    if (!box) { box = h("div", { id: "toasts", role: "status", "aria-live": "polite" }); document.body.appendChild(box); }
    const t = h("div", { class: "toast " + (type || "") }, msg);
    box.appendChild(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 300); }, type === "error" ? 6000 : 2800);
  }

  // ---------- モーダル ----------
  function modal(title, body, buttons, opts) {
    opts = opts || {};
    return new Promise(resolve => {
      const prevFocus = document.activeElement;
      let done = false;
      const close = val => {
        if (done) return; done = true;
        back.remove(); document.removeEventListener("keydown", onKey, true);
        if (prevFocus && prevFocus.focus) prevFocus.focus();
        resolve(val);
      };
      const btns = (buttons || [{ label: "閉じる", value: null }]).map(b => h("button", {
        class: "btn " + (b.cls || ""), type: "button",
        onclick: async () => {
          if (b.onClick) {
            try {
              const r = await b.onClick();
              if (r === false) return;
              close(r === undefined ? b.value : r);
            } catch (e) { showErr(e); }
          } else close(b.value);
        }
      }, b.label));
      const dlg = h("div", { class: "modal " + (opts.wide ? "wide" : ""), role: "dialog", "aria-modal": "true", "aria-label": title },
        h("div", { class: "modal-head" }, h("h2", null, title), h("button", { class: "icon-btn", type: "button", "aria-label": "閉じる", onclick: () => close(null) }, "×")),
        h("div", { class: "modal-body" }, body),
        h("div", { class: "modal-foot" }, btns));
      const back = h("div", { class: "modal-back", onmousedown: e => { if (e.target === back && !opts.sticky) close(null); } }, dlg);
      function showErr(e) {
        let er = dlg.querySelector(".modal-err");
        if (!er) { er = h("div", { class: "modal-err", role: "alert" }); dlg.querySelector(".modal-body").prepend(er); }
        er.textContent = e.message || String(e);
      }
      function onKey(e) {
        if (e.key === "Escape" && !opts.sticky) { e.stopPropagation(); close(null); }
        if (e.key === "Tab") { // フォーカスをダイアログ内に閉じ込める
          const f = Array.from(dlg.querySelectorAll("button,input,select,textarea,[tabindex]:not([tabindex='-1'])")).filter(x => !x.disabled && x.offsetParent !== null);
          if (!f.length) return;
          if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
          else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
        }
      }
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(back);
      const first = dlg.querySelector("[autofocus]") || dlg.querySelector(".modal-body input, .modal-body textarea, .modal-body select") || dlg.querySelector(".modal-foot .btn.primary");
      if (first) setTimeout(() => first.focus(), 0);
    });
  }

  function confirmDlg(title, msg, okLabel, danger) {
    return modal(title, h("p", { class: "pre" }, msg), [
      { label: "キャンセル", value: false },
      { label: okLabel || "OK", value: true, cls: danger ? "danger" : "primary" }
    ]);
  }

  /** 理由などの文字入力を求める。required なら空では閉じない */
  function askText(title, label, opts) {
    opts = opts || {};
    const ta = h(opts.multiline ? "textarea" : "input", { class: "input", rows: 3, value: opts.value || "", placeholder: opts.placeholder || "" });
    return modal(title, h("label", { class: "field" }, h("span", null, label), ta, opts.note ? h("small", { class: "muted" }, opts.note) : null), [
      { label: "キャンセル", value: null },
      {
        label: opts.okLabel || "OK", cls: opts.danger ? "danger" : "primary", onClick: () => {
          const v = ta.value.trim();
          if (opts.required && !v) throw new Error(label + "を入力してください");
          return v;
        }
      }
    ]);
  }

  // ---------- 書式 ----------
  const ERAS = [["令和", "2019-05-01"], ["平成", "1989-01-08"], ["昭和", "1926-12-25"], ["大正", "1912-07-30"], ["明治", "1868-01-25"]];
  function wareki(s) {
    if (!s) return "";
    for (const [name, start] of ERAS) {
      if (s >= start) {
        const y = Number(s.slice(0, 4)) - Number(start.slice(0, 4)) + 1;
        return `${name}${y === 1 ? "元" : y}年${Number(s.slice(5, 7))}月${Number(s.slice(8, 10))}日`;
      }
    }
    return s;
  }
  function jdate(s) { if (!s) return ""; return `${s.slice(0, 4)}/${s.slice(5, 7)}/${s.slice(8, 10)}`; }
  const WD = "日月火水木金土";
  function jdateW(s) { if (!s) return ""; const d = new Date(s + "T00:00:00"); return `${jdate(s)}(${WD[d.getDay()]})`; }
  function jdt(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function hm(iso) { if (!iso) return ""; const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
  function sexLabel(s) { return s === "M" ? "男" : s === "F" ? "女" : "その他"; }

  /** 行単位の差分（LCS）。修正履歴の比較表示に使う */
  function diffLines(a, b) {
    const A = String(a || "").split("\n"), B = String(b || "").split("\n");
    const n = A.length, m = B.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { out.push({ t: "=", s: A[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: "-", s: A[i] }); i++; }
      else { out.push({ t: "+", s: B[j] }); j++; }
    }
    while (i < n) out.push({ t: "-", s: A[i++] });
    while (j < m) out.push({ t: "+", s: B[j++] });
    return out;
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || "application/octet-stream" });
    const a = h("a", { href: URL.createObjectURL(blob), download: filename });
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function debounce(fn, ms) {
    let t = null;
    const d = (...args) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, ms); };
    d.flush = (...args) => { if (t) { clearTimeout(t); t = null; return fn(...args); } };
    d.pending = () => !!t;
    return d;
  }

  g.EMRUI = { h, clear, toast, modal, confirmDlg, askText, wareki, jdate, jdateW, jdt, hm, sexLabel, diffLines, download, debounce };
})(window);
