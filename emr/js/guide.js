/* 接続ガイド: 親機から配信されたときは、子機用アドレス・QRコード・接続中の端末をその場で表示する */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---- Windows / Mac の切りかえ（開いている端末に合わせて最初の表示を選ぶ）
  function setOs(os) {
    document.querySelectorAll(".g-os button").forEach(b => { const on = b.dataset.os === os; b.classList.toggle("on", on); b.setAttribute("aria-selected", on ? "true" : "false"); });
    document.querySelectorAll(".os-win").forEach(el => { el.hidden = os !== "win"; });
    document.querySelectorAll(".os-mac").forEach(el => { el.hidden = os !== "mac"; });
    try { localStorage.setItem("emr-guide-os", os); } catch (e) { /* 使えない */ }
  }
  document.querySelectorAll(".g-os button").forEach(b => b.addEventListener("click", () => setOs(b.dataset.os)));
  let os = /Mac/.test(navigator.platform || navigator.userAgent) && !/iPhone|iPad/.test(navigator.userAgent) ? "mac" : "win";
  try { os = localStorage.getItem("emr-guide-os") || os; } catch (e) { /* noop */ }

  // ---- 準備物のチェック（この端末に覚えておく）
  document.querySelectorAll(".g-check input").forEach(cb => {
    try { cb.checked = localStorage.getItem("emr-guide-" + cb.dataset.k) === "1"; } catch (e) { /* noop */ }
    cb.addEventListener("change", () => { try { localStorage.setItem("emr-guide-" + cb.dataset.k, cb.checked ? "1" : "0"); } catch (e) { /* noop */ } });
  });

  // ---- 親機の状態
  let lastUrl = "";
  async function refresh() {
    if (!/^https?:$/.test(location.protocol)) return;
    let st;
    try {
      const r = await fetch("api/status", { cache: "no-store" });
      st = await r.json();
      if (!st || st.app !== "emr") throw new Error();
    } catch (e) {
      if (!$("live-on").hidden) {
        $("live-warn").innerHTML = '<div class="notice danger">⚠ 親機と通信できません。親機の黒い画面が開いているか確認してください。</div>';
      }
      return;
    }
    // 院内サーバーの状態は、親機の場合 OS も分かる
    if (!osChosenByUser && st.os) setOs(st.os === "darwin" ? "mac" : "win");
    $("live-off").hidden = true;
    $("live-on").hidden = false;
    const best = st.addresses.find(a => a.recommended);
    const url = best ? best.url : `http://localhost:${st.port}`;
    $("live-url").textContent = best ? best.url : "（ネットワーク未接続）";
    if (url !== lastUrl) {
      lastUrl = url;
      const qr = qrcode(0, "M"); qr.addData(url); qr.make();
      $("live-qr").innerHTML = qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true });
    }
    const others = st.addresses.filter(a => !a.recommended && a.score > -2);
    $("live-alt").innerHTML = (others.length ? `つながらないときはこちらも：${others.map(a => `<code>${esc(a.url)}</code>`).join(" ")}<br>` : "")
      + (st.mdnsUrl ? `名前で開く場合：<code>${esc(st.mdnsUrl)}</code>（アドレスが変わってもつながる。Android は不可のことあり）` : "");
    const isLocal = /^(127\.|::1)/.test(st.yourIp);
    $("live-you").innerHTML = isLocal ? "いま見ているのは<b>親機</b>です。" : `<span class="ok-text">✓ この端末（${esc(st.yourIp)}）は親機につながっています。</span>`;
    const warn = [];
    if (!best) warn.push("親機がネットワークにつながっていません。Wi-Fi または LANケーブルを確認してください（親機だけで使うならこのままで大丈夫です）。");
    else if (best.score <= -2) warn.push("親機がルーターから番号（IPアドレス）をもらえていません。Wi-Fi または LANケーブルの接続を確認してください。");
    if (st.ipChanged) warn.push(`前回（${esc(st.ipChanged.from)}）とアドレスが変わりました。子機のブックマーク・ホーム画面のアイコンを、上のアドレスで作り直してください。「やっておくと安心な設定」の「アドレスが変わらないようにする」もおすすめです。`);
    if (!st.initialized) warn.push('まだ初期設定がされていません。親機で「電子カルテを開く」を押して初期設定をしてください（<a href="#step5">手順5</a>）。');
    $("live-warn").innerHTML = warn.map(w => `<div class="notice warn">⚠ ${w}</div>`).join("");
    $("live-count").textContent = `${st.clients.length}台`;
    $("live-clients").innerHTML = st.clients.length
      ? st.clients.sort((a, b) => b.lastSeen - a.lastSeen).map(c => `<li><span class="dot ${c.connected ? "on" : ""}"></span><b>${esc(c.device)}</b> <span class="muted">${esc(c.ip)}</span>${c.user ? ` ・ ${esc(c.user)}` : ""}<span class="muted small">　${c.connected ? "接続中" : Math.round((Date.now() - c.lastSeen) / 60000) + "分前"}</span></li>`).join("")
      : '<li class="muted">まだありません（子機で電子カルテを開いてログインすると、ここに表示されます）</li>';
    $("live-data").textContent = `患者データなどのレコード ${st.records} 件　／　自動バックアップ ${st.backups.count} 日分${st.backups.last ? `（最新 ${st.backups.last}）` : ""}　／　保存場所 ${st.dataDir}`;
    if (st.mdnsUrl) $("mdns-url").textContent = st.mdnsUrl;
  }
  let osChosenByUser = false;
  try { osChosenByUser = !!localStorage.getItem("emr-guide-os"); } catch (e) { /* noop */ }
  document.querySelectorAll(".g-os button").forEach(b => b.addEventListener("click", () => { osChosenByUser = true; }));
  setOs(os);

  $("copy-btn").addEventListener("click", () => {
    const text = lastUrl;
    const done = () => { $("copy-btn").textContent = "コピーしました ✓"; setTimeout(() => { $("copy-btn").textContent = "アドレスをコピー"; }, 2000); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, () => { });
    else {
      const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { /* noop */ }
      ta.remove();
    }
  });

  refresh();
  setInterval(refresh, 5000);
})();
