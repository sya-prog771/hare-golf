"use strict";
const $ = (s) => document.querySelector(s);
const state = { nbId: null, nb: null, selected: new Set(), allSelected: true, templates: [], doc: null, busy: false };

// ---------- 共通 ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body && !(opts.body instanceof Blob) ? { "Content-Type": "application/json", ...(opts.headers || {}) } : opts.headers,
  });
  const ctype = res.headers.get("Content-Type") || "";
  const data = ctype.includes("json") ? await res.json() : await res.blob();
  if (!res.ok) throw new Error((data && data.error) || res.statusText);
  return data;
}
const post = (p, body, method = "POST") => api(p, { method, body: JSON.stringify(body || {}) });

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function openModal(id) { $(id).hidden = false; }
function closeModal(el) { el.closest(".modal").hidden = true; }
document.addEventListener("click", (e) => {
  if (e.target.matches("[data-close]")) closeModal(e.target);
  else if (e.target.classList.contains("modal")) e.target.hidden = true;
  if (!e.target.closest(".popover") && !e.target.classList.contains("cite")) $("#popover").hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    $("#popover").hidden = true;
    document.querySelectorAll(".modal:not([hidden])").forEach((m) => { if (m.id !== "docPanel" || !state.busy) m.hidden = true; });
  }
});

// ---------- Markdown（簡易版・外部ライブラリなし） ----------
function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\[(\d{1,2})\]/g, '<span class="cite" data-n="$1">$1</span>');
  return s;
}
function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0, para = [];
  const flush = () => { if (para.length) { out.push("<p>" + para.map(inline).join("<br>") + "</p>"); para = []; } };
  while (i < lines.length) {
    const line = lines[i], s = line.trim();
    if (!s) { flush(); i++; continue; }
    if (s.startsWith("```")) {
      flush(); const buf = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) buf.push(lines[i++]);
      out.push("<pre><code>" + esc(buf.join("\n")) + "</code></pre>"); i++; continue;
    }
    let m;
    if ((m = s.match(/^(#{1,6})\s+(.*)/))) { flush(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
    if (/^(-{3,}|\*{3,})$/.test(s)) { flush(); out.push("<hr>"); i++; continue; }
    if (s.startsWith("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const row = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      let html = "<table><thead><tr>" + row(line).map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>";
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        html += "<tr>" + row(lines[i]).map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>"; i++;
      }
      out.push(html + "</tbody></table>"); continue;
    }
    if (/^([-*・]|\d+[.)．])\s+/.test(s)) {
      flush();
      // 字下げでネストするリスト
      const stack = [];
      while (i < lines.length && /^\s*([-*・]|\d+[.)．])\s+/.test(lines[i])) {
        const l = lines[i], indent = l.length - l.trimStart().length;
        const ordered = /^\s*\d/.test(l), tag = ordered ? "ol" : "ul";
        const text = l.trim().replace(/^([-*・]|\d+[.)．])\s+/, "");
        while (stack.length && indent < stack[stack.length - 1].indent) out.push(`</li></${stack.pop().tag}>`);
        const top = stack[stack.length - 1];
        if (!top || indent > top.indent) { stack.push({ indent, tag }); out.push(`<${tag}><li>`); }
        else out.push("</li><li>");
        out.push(inline(text)); i++;
        // 続きの行（字下げされた普通の文）
        while (i < lines.length && lines[i].trim() && /^\s{2,}/.test(lines[i]) && !/^\s*([-*・]|\d+[.)．])\s+/.test(lines[i])) {
          out.push("<br>" + inline(lines[i].trim())); i++;
        }
      }
      while (stack.length) out.push(`</li></${stack.pop().tag}>`);
      continue;
    }
    if (s.startsWith(">")) { flush(); out.push("<blockquote>" + inline(s.replace(/^>\s?/, "")) + "</blockquote>"); i++; continue; }
    para.push(s); i++;
  }
  flush();
  return out.join("");
}

// ---------- ストリーミング受信 ----------
let currentAbort = null;
async function streamPost(path, body, onEvent) {
  currentAbort = new AbortController();
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: currentAbort.signal });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || res.statusText); }
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}

