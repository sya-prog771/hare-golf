"""文字単位のトークナイザ（ライブラリなしの自作）

日本語は1文字が意味を持つことが多いので、まずは「1文字 = 1トークン」が
いちばんシンプルで確実です。学習データに出てきた文字すべてに番号を振ります。
"""
import json


class CharTokenizer:
    UNK = "�"  # 学習時に見なかった文字の代わり

    def __init__(self, chars):
        chars = sorted(set(chars) | {self.UNK})
        self.itos = chars                                # 番号 -> 文字
        self.stoi = {c: i for i, c in enumerate(chars)}  # 文字 -> 番号
        self.unk_id = self.stoi[self.UNK]

    @classmethod
    def from_text(cls, text):
        return cls(text)

    @property
    def vocab_size(self):
        return len(self.itos)

    def encode(self, text):
        return [self.stoi.get(c, self.unk_id) for c in text]

    def decode(self, ids):
        return "".join(self.itos[i] for i in ids)

    def to_dict(self):
        return {"type": "char", "itos": self.itos}

    @classmethod
    def from_dict(cls, d):
        return cls(d["itos"])

    def save(self, path):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, ensure_ascii=False)
