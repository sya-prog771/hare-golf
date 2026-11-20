"""GPT（デコーダ型Transformer）を部品から自作する

使っているのは PyTorch の基本部品（行列・Linear・Embedding・自動微分）だけで、
Attention や Transformer ブロックはすべてここで手書きしています。

全体の流れ:
  文字の番号 → 埋め込みベクトル(+位置) → Transformerブロック × n_layer → 次の文字の確率
"""
import math
from dataclasses import dataclass, asdict

import torch
import torch.nn as nn
import torch.nn.functional as F


@dataclass
class GPTConfig:
    vocab_size: int = 3000
    block_size: int = 256   # 一度に見られる文字数（文脈の長さ）
    n_layer: int = 6        # Transformerブロックの数
    n_head: int = 6         # Attentionの頭の数
    n_embd: int = 384       # ベクトルの次元数
    dropout: float = 0.1

    def to_dict(self):
        return asdict(self)


class CausalSelfAttention(nn.Module):
    """各文字が「自分より前の文字」だけを見て、どこに注目するかを決める仕組み"""

    def __init__(self, cfg):
        super().__init__()
        assert cfg.n_embd % cfg.n_head == 0
        self.n_head = cfg.n_head
        self.head_dim = cfg.n_embd // cfg.n_head
        # Query・Key・Value を1つの行列でまとめて計算
        self.qkv = nn.Linear(cfg.n_embd, 3 * cfg.n_embd)
        self.proj = nn.Linear(cfg.n_embd, cfg.n_embd)
        self.attn_drop = nn.Dropout(cfg.dropout)
        self.resid_drop = nn.Dropout(cfg.dropout)
        # 未来の文字を見ないようにするための三角マスク
        mask = torch.tril(torch.ones(cfg.block_size, cfg.block_size, dtype=torch.bool))
        self.register_buffer("mask", mask.view(1, 1, cfg.block_size, cfg.block_size), persistent=False)

    def forward(self, x):
        B, T, C = x.shape
        q, k, v = self.qkv(x).split(C, dim=2)
        # (B, T, C) → (B, 頭の数, T, 頭ごとの次元)
        q = q.view(B, T, self.n_head, self.head_dim).transpose(1, 2)
        k = k.view(B, T, self.n_head, self.head_dim).transpose(1, 2)
        v = v.view(B, T, self.n_head, self.head_dim).transpose(1, 2)

        # 注目度 = Q・K / √d 。未来の位置は -∞ にして softmax で 0 にする
        att = (q @ k.transpose(-2, -1)) / math.sqrt(self.head_dim)
        att = att.masked_fill(~self.mask[:, :, :T, :T], float("-inf"))
        att = F.softmax(att, dim=-1)
        att = self.attn_drop(att)

        y = att @ v                                       # 注目度で Value を重み付き平均
        y = y.transpose(1, 2).contiguous().view(B, T, C)  # 頭をつなぎ直す
        return self.resid_drop(self.proj(y))


class MLP(nn.Module):
    """各位置ごとの小さなニューラルネット（知識をためる場所と言われる）"""

    def __init__(self, cfg):
        super().__init__()
        self.fc = nn.Linear(cfg.n_embd, 4 * cfg.n_embd)
        self.proj = nn.Linear(4 * cfg.n_embd, cfg.n_embd)
        self.drop = nn.Dropout(cfg.dropout)

    def forward(self, x):
        return self.drop(self.proj(F.gelu(self.fc(x))))


class Block(nn.Module):
    """Transformerブロック = 正規化 → Attention → 足し算 → 正規化 → MLP → 足し算"""

    def __init__(self, cfg):
        super().__init__()
        self.ln1 = nn.LayerNorm(cfg.n_embd)
        self.attn = CausalSelfAttention(cfg)
        self.ln2 = nn.LayerNorm(cfg.n_embd)
        self.mlp = MLP(cfg)

    def forward(self, x):
        x = x + self.attn(self.ln1(x))  # 残差接続（元の情報を残しつつ足す）
        x = x + self.mlp(self.ln2(x))
        return x


class GPT(nn.Module):
    def __init__(self, cfg: GPTConfig):
        super().__init__()
        self.cfg = cfg
        self.tok_emb = nn.Embedding(cfg.vocab_size, cfg.n_embd)  # 文字 → ベクトル
        self.pos_emb = nn.Embedding(cfg.block_size, cfg.n_embd)  # 位置 → ベクトル
        self.drop = nn.Dropout(cfg.dropout)
        self.blocks = nn.ModuleList([Block(cfg) for _ in range(cfg.n_layer)])
        self.ln_f = nn.LayerNorm(cfg.n_embd)
        self.head = nn.Linear(cfg.n_embd, cfg.vocab_size, bias=False)  # ベクトル → 各文字のスコア
        self.head.weight = self.tok_emb.weight  # 入口と出口の重みを共有（パラメータ節約）

        self.apply(self._init_weights)
        # 残差に足し込む層は小さめに初期化すると、深くしても学習が安定する
        for name, p in self.named_parameters():
            if name.endswith("proj.weight"):
                nn.init.normal_(p, mean=0.0, std=0.02 / math.sqrt(2 * cfg.n_layer))

    @staticmethod
    def _init_weights(m):
        if isinstance(m, nn.Linear):
            nn.init.normal_(m.weight, mean=0.0, std=0.02)
            if m.bias is not None:
                nn.init.zeros_(m.bias)
        elif isinstance(m, nn.Embedding):
            nn.init.normal_(m.weight, mean=0.0, std=0.02)

    def num_params(self):
        return sum(p.numel() for p in self.parameters())

    def forward(self, idx, targets=None):
        B, T = idx.shape
        assert T <= self.cfg.block_size, "文脈が block_size より長いです"
        pos = torch.arange(T, device=idx.device)
        x = self.drop(self.tok_emb(idx) + self.pos_emb(pos))
        for block in self.blocks:
            x = block(x)
        logits = self.head(self.ln_f(x))  # (B, T, 語彙数)

        loss = None
        if targets is not None:
            # 「次の文字を当てる」問題の誤差（クロスエントロピー）
            loss = F.cross_entropy(logits.view(-1, logits.size(-1)), targets.view(-1))
        return logits, loss

    @torch.no_grad()
    def generate(self, idx, max_new_tokens, temperature=0.8, top_k=50, stop_ids=None):
        """1文字ずつ予測しては後ろにつなげる（自己回帰生成）"""
        for _ in range(max_new_tokens):
            idx_cond = idx[:, -self.cfg.block_size:]
            logits, _ = self(idx_cond)
            logits = logits[:, -1, :] / max(temperature, 1e-5)
            if top_k:
                v, _ = torch.topk(logits, min(top_k, logits.size(-1)))
                logits[logits < v[:, [-1]]] = float("-inf")  # 上位k個以外は選ばない
            probs = F.softmax(logits, dim=-1)
            next_id = torch.multinomial(probs, num_samples=1)
            idx = torch.cat([idx, next_id], dim=1)
            if stop_ids and next_id.item() in stop_ids:
                break
        return idx