// ---------- ノートブック ----------
async function loadNotebookList(selectId) {
  let list = await api("/api/notebooks");
  if (!list.length) { await post("/api/notebooks", { name: "はじめてのノートブック" }); list = await api("/api/notebooks"); }
  const sel = $("#nbSelect");
  sel.innerHTML = list.map((n) => `<option value="${n.id}">${esc(n.name)}（資料${n.sources}）</option>`).join("");
  const saved = selectId || localStorageGet("nb");
  const id = list.some((n) => n.id === saved) ? saved : list[0].id;
  sel.value = id;
  await openNotebook(id);
}
function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

async function openNotebook(id) {
  state.nbId = id; localStorageSet("nb", id);
  state.nb = await api(`/api/notebooks/${id}`);
  state.selected = new Set(state.nb.sources.map((s) => s.id));
  state.allSelected = true;
  renderSources(); renderChat(); renderNotes();
}
async function refreshNotebook() {
  const prev = new Set(state.nb ? state.nb.sources.map((s) => s.id) : []);
  state.nb = await api(`/api/notebooks/${state.nbId}`);
  for (const s of state.nb.sources) if (!prev.has(s.id)) state.selected.add(s.id); // 新しい資料は選択状態に
  for (const id of [...state.selected]) if (!state.nb.sources.some((s) => s.id === id)) state.selected.delete(id);
  renderSources(); renderNotes();
  const opt = $(`#nbSelect option[value="${state.nbId}"]`);
  if (opt) opt.textContent = `${state.nb.name}（資料${state.nb.sources.length}）`;
}

$("#nbSelect").addEventListener("change", (e) => openNotebook(e.target.value));
$("#nbNew").addEventListener("click", async () => {
  const name = prompt("ノートブックの名前", "新しいノートブック");
  if (name === null) return;
  const { id } = await post("/api/notebooks", { name });
  await loadNotebookList(id);
});
$("#nbRename").addEventListener("click", async () => {
  const name = prompt("新しい名前", state.nb.name);
  if (!name) return;
  await post(`/api/notebooks/${state.nbId}`, { name }, "PATCH");
  await loadNotebookList(state.nbId);
});
$("#nbDelete").addEventListener("click", async () => {
  if (!confirm(`「${state.nb.name}」を資料・メモごと削除します。よろしいですか？`)) return;
  await api(`/api/notebooks/${state.nbId}`, { method: "DELETE" });
  await loadNotebookList();
});

// ---------- 資料 ----------
function selectedIds() { return state.nb.sources.filter((s) => state.selected.has(s.id)).map((s) => s.id); }
function renderSources() {
  const list = $("#sourceList");
  const srcs = state.nb.sources;
  $("#dropHint").style.display = srcs.length ? "none" : "";
  list.innerHTML = srcs.map((s) => `
    <li class="source-item" data-id="${s.id}" title="${esc(s.title)}">
      <input type="checkbox" ${state.selected.has(s.id) ? "checked" : ""} aria-label="選択">
      <span class="kind">${esc(s.kind)}</span>
      <span class="name">${esc(s.title)}</span>
      <span class="meta">${s.chars.toLocaleString()}字</span>
      <button class="del" title="削除">✕</button>
    </li>`).join("");
  $("#checkAll").checked = srcs.length > 0 && srcs.every((s) => state.selected.has(s.id));
}
$("#sourceList").addEventListener("click", async (e) => {
  const li = e.target.closest(".source-item"); if (!li) return;
  const id = li.dataset.id;
  if (e.target.type === "checkbox") {
    e.target.checked ? state.selected.add(id) : state.selected.delete(id);
    renderSources(); return;
  }
  if (e.target.classList.contains("del")) {
    const s = state.nb.sources.find((x) => x.id === id);
    if (!confirm(`資料「${s.title}」を削除しますか？`)) return;
    await api(`/api/notebooks/${state.nbId}/sources/${id}`, { method: "DELETE" });
    await refreshNotebook(); return;
  }
  showSource(id);
});
$("#checkAll").addEventListener("change", (e) => {
  state.selected = e.target.checked ? new Set(state.nb.sources.map((s) => s.id)) : new Set();
  renderSources();
});

