"""質問への回答（出典つき）と、文書の作成（要約・議事録・計画書など）"""
import prompts
from retrieve import search


def _event(kind, **kw):
    return {"type": kind, **kw}


def answer(store, llm, nb_id, question, src_ids, history, top_k=8):
    """資料から関係する部分を探し、それだけを見せて答えさせる（RAG）"""
    yield _event("status", text="資料を検索しています…")
    chunks = store.load_chunks(nb_id, src_ids, llm.embed_model)
    if not chunks:
        yield _event("error", text="資料がありません。左の「＋ 資料を追加」から追加してください。")
        return

    qvec = None
    if any(c["vec"] for c in chunks):
        try:
            qvec = llm.embed([question])[0]
        except Exception as e:
            yield _event("status", text=f"意味検索は使えません（{e}）。キーワード検索で続けます")
    hits = search(question, chunks, qvec, top_k=top_k)

    citations = []
    context = []
    for n, h in enumerate(hits, 1):
        citations.append({"n": n, "source_id": h["source_id"], "title": h["source_title"],
                          "chunk": h["chunk"], "text": h["text"]})
        context.append(f"[{n}] 資料「{h['source_title']}」より\n{h['text']}")
    yield _event("citations", items=citations)

    hist = "\n".join(f"{'ユーザー' if m['role'] == 'user' else 'アシスタント'}: {m['content'][:800]}"
                     for m in history[-6:]) or "（なし）"
    messages = [
        {"role": "system", "content": prompts.CHAT_SYSTEM},
        {"role": "user", "content": prompts.CHAT_USER.format(
            context="\n\n".join(context), history=hist, question=question)},
    ]
    yield _event("status", text="回答を書いています…")
    for piece in llm.stream_chat(messages):
        yield _event("delta", text=piece)
    yield _event("done")


def _source_texts(store, nb_id, src_ids):
    out = []
    for s in store.list_sources(nb_id):
        if src_ids is None or s["id"] in src_ids:
            src = store.get_source(nb_id, s["id"])
            out.append((src["title"], src["text"]))
    return out


def _split_parts(sources, budget):
    """資料全体を budget 文字以内のかたまりに分ける（資料の区切りもなるべく保つ）"""
    parts, cur = [], ""
    for title, text in sources:
        header = f"### 資料：{title}\n"
        while text:
            room = budget - len(cur) - len(header)
            if room < 500 and cur:
                parts.append(cur)
                cur = ""
                continue
            piece, text = text[:room], text[room:]
            if text:  # 切れ目をなるべく改行に合わせる
                cut = piece.rfind("\n", int(room * 0.7))
                if cut > 0:
                    piece, text = piece[:cut], piece[cut:] + text
            cur += header + piece.strip() + "\n\n"
            header = f"### 資料：{title}（続き）\n"
    if cur.strip():
        parts.append(cur)
    return parts


def generate(store, llm, nb_id, kind, src_ids, extra="", budget=12000):
    if kind == "custom":
        tpl = {"label": "文書", "instruction": "以下の指示どおりの文書を作成してください。", "map": extra}
    else:
        tpl = prompts.TEMPLATES.get(kind)
        if not tpl:
            yield _event("error", text=f"不明な種類です: {kind}")
            return
    sources = _source_texts(store, nb_id, src_ids)
    if not sources:
        yield _event("error", text="資料がありません。左の「＋ 資料を追加」から追加してください。")
        return
    extra_txt = f"\n# 追加の指示（最優先で従う）\n{extra}" if extra.strip() else ""

    parts = _split_parts(sources, budget)
    # 長すぎる場合: 部分ごとに要点を抜き出し（map）、それをまとめて最終文書にする（reduce）
    round_ = 0
    while len(parts) > 1:
        round_ += 1
        notes = []
        for i, part in enumerate(parts, 1):
            yield _event("status", text=f"資料が長いので分けて読んでいます…（{round_}周目 {i}/{len(parts)}）")
            msg = prompts.MAP_USER.format(total=len(parts), index=i, label=tpl["label"],
                                          map_instruction=f"特に: {tpl['map']}" if tpl["map"] else "",
                                          context=part)
            note = llm.chat([{"role": "system", "content": prompts.GEN_SYSTEM},
                             {"role": "user", "content": msg}], temperature=0.1)
            if note.strip() and note.strip() != "該当なし":
                notes.append((f"抜き出しメモ {i}", note))
        if not notes:
            notes = [("抜き出しメモ", "（該当する情報が見つかりませんでした）")]
        new_parts = _split_parts(notes, budget)
        if len(new_parts) >= len(parts):  # 縮まらない場合は打ち切り（無限ループ防止）
            parts = ["".join(new_parts)[:budget]]
            break
        parts = new_parts

    yield _event("status", text=f"「{tpl['label']}」を作成しています…")
    messages = [
        {"role": "system", "content": prompts.GEN_SYSTEM},
        {"role": "user", "content": prompts.GEN_USER.format(
            context=parts[0], instruction=tpl["instruction"], extra=extra_txt)},
    ]
    for piece in llm.stream_chat(messages):
        yield _event("delta", text=piece)
    yield _event("done")
