"""資料を小さな塊（チャンク）に分け、質問に関係する塊を探し出す（RAG の R の部分）

2種類の検索を組み合わせます:
  - キーワード検索（BM25）: 日本語は単語に区切るのが難しいので「2文字ずつ」に分けて数える
  - 意味検索: 埋め込みモデルで文章をベクトルにし、向きの近さ（コサイン類似度）で比べる
最後に順位を混ぜ合わせる（RRF）ので、片方しか使えなくても動きます。
"""
import math
import re
from collections import Counter

CHUNK_CHARS = 700
OVERLAP_CHARS = 120


def chunk_text(text, size=CHUNK_CHARS, overlap=OVERLAP_CHARS):
    """段落をなるべく切らずに size 文字前後の塊にまとめる。塊どうしは少し重ねる"""
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    # 長すぎる段落は文（。！？や改行）で区切る
    pieces = []
    for p in paras:
        if len(p) <= size:
            pieces.append(p)
            continue
        sents = re.split(r"(?<=[。！？!?\n])", p)
        buf = ""
        for s in sents:
            while len(s) > size:  # 句点のない極端に長い文
                pieces.append((buf + s[:size]).strip())
                s, buf = s[size:], ""
            if len(buf) + len(s) > size and buf:
                pieces.append(buf.strip())
                buf = ""
            buf += s
        if buf.strip():
            pieces.append(buf.strip())

    chunks, cur = [], ""
    for piece in pieces:
        if cur and len(cur) + len(piece) + 1 > size:
            chunks.append(cur)
            tail = cur[-overlap:] if overlap else ""
            cur = (tail + "\n" + piece) if tail else piece
        else:
            cur = (cur + "\n\n" + piece) if cur else piece
    if cur:
        chunks.append(cur)
    return chunks


_WORD = re.compile(r"[A-Za-z0-9_]+|[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ々ー]+")


def tokenize(text):
    toks = []
    for m in _WORD.finditer(text.lower()):
        w = m.group()
        if w.isascii():
            toks.append(w)
        elif len(w) == 1:
            toks.append(w)
        else:
            toks.extend(w[i:i + 2] for i in range(len(w) - 1))
    return toks


def bm25_scores(query, docs_tokens, k1=1.5, b=0.75):
    q = set(tokenize(query))
    if not q or not docs_tokens:
        return [0.0] * len(docs_tokens)
    N = len(docs_tokens)
    avgdl = sum(len(d) for d in docs_tokens) / N or 1
    df = Counter()
    counts = []
    for d in docs_tokens:
        c = Counter(d)
        counts.append(c)
        df.update(t for t in q if t in c)
    scores = []
    for d, c in zip(docs_tokens, counts):
        s = 0.0
        for t in q:
            tf = c.get(t, 0)
            if not tf:
                continue
            idf = math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5))
            s += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * len(d) / avgdl))
        scores.append(s)
    return scores


def cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def search(query, chunks, query_vec=None, top_k=8):
    """chunks: [{"text":..., "tokens":[...], "vec":[...] or None, ...}] → 関係が深い順の上位 top_k"""
    if not chunks:
        return []
    rankings = []

    kw = bm25_scores(query, [c["tokens"] for c in chunks])
    if any(kw):
        rankings.append(sorted(range(len(chunks)), key=lambda i: -kw[i]))

    if query_vec is not None:
        idx = [i for i, c in enumerate(chunks) if c.get("vec")]
        if idx:
            sims = {i: cosine(query_vec, chunks[i]["vec"]) for i in idx}
            rankings.append(sorted(idx, key=lambda i: -sims[i]))

    if not rankings:  # どちらでも見つからない → 先頭から
        return chunks[:top_k]

    # RRF: 各検索での順位 r に 1/(60+r) の点を与えて合計
    fused = Counter()
    for ranking in rankings:
        for r, i in enumerate(ranking[:50]):
            fused[i] += 1.0 / (60 + r)
    best = [i for i, _ in fused.most_common(top_k)]
    return [chunks[i] for i in best]