async function showSource(id, highlight) {
  const s = await api(`/api/notebooks/${state.nbId}/sources/${id}`);
  $("#sourceTitle").textContent = s.title;
  const body = $("#sourceBody");
  let html = esc(s.text);
  if (highlight) {
    const h = esc(highlight.trim());
    const pos = html.indexOf(h);
    if (pos >= 0) html = html.slice(0, pos) + "<mark id='hl'>" + h + "</mark>" + html.slice(pos + h.length);
  }
  body.innerHTML = html;
  openModal("#sourcePanel");
  const hl = $("#hl");
  body.scrollTop = 0;
  if (hl) hl.scrollIntoView({ block: "center" });
}

// 追加
$("#addSource").addEventListener("click", () => { $("#addStatus").textContent = ""; openModal("#addPanel"); });
async function uploadFiles(files) {
  const status = $("#addStatus");
  let ok = 0;
  for (const f of files) {
    status.textContent = `読み込み中: ${f.name}（埋め込みモデルを使う場合は少し時間がかかります）`;
    toast(`読み込み中: ${f.name}`, 60000);
    try {
      await api(`/api/notebooks/${state.nbId}/sources/upload`, { method: "POST", body: f, headers: { "X-Filename": encodeURIComponent(f.name) } });
      ok++;
    } catch (err) { status.textContent = `${f.name}: ${err.message}`; toast(`${f.name}: ${err.message}`, 5000); }
  }
  await refreshNotebook();
  if (ok) { toast(`${ok}件の資料を追加しました`); $("#addPanel").hidden = true; }
}
$("#fileInput").addEventListener("change", (e) => { uploadFiles([...e.target.files]); e.target.value = ""; });
$("#urlAdd").addEventListener("click", async () => {
  const url = $("#urlInput").value.trim(); if (!url) return;
  $("#addStatus").textContent = "ページを取得中…";
  try {
    await post(`/api/notebooks/${state.nbId}/sources/url`, { url });
    $("#urlInput").value = ""; $("#addPanel").hidden = true; toast("追加しました");
    await refreshNotebook();
  } catch (err) { $("#addStatus").textContent = err.message; }
});
$("#pasteAdd").addEventListener("click", async () => {
  const text = $("#pasteText").value.trim(); if (!text) return;
  $("#addStatus").textContent = "追加中…";
  try {
    await post(`/api/notebooks/${state.nbId}/sources/text`, { title: $("#pasteTitle").value, text });
    $("#pasteText").value = ""; $("#pasteTitle").value = ""; $("#addPanel").hidden = true; toast("追加しました");
    await refreshNotebook();
  } catch (err) { $("#addStatus").textContent = err.message; }
});
// ドラッグ＆ドロップ
let dragDepth = 0;
window.addEventListener("dragenter", (e) => { if (e.dataTransfer.types.includes("Files")) { dragDepth++; document.body.classList.add("dragging"); } });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove("dragging");
  if (e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]);
});

