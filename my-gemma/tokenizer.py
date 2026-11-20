"""BPE トークナイザを自作する（文字単位 BPE ＋ バイト・フォールバック。ライブラリなし）

Gemma の SentencePiece トークナイザと同じ考え方です:
  1. 文章を「文字の種類が同じ並び」（漢字の連続・ひらがなの連続・英単語 など）に区切る
  2. よく出る文字（日本語なら数千字）はそのまま1トークンにする。
     めったに出ない文字は UTF-8 のバイト（256種類）に分解する（バイト・フォールバック）
     → どんな文字でも表せるので「未知の文字」が出ない
  3. いちばんよく隣り合うペアを1つのトークンにまとめる、を語彙数に達するまでくり返す（BPE）
     例: 「東」「京」→「東京」、「し」「た」→「した」

Gemma と同じ特別トークン（<pad>=0, <eos>=1, <bos>=2, <start_of_turn>, <end_of_turn>）を持ちます。
"""
import heapq
import json
import re
from collections import Counter, defaultdict

SPECIAL_TOKENS = ["<pad>", "<eos>", "<bos>", "<start_of_turn>", "<end_of_turn>"]
N_SPECIAL = len(SPECIAL_TOKENS)

# 1) の区切り方。空白は次の英単語にくっつける（GPT系と同じ工夫）
PRETOKENIZE = re.compile(
    r" ?[A-Za-z]+"
    r"| ?[0-9]{1,3}"
    r"|[ぁ-ゟ]+"                       # ひらがな
    r"|[゠-ヿㇰ-ㇿｦ-ﾟ]+"  # カタカナ（ー を含む）
    r"|[㐀-䶿一-鿿豈-﫿々〆ヵヶ]+"  # 漢字
    r"|\s+(?!\S)|\s+"
    r"|[^\sA-Za-z0-9ぁ-ヿㇰ-ㇿｦ-ﾟ㐀-䶿一-鿿豈-﫿々〆]+"
)
SPECIAL_RE = re.compile("(" + "|".join(re.escape(t) for t in SPECIAL_TOKENS) + ")")