// ---------- チャット ----------
function citeHandler(container, citations) {
  container.addEventListener("click", (e) => {
    const el = e.target.closest(".cite"); if (!el) return;
    const c = citations.find((x) => String(x.n) === el.dataset.n); if (!c) return;
    const pop = $("#popover");
    pop.innerHTML = `<div class="src" title="資料を開く">[${c.n}] ${esc(c.title)} ↗</div>${esc(c.text)}`;
    pop.hidden = false;
    const r = el.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + "px";
    pop.style.top = (r.bottom + 6 + pop.offsetHeight > innerHeight ? Math.max(8, r.top - pop.offsetHeight - 6) : r.bottom + 6) + "px";
    pop.querySelector(".src").onclick = () => { pop.hidden = true; showSource(c.source_id, c.text.slice(0, 80)); };
  });
}
function assistantEl(content, citations) {
  const div = document.createElement("div");
  div.className = "msg assistant";
  div.innerHTML = `<div class="md">${renderMarkdown(content)}</div>`;
  const actions = document.createElement("div");
  actions.className = "msg-actions";
  actions.innerHTML = `<button class="btn small" data-a="copy">コピー</button><button class="btn small" data-a="note">メモに保存</button>`;
  actions.addEventListener("click", async (e) => {
    const a = e.target.dataset.a;
    const text = div.dataset.raw || content;
    if (a === "copy") { await navigator.clipboard.writeText(text); toast("コピーしました"); }
    if (a === "note") { await post(`/api/notebooks/${state.nbId}/notes`, { title: text.split("\n")[0].replace(/^#+\s*/, "").slice(0, 40) || "チャットの回答", content: text, kind: "chat" }); await refreshNotebook(); toast("メモに保存しました"); }
  });
  div.appendChild(actions);
  citeHandler(div, citations || []);
  return div;
}
function renderChat() {
  const log = $("#chatLog");
  log.innerHTML = "";
  if (!state.nb.chat.length) {
    log.innerHTML = `<div class="empty">資料について質問すると、資料の内容だけを根拠に、出典番号つきで答えます。
      <div class="suggest">
        <button class="btn small">この資料の要点を5つ教えて</button>
        <button class="btn small">決まったことと、まだ決まっていないことは？</button>
        <button class="btn small">数字やデータで重要なものは？</button>
      </div></div>`;
    log.querySelectorAll(".suggest button").forEach((b) => b.addEventListener("click", () => { $("#chatInput").value = b.textContent; sendChat(); }));
    return;
  }
  for (const m of state.nb.chat) {
    if (m.role === "user") {
      const d = document.createElement("div"); d.className = "msg user"; d.textContent = m.content; log.appendChild(d);
    } else log.appendChild(assistantEl(m.content, m.citations));
  }
  log.scrollTop = log.scrollHeight;
}
async function sendChat() {
  const input = $("#chatInput");
  const q = input.value.trim();
  if (!q || state.busy) return;
  if (!state.nb.sources.length) { toast("先に資料を追加してください"); return; }
  if (!selectedIds().length) { toast("左の資料にチェックを入れてください"); return; }
  input.value = "";
  const log = $("#chatLog");
  if (log.querySelector(".empty")) log.innerHTML = "";
  const u = document.createElement("div"); u.className = "msg user"; u.textContent = q; log.appendChild(u);
  const a = document.createElement("div"); a.className = "msg assistant"; a.innerHTML = `<div class="status">考えています…</div><div class="md"></div>`;
  log.appendChild(a); log.scrollTop = log.scrollHeight;
  state.busy = true; $("#chatSend").disabled = true;
  let text = "", cites = [];
  try {
    await streamPost(`/api/notebooks/${state.nbId}/chat`, { message: q, source_ids: selectedIds() }, (ev) => {
      if (ev.type === "status") a.querySelector(".status").textContent = ev.text;
      if (ev.type === "citations") cites = ev.items;
      if (ev.type === "delta") {
        text += ev.text;
        a.querySelector(".status").textContent = "";
        a.querySelector(".md").innerHTML = renderMarkdown(text);
        const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
        if (nearBottom) log.scrollTop = log.scrollHeight;
      }
      if (ev.type === "error") a.querySelector(".status").textContent = "⚠ " + ev.text;
    });
    if (text) { const done = assistantEl(text, cites); a.replaceWith(done); }
    state.nb.chat.push({ role: "user", content: q }, { role: "assistant", content: text, citations: cites });
  } catch (err) {
    a.querySelector(".status").textContent = "⚠ " + err.message;
  } finally { state.busy = false; $("#chatSend").disabled = false; }
}
$("#chatForm").addEventListener("submit", (e) => { e.preventDefault(); sendChat(); });
$("#chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); }
});
$("#clearChat").addEventListener("click", async () => {
  if (!confirm("チャット履歴を消しますか？")) return;
  await api(`/api/notebooks/${state.nbId}/chat`, { method: "DELETE" });
  state.nb.chat = []; renderChat();
});

// ---------- 文書作成 ----------
async function loadTemplates() {
  state.templates = await api("/api/templates");
  $("#templateGrid").innerHTML = state.templates.map((t) => `<button class="btn" data-kind="${t.id}">${t.icon} ${esc(t.label)}</button>`).join("");
}
$("#templateGrid").addEventListener("click", (e) => { const b = e.target.closest("[data-kind]"); if (b) generate(b.dataset.kind); });
$("#customGen").addEventListener("click", () => {
  if (!$("#extraInput").value.trim()) { toast("追加の指示を書いてください"); return; }
  generate("custom");
});

function today() { const d = new Date(); return `${d.getMonth() + 1}/${d.getDate()}`; }

function openDoc({ title, content = "", noteId = null }) {
  state.doc = { title, content, noteId };
  $("#docTitle").value = title;
  $("#docBody").innerHTML = renderMarkdown(content);
  $("#docBody").hidden = false; $("#docEditor").hidden = true; $("#docEdit").textContent = "✎ 編集";
  $("#docStatus").textContent = "";
  $("#docSave").textContent = noteId ? "上書き保存" : "メモに保存";
  openModal("#docPanel");
}
function docText() { return $("#docEditor").hidden ? state.doc.content : $("#docEditor").value; }

async function generate(kind) {
  if (state.busy) return;
  if (!selectedIds().length) { toast("資料を追加・選択してください"); return; }
  const tpl = state.templates.find((t) => t.id === kind);
  const label = tpl ? tpl.label : "文書";
  openDoc({ title: `${label}（${today()}）` });
  const body = $("#docBody"), status = $("#docStatus");
  status.textContent = "準備中…";
  state.busy = true;
  setDocButtons(false);
  let text = "";
  try {
    await streamPost(`/api/notebooks/${state.nbId}/generate`, { kind, source_ids: selectedIds(), extra: $("#extraInput").value }, (ev) => {
      if (ev.type === "status") status.textContent = ev.text;
      if (ev.type === "delta") {
        text += ev.text; state.doc.content = text;
        status.textContent = "書いています…";
        const near = body.scrollHeight - body.scrollTop - body.clientHeight < 120;
        body.innerHTML = renderMarkdown(text);
        if (near) body.scrollTop = body.scrollHeight;
      }
      if (ev.type === "done") status.textContent = `完成（${text.length.toLocaleString()}字）`;
      if (ev.type === "error") status.textContent = "⚠ " + ev.text;
    });
  } catch (err) {
    status.textContent = err.name === "AbortError" ? "停止しました" : "⚠ " + err.message;
  } finally { state.busy = false; setDocButtons(true); }
}
function setDocButtons(on) {
  $("#docStop").hidden = on;
  ["#docEdit", "#docSave", "#docCopy", "#docMd", "#docWord", "#docToSource"].forEach((s) => ($(s).disabled = !on));
}
$("#docStop").addEventListener("click", () => currentAbort && currentAbort.abort());
$("#docEdit").addEventListener("click", () => {
  const ed = $("#docEditor"), body = $("#docBody");
  if (ed.hidden) { ed.value = state.doc.content; ed.hidden = false; body.hidden = true; $("#docEdit").textContent = "👁 プレビュー"; ed.focus(); }
  else { state.doc.content = ed.value; body.innerHTML = renderMarkdown(ed.value); ed.hidden = true; body.hidden = false; $("#docEdit").textContent = "✎ 編集"; }
});
$("#docSave").addEventListener("click", async () => {
  const content = docText(), title = $("#docTitle").value.trim() || "メモ";
  state.doc.content = content;
  if (state.doc.noteId) await post(`/api/notebooks/${state.nbId}/notes/${state.doc.noteId}`, { title, content }, "PATCH");
  else { const n = await post(`/api/notebooks/${state.nbId}/notes`, { title, content, kind: "doc" }); state.doc.noteId = n.id; $("#docSave").textContent = "上書き保存"; }
  await refreshNotebook(); toast("保存しました");
});
$("#docCopy").addEventListener("click", async () => { await navigator.clipboard.writeText(docText()); toast("コピーしました"); });
function download(blob, name) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const safeName = (s) => (s || "document").replace(/[\\/:*?"<>|]/g, "_");
$("#docMd").addEventListener("click", () => download(new Blob([docText()], { type: "text/markdown" }), safeName($("#docTitle").value) + ".md"));
$("#docWord").addEventListener("click", async () => {
  try {
    const blob = await api("/api/export/docx", { method: "POST", body: JSON.stringify({ title: $("#docTitle").value, markdown: docText() }) });
    download(blob, safeName($("#docTitle").value) + ".docx");
  } catch (err) { toast(err.message, 5000); }
});
$("#docToSource").addEventListener("click", async () => {
  await post(`/api/notebooks/${state.nbId}/sources/text`, { title: $("#docTitle").value, text: docText() });
  await refreshNotebook(); toast("資料に追加しました");
});

// メモ一覧
function renderNotes() {
  const notes = state.nb.notes;
  $("#noteList").innerHTML = notes.length ? notes.map((n) => `
    <li class="note-item" data-id="${n.id}">
      <div class="t">${esc(n.title)}</div>
      <div class="p">${esc(n.content.replace(/[#*|>-]/g, " ").slice(0, 120))}</div>
    </li>`).join("") : `<li class="muted small">作った文書やチャットの回答を保存できます</li>`;
}
$("#noteList").addEventListener("click", (e) => {
  const li = e.target.closest(".note-item"); if (!li) return;
  const n = state.nb.notes.find((x) => x.id === li.dataset.id);
  openDoc({ title: n.title, content: n.content, noteId: n.id });
  addDeleteToDoc(n.id);
});
function addDeleteToDoc(noteId) {
  let btn = $("#docDelete");
  if (!btn) {
    btn = document.createElement("button"); btn.id = "docDelete"; btn.className = "btn ghost"; btn.textContent = "削除";
    $("#docPanel .modal-foot").prepend(btn);
  }
  btn.hidden = false;
  btn.onclick = async () => {
    if (!confirm("このメモを削除しますか？")) return;
    await api(`/api/notebooks/${state.nbId}/notes/${noteId}`, { method: "DELETE" });
    $("#docPanel").hidden = true; await refreshNotebook();
  };
}
const _openDoc = openDoc;
openDoc = function (o) { const b = $("#docDelete"); if (b) b.hidden = true; _openDoc(o); };
$("#newNote").addEventListener("click", () => {
  openDoc({ title: `メモ（${today()}）`, content: "" });
  $("#docEdit").click();
});

// ---------- 設定 ----------
async function loadConfig() {
  const c = await api("/api/config");
  $("#cfgBackend").value = c.backend; $("#cfgUrl").value = c.url; $("#cfgModel").value = c.model;
  $("#cfgEmbed").value = c.embed_model; $("#cfgCtx").value = c.num_ctx; $("#cfgTemp").value = c.temperature;
  return c;
}
async function checkConnection(show) {
  const r = await api("/api/models");
  const dot = $("#llmDot");
  dot.className = "dot " + (r.error ? "ng" : "ok");
  $("#modelList").innerHTML = r.models.map((m) => `<option value="${esc(m)}">`).join("");
  if (show) $("#cfgStatus").textContent = r.error ? "⚠ " + r.error : `接続OK：${r.models.length}個のモデルが見つかりました（${r.models.slice(0, 6).join("、")}${r.models.length > 6 ? "…" : ""}）`;
  return r;
}
$("#openSettings").addEventListener("click", async () => {
  await loadConfig(); $("#cfgStatus").textContent = ""; openModal("#settingsPanel"); checkConnection(true);
});
$("#cfgBackend").addEventListener("change", (e) => {
  $("#cfgUrl").value = e.target.value === "ollama" ? "http://localhost:11434" : "http://localhost:1234/v1";
});
function cfgFromForm() {
  return { backend: $("#cfgBackend").value, url: $("#cfgUrl").value.trim(), model: $("#cfgModel").value.trim(),
    embed_model: $("#cfgEmbed").value.trim(), num_ctx: +$("#cfgCtx").value || 16384, temperature: +$("#cfgTemp").value };
}
$("#cfgTest").addEventListener("click", async () => { await post("/api/config", cfgFromForm(), "PUT"); $("#cfgStatus").textContent = "確認中…"; checkConnection(true); });
$("#cfgSave").addEventListener("click", async () => {
  await post("/api/config", cfgFromForm(), "PUT"); $("#settingsPanel").hidden = true; toast("保存しました"); checkConnection(false);
});
$("#cfgReembed").addEventListener("click", async () => {
  await post("/api/config", cfgFromForm(), "PUT");
  $("#cfgStatus").textContent = "作り直しています…（資料が多いと数分かかります）";
  try { const r = await post(`/api/notebooks/${state.nbId}/reembed`); $("#cfgStatus").textContent = `${r.updated}件の資料を更新しました`; await refreshNotebook(); }
  catch (err) { $("#cfgStatus").textContent = "⚠ " + err.message; }
});

// ---------- スマホ用タブ ----------
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + b.dataset.pane));
});

// ---------- 起動 ----------
(async () => {
  try {
    await loadTemplates();
    await loadNotebookList();
    const c = await loadConfig();
    const r = await checkConnection(false);
    if (!c.model) {
      if (r.models.length) toast("⚙ 設定から使うモデルを選んでください", 5000);
      else toast("LLMにつながりません。Ollama を起動して ⚙ 設定を確認してください", 6000);
    }
  } catch (err) { toast("起動エラー: " + err.message, 8000); }
})();