class BPETokenizer:
    def __init__(self, chars, merges):
        # トークン番号: 特別トークン → 256バイト → 文字 → 学習したペア の順
        self.chars = list(chars)
        self.merges = [tuple(m) for m in merges]
        self.vocab = [t.encode() for t in SPECIAL_TOKENS] + [bytes([b]) for b in range(256)]
        self.char_id = {}
        for c in self.chars:
            self.char_id[c] = len(self.vocab)
            self.vocab.append(c.encode("utf-8"))
        self.ranks = {}
        for a, b in self.merges:
            self.ranks[(a, b)] = len(self.vocab)
            self.vocab.append(self.vocab[a] + self.vocab[b])
        self.special = {t: i for i, t in enumerate(SPECIAL_TOKENS)}
        self._cache = {}

    pad_id, eos_id, bos_id, sot_id, eot_id = range(N_SPECIAL)

    @property
    def vocab_size(self):
        return len(self.vocab)

    def _initial_ids(self, word):
        out = []
        for c in word:
            i = self.char_id.get(c)
            if i is None:
                out.extend(N_SPECIAL + b for b in c.encode("utf-8"))  # バイト・フォールバック
            else:
                out.append(i)
        return out

    # ---------- 学習 ----------
    @classmethod
    def train(cls, texts, vocab_size=32000, char_coverage=0.9995, max_chars=8000,
              max_words=1_000_000, verbose=True):
        """texts: 文字列のイテラブル。よく出る隣接ペアを順にまとめていく"""
        counts = Counter()
        for t in texts:
            counts.update(PRETOKENIZE.findall(t))
        if verbose:
            print(f"  区切った単語: {len(counts):,} 種類")

        # よく出る文字を、出現回数の 99.95% をカバーするまで採用（残りはバイトで表す）
        char_count = Counter()
        for w, f in counts.items():
            for c in w:
                char_count[c] += f
        total = sum(char_count.values())
        budget = max(0, min(max_chars, vocab_size - N_SPECIAL - 256))
        chars, covered = [], 0
        for c, f in char_count.most_common():
            if len(chars) >= budget or covered >= char_coverage * total:
                break
            chars.append(c)
            covered += f
        chars.sort()
        tok = cls(chars, [])
        if verbose:
            print(f"  基本の文字: {len(chars):,} 字（出現の {covered / max(total, 1):.4%} をカバー）")

        words, freqs = [], []
        for w, f in counts.most_common(max_words):
            words.append(tok._initial_ids(w))
            freqs.append(f)

        # ペアの出現回数と、そのペアを含む単語の一覧
        pair_count = defaultdict(int)
        where = defaultdict(set)
        for i, w in enumerate(words):
            for p in zip(w, w[1:]):
                pair_count[p] += freqs[i]
                where[p].add(i)
        # 回数が最大のペアをすばやく取り出すためのヒープ（古い値は取り出し時に読み捨てる）
        heap = [(-c, p) for p, c in pair_count.items()]
        heapq.heapify(heap)

        merges = []
        base = tok.vocab_size
        n_merges = vocab_size - base
        while len(merges) < n_merges and heap:
            neg, pair = heapq.heappop(heap)
            if pair_count.get(pair, 0) != -neg:
                continue  # 古い情報
            if -neg < 2:
                break     # 1回しか出ないペアはまとめない
            new_id = base + len(merges)
            merges.append(pair)
            changed = set()
            for i in where.pop(pair, ()):
                w = words[i]
                f = freqs[i]
                out, j, hit = [], 0, False
                while j < len(w):
                    if j + 1 < len(w) and w[j] == pair[0] and w[j + 1] == pair[1]:
                        out.append(new_id)
                        j += 2
                        hit = True
                    else:
                        out.append(w[j])
                        j += 1
                if not hit:
                    continue
                for p in zip(w, w[1:]):  # この単語のペアを一度すべて引き、まとめた後に足し直す
                    pair_count[p] -= f
                    changed.add(p)
                for p in zip(out, out[1:]):
                    pair_count[p] += f
                    where[p].add(i)
                    changed.add(p)
                words[i] = out
            pair_count.pop(pair, None)
            changed.discard(pair)
            for p in changed:
                c = pair_count.get(p, 0)
                if c > 0:
                    heapq.heappush(heap, (-c, p))
                else:
                    pair_count.pop(p, None)
            if verbose and len(merges) % 2000 == 0:
                print(f"  {len(merges):,} / {n_merges:,} 個のペアを学習")
        return cls(chars, merges)

    # ---------- 変換 ----------
    def _encode_word(self, word):
        ids = self._cache.get(word)
        if ids is not None:
            return ids
        ids = self._initial_ids(word)
        while len(ids) >= 2:
            # いちばん早く学習したペアから順にまとめる
            best, best_rank = None, None
            for p in zip(ids, ids[1:]):
                r = self.ranks.get(p)
                if r is not None and (best_rank is None or r < best_rank):
                    best, best_rank = p, r
            if best is None:
                break
            out, j = [], 0
            while j < len(ids):
                if j + 1 < len(ids) and ids[j] == best[0] and ids[j + 1] == best[1]:
                    out.append(best_rank)
                    j += 2
                else:
                    out.append(ids[j])
                    j += 1
            ids = out
        if len(self._cache) < 500_000:
            self._cache[word] = ids
        return ids

    def encode(self, text, allow_special=False):
        out = []
        parts = SPECIAL_RE.split(text) if allow_special else [text]
        for part in parts:
            if allow_special and part in self.special:
                out.append(self.special[part])
                continue
            for w in PRETOKENIZE.findall(part):
                out.extend(self._encode_word(w))
        return out

    def decode_bytes(self, ids):
        return b"".join(self.vocab[i] for i in ids if i >= N_SPECIAL or i in (self.sot_id, self.eot_id))

    def decode(self, ids):
        return self.decode_bytes(ids).decode("utf-8", errors="replace")

    def token_str(self, i):
        return self.vocab[i].decode("utf-8", errors="replace")

    # ---------- 会話の形式（Gemma と同じ） ----------
    def chat_ids(self, messages, add_generation_prompt=True):
        """[{"role": "system"|"user"|"assistant", "content": ...}] → トークン列
        <bos><start_of_turn>user\n質問<end_of_turn>\n<start_of_turn>model\n回答<end_of_turn>\n
        system の内容は Gemma と同じく最初の user の発言の前に入れる。"""
        ids, _ = self.chat_ids_with_mask(messages, add_generation_prompt)
        return ids

    def chat_ids_with_mask(self, messages, add_generation_prompt=False):
        """学習用: AI の発言部分だけ True のマスクも返す（そこだけで誤差を計算する）"""
        ids, mask = [self.bos_id], [False]
        system = ""
        for m in messages:
            role, content = m["role"], m["content"].strip()
            if role == "system":
                system = content + "\n\n"
                continue
            if role == "user" and system:
                content, system = system + content, ""
            name = "model" if role in ("assistant", "model") else "user"
            head = [self.sot_id] + self.encode(name + "\n")
            body = self.encode(content) + [self.eot_id]
            tail = self.encode("\n")
            ids += head + body + tail
            train = name == "model"
            mask += [False] * len(head) + [train] * len(body) + [False] * len(tail)
        if add_generation_prompt:
            gen = [self.sot_id] + self.encode("model\n")
            ids += gen
            mask += [False] * len(gen)
        return ids, mask

    # ---------- 保存 ----------
    def save(self, path):
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"type": "char_bpe_byte_fallback", "special_tokens": SPECIAL_TOKENS,
                       "chars": self.chars, "merges": self.merges}, f, ensure_ascii=False)

    @classmethod
    def load(cls, path):
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        return cls(d.get("chars", []), d["merges"])


class StreamDecoder:
    """1トークンずつ届くバイト列を、文字として完成した分だけ文字列にする（日本語は1文字3バイト）"""

    def __init__(self, tok):
        self.tok = tok
        self.buf = b""

    def feed(self, i):
        self.buf += self.tok.decode_bytes([i])
        for cut in range(len(self.buf), max(len(self.buf) - 4, -1), -1):
            try:
                text = self.buf[:cut].decode("utf-8")
            except UnicodeDecodeError:
                continue
            self.buf = self.buf[cut:]
            return text
        if len(self.buf) > 8:  # 壊れたバイト列が続く場合は置き換え文字で出してしまう
            return self.flush()
        return ""

    def flush(self):
        text = self.buf.decode("utf-8", errors="replace")
        self.buf = b""
        return text
