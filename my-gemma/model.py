"""Gemma 3 と同じ設計の言語モデルを、PyTorch の基本部品だけで自作する

Gemma 3 の特徴（すべてこのファイルで手書き）:
  - RMSNorm（重みは「1 + w」の形。初期値 0）
  - サンドイッチ正規化: Attention・MLP の「前」と「後」の両方で正規化する
  - GQA（Grouped-Query Attention）: Key/Value の頭の数を減らしてメモリを節約
  - QK-Norm: Query と Key を頭ごとに RMSNorm してから注目度を計算（学習が安定）
  - RoPE（回転位置埋め込み）: 近く用の層は θ=1万、全体用の層は θ=100万
  - ローカル/グローバル注意の交互配置: 5層は直近 sliding_window 個だけを見て、6層目ごとに全体を見る
  - GeGLU（GELU のゲート付き MLP）
  - 埋め込みに √(hidden_size) を掛ける。入力と出力の埋め込みを共有

transformers の Gemma3ForCausalLM と数値が一致することを test_vs_hf.py で確認できます。
"""
import math
from dataclasses import asdict, dataclass, field
from typing import List, Optional

import torch
import torch.nn as nn
import torch.nn.functional as F


@dataclass
class GemmaConfig:
    vocab_size: int = 32000
    hidden_size: int = 512
    intermediate_size: int = 2048
    num_hidden_layers: int = 12
    num_attention_heads: int = 8
    num_key_value_heads: int = 2
    head_dim: int = 64
    max_seq_len: int = 1024              # 学習・生成で扱う最大の長さ
    rms_norm_eps: float = 1e-6
    rope_theta: float = 1_000_000.0      # 全体を見る層
    rope_local_base_freq: float = 10_000.0  # 近くだけ見る層
    rope_scaling_factor: float = 1.0     # 全体を見る層の RoPE 線形スケーリング（Gemma 3 4B 以上は 8）
    sliding_window: int = 512
    sliding_window_pattern: int = 6      # 6層に1層が全体を見る
    query_pre_attn_scalar: float = 64    # 注目度のスケール 1/√(この値)
    final_logit_softcapping: Optional[float] = None
    attn_logit_softcapping: Optional[float] = None
    dropout: float = 0.0
    pad_token_id: int = 0
    eos_token_id: int = 1
    bos_token_id: int = 2
    layer_types: List[str] = field(default_factory=list)

    def __post_init__(self):
        if not self.layer_types:
            self.layer_types = [
                "sliding_attention" if (i + 1) % self.sliding_window_pattern else "full_attention"
                for i in range(self.num_hidden_layers)
            ]

    def to_dict(self):
        return asdict(self)

    @classmethod
    def from_dict(cls, d):
        known = {k: v for k, v in d.items() if k in cls.__dataclass_fields__}
        return cls(**known)


class RMSNorm(nn.Module):
    """平均を引かずに「大きさ」だけをそろえる正規化。Gemma は (1 + w) を掛ける"""

    def __init__(self, dim, eps=1e-6):
        super().__init__()
        self.eps = eps
        self.weight = nn.Parameter(torch.zeros(dim))

    def forward(self, x):
        out = x.float()
        out = out * torch.rsqrt(out.pow(2).mean(-1, keepdim=True) + self.eps)
        out = out * (1.0 + self.weight.float())
        return out.type_as(x)


def rope_cos_sin(positions, dim, base, scaling, dtype):
    """位置ごとの回転角（cos, sin）を作る"""
    inv_freq = 1.0 / (base ** (torch.arange(0, dim, 2, device=positions.device, dtype=torch.float32) / dim))
    inv_freq = inv_freq / scaling
    freqs = positions.float()[:, None] * inv_freq[None, :]
    emb = torch.cat([freqs, freqs], dim=-1)
    return emb.cos().to(dtype), emb.sin().to(dtype)


def apply_rope(x, cos, sin):
    """ベクトルの前半と後半をペアにして、位置に応じた角度だけ回転させる"""
    x1, x2 = x.chunk(2, dim=-1)
    rotated = torch.cat([-x2, x1], dim=-1)
    return x * cos + rotated * sin


class KVCache:
    """生成を速くするため、過去の Key/Value を層ごとにためておく"""

    def __init__(self, n_layers):
        self.k = [None] * n_layers
        self.v = [None] * n_layers

    @property
    def length(self):
        return 0 if self.k[0] is None else self.k[0].shape[2]

    def update(self, layer, k, v):
        if self.k[layer] is None:
            self.k[layer], self.v[layer] = k, v
        else:
            self.k[layer] = torch.cat([self.k[layer], k], dim=2)
            self.v[layer] = torch.cat([self.v[layer], v], dim=2)
        return self.k[layer], self.v[layer]


class Attention(nn.Module):
    def __init__(self, cfg: GemmaConfig, layer_idx: int):
        super().__init__()
        self.cfg = cfg
        self.layer_idx = layer_idx
        self.is_sliding = cfg.layer_types[layer_idx] == "sliding_attention"
        self.n_head = cfg.num_attention_heads
        self.n_kv = cfg.num_key_value_heads
        self.head_dim = cfg.head_dim
        self.scale = cfg.query_pre_attn_scalar ** -0.5
        self.q_proj = nn.Linear(cfg.hidden_size, self.n_head * self.head_dim, bias=False)
        self.k_proj = nn.Linear(cfg.hidden_size, self.n_kv * self.head_dim, bias=False)
        self.v_proj = nn.Linear(cfg.hidden_size, self.n_kv * self.head_dim, bias=False)
        self.o_proj = nn.Linear(self.n_head * self.head_dim, cfg.hidden_size, bias=False)
        self.q_norm = RMSNorm(self.head_dim, cfg.rms_norm_eps)
        self.k_norm = RMSNorm(self.head_dim, cfg.rms_norm_eps)

    def forward(self, x, cos, sin, mask, cache=None):
        B, T, _ = x.shape
        q = self.q_proj(x).view(B, T, self.n_head, self.head_dim).transpose(1, 2)
        k = self.k_proj(x).view(B, T, self.n_kv, self.head_dim).transpose(1, 2)
        v = self.v_proj(x).view(B, T, self.n_kv, self.head_dim).transpose(1, 2)
        q, k = self.q_norm(q), self.k_norm(k)          # QK-Norm
        q, k = apply_rope(q, cos, sin), apply_rope(k, cos, sin)
        if cache is not None:
            k, v = cache.update(self.layer_idx, k, v)
        # GQA: 少ない Key/Value の頭を、Query の頭の数までコピーして使う
        rep = self.n_head // self.n_kv
        if rep > 1:
            k = k.repeat_interleave(rep, dim=1)
            v = v.repeat_interleave(rep, dim=1)

        drop = self.cfg.dropout if self.training else 0.0
        if self.cfg.attn_logit_softcapping:
            att = (q @ k.transpose(-2, -1)) * self.scale
            cap = self.cfg.attn_logit_softcapping
            att = torch.tanh(att / cap) * cap
            att = att.masked_fill(~mask, float("-inf")) if mask is not None else att
            att = F.dropout(F.softmax(att.float(), dim=-1).to(q.dtype), drop, self.training)
            y = att @ v
        elif mask is None:  # 普通の「未来を見ない」だけでよい場合は高速な実装に任せる
            y = F.scaled_dot_product_attention(q, k, v, is_causal=True, dropout_p=drop, scale=self.scale)
        else:
            y = F.scaled_dot_product_attention(q, k, v, attn_mask=mask, dropout_p=drop, scale=self.scale)
        y = y.transpose(1, 2).contiguous().view(B, T, self.n_head * self.head_dim)
        return self.o_proj(y)


class MLP(nn.Module):
    """GeGLU: GELU(gate(x)) × up(x) を down で元の次元に戻す"""

    def __init__(self, cfg):
        super().__init__()
        self.gate_proj = nn.Linear(cfg.hidden_size, cfg.intermediate_size, bias=False)
        self.up_proj = nn.Linear(cfg.hidden_size, cfg.intermediate_size, bias=False)
        self.down_proj = nn.Linear(cfg.intermediate_size, cfg.hidden_size, bias=False)

    def forward(self, x):
        return self.down_proj(F.gelu(self.gate_proj(x), approximate="tanh") * self.up_proj(x))


class DecoderLayer(nn.Module):
    def __init__(self, cfg, layer_idx):
        super().__init__()
        self.self_attn = Attention(cfg, layer_idx)
        self.mlp = MLP(cfg)
        self.input_layernorm = RMSNorm(cfg.hidden_size, cfg.rms_norm_eps)
        self.post_attention_layernorm = RMSNorm(cfg.hidden_size, cfg.rms_norm_eps)
        self.pre_feedforward_layernorm = RMSNorm(cfg.hidden_size, cfg.rms_norm_eps)
        self.post_feedforward_layernorm = RMSNorm(cfg.hidden_size, cfg.rms_norm_eps)
        self.drop = nn.Dropout(cfg.dropout)

    def forward(self, x, cos, sin, mask, cache=None):
        h = self.self_attn(self.input_layernorm(x), cos, sin, mask, cache)
        x = x + self.drop(self.post_attention_layernorm(h))
        h = self.mlp(self.pre_feedforward_layernorm(x))
        x = x + self.drop(self.post_feedforward_layernorm(h))
        return x


class Gemma(nn.Module):
    def __init__(self, cfg: GemmaConfig):
        super().__init__()
        self.cfg = cfg
        self.embed_tokens = nn.Embedding(cfg.vocab_size, cfg.hidden_size, padding_idx=cfg.pad_token_id)
        self.layers = nn.ModuleList([DecoderLayer(cfg, i) for i in range(cfg.num_hidden_layers)])
        self.norm = RMSNorm(cfg.hidden_size, cfg.rms_norm_eps)
        self.apply(self._init_weights)
        # 残差に足し込む出力層は小さめに初期化（深いモデルでも学習が安定する）
        for name, p in self.named_parameters():
            if name.endswith(("o_proj.weight", "down_proj.weight")):
                nn.init.normal_(p, mean=0.0, std=0.02 / math.sqrt(2 * cfg.num_hidden_layers))

    @staticmethod
    def _init_weights(m):
        if isinstance(m, nn.Linear):
            nn.init.normal_(m.weight, mean=0.0, std=0.02)
        elif isinstance(m, nn.Embedding):
            nn.init.normal_(m.weight, mean=0.0, std=0.02)
            if m.padding_idx is not None:
                with torch.no_grad():
                    m.weight[m.padding_idx].zero_()

    def num_params(self, non_embedding=False):
        n = sum(p.numel() for p in self.parameters())
        return n - self.embed_tokens.weight.numel() if non_embedding else n

    def _masks(self, T, offset, device):
        """近くだけ見る層用・全体を見る層用のマスク（True = 見てよい）。不要なら None"""
        L = offset + T
        need_sliding = L > self.cfg.sliding_window
        if offset == 0 and not need_sliding:
            return None, None  # どちらも普通の因果マスクで済む → 高速実装
        q_pos = torch.arange(offset, L, device=device)[:, None]
        k_pos = torch.arange(L, device=device)[None, :]
        causal = k_pos <= q_pos
        sliding = causal & (k_pos > q_pos - self.cfg.sliding_window)
        full = None if offset == 0 else causal
        return full, (sliding if need_sliding else full)

    def forward(self, idx, targets=None, cache: Optional[KVCache] = None):
        B, T = idx.shape
        offset = cache.length if cache is not None else 0
        x = self.embed_tokens(idx)
        x = x * torch.tensor(self.cfg.hidden_size ** 0.5, dtype=x.dtype)

        pos = torch.arange(offset, offset + T, device=idx.device)
        cos_g, sin_g = rope_cos_sin(pos, self.cfg.head_dim, self.cfg.rope_theta, self.cfg.rope_scaling_factor, x.dtype)
        cos_l, sin_l = rope_cos_sin(pos, self.cfg.head_dim, self.cfg.rope_local_base_freq, 1.0, x.dtype)
        full_mask, sliding_mask = self._masks(T, offset, idx.device)

        for layer in self.layers:
            if layer.self_attn.is_sliding:
                x = layer(x, cos_l, sin_l, sliding_mask, cache)
            else:
                x = layer(x, cos_g, sin_g, full_mask, cache)
        x = self.norm(x)

        if targets is None:
            x = x[:, -1:, :]  # 生成時は最後の位置だけ計算すれば十分
        logits = F.linear(x, self.embed_tokens.weight)  # 入力の埋め込みを出力にも使う
        if self.cfg.final_logit_softcapping:
            cap = self.cfg.final_logit_softcapping
            logits = torch.tanh(logits / cap) * cap

        loss = None
        if targets is not None:
            loss = F.cross_entropy(logits.float().view(-1, logits.size(-1)), targets.view(-1), ignore_index=-100)
        return logits, loss

    @torch.no_grad()
    def generate(self, ids, max_new_tokens=256, temperature=0.7, top_k=50, top_p=0.95,
                 repetition_penalty=1.1, stop_ids=()):
        """1トークンずつ生成して yield する（KVキャッシュで高速化）"""
        self.eval()
        device = next(self.parameters()).device
        ids = list(ids)[-(self.cfg.max_seq_len - 1):]
        cache = KVCache(self.cfg.num_hidden_layers)
        x = torch.tensor([ids], dtype=torch.long, device=device)
        seen = list(ids)
        for _ in range(max_new_tokens):
            if cache.length + x.shape[1] > self.cfg.max_seq_len:
                break
            logits, _ = self(x, cache=cache)
            logits = logits[0, -1].float()
            if repetition_penalty and repetition_penalty != 1.0 and seen:
                prev = torch.tensor(sorted(set(seen[-256:])), device=device)
                vals = logits[prev]
                logits[prev] = torch.where(vals > 0, vals / repetition_penalty, vals * repetition_penalty)
            if temperature <= 0:
                nxt = int(torch.argmax(logits))
            else:
                logits = logits / temperature
                if top_k:
                    kth = torch.topk(logits, min(top_k, logits.numel())).values[-1]
                    logits[logits < kth] = float("-inf")
                probs = F.softmax(logits, dim=-1)
                if top_p and top_p < 1.0:
                    sp, si = torch.sort(probs, descending=True)
                    cut = torch.cumsum(sp, 0) - sp > top_p
                    sp[cut] = 0
                    probs = torch.zeros_like(probs).scatter(0, si, sp)
                nxt = int(torch.multinomial(probs / probs.sum(), 1))
            if nxt in stop_ids:
                break
            yield nxt
            seen.append(nxt)
            x = torch.tensor([[nxt]], dtype=torch.long, device=device)


# 大きさのプリセット（語彙 32,000 の場合のおおよそのパラメータ数）
PRESETS = {
    # 動作確認用。CPUで数分
    "nano":  dict(hidden_size=128, intermediate_size=512, num_hidden_layers=4, num_attention_heads=4,
                  num_key_value_heads=1, head_dim=32, query_pre_attn_scalar=32, max_seq_len=256, sliding_window=128),
    # 約 25M（うち埋め込み 8M）。GPU 1枚で数時間
    "tiny":  dict(hidden_size=256, intermediate_size=1024, num_hidden_layers=12, num_attention_heads=4,
                  num_key_value_heads=1, head_dim=64, query_pre_attn_scalar=64, max_seq_len=1024, sliding_window=256),
    # 約 85M。GPU 1枚で1〜2日
    "small": dict(hidden_size=512, intermediate_size=2048, num_hidden_layers=16, num_attention_heads=8,
                  num_key_value_heads=2, head_dim=64, query_pre_attn_scalar=64, max_seq_len=2048, sliding_window=512),
    # 約 270M。Gemma 3 270M と同じ形（語彙だけ小さい）。GPU 複数枚推奨
    "270m":  dict(hidden_size=640, intermediate_size=2048, num_hidden_layers=18, num_attention_heads=4,
                  num_key_value_heads=1, head_dim=256, query_pre_attn_scalar=256, max_seq_len=2048, sliding_window=512),
    # 約 1B。Gemma 3 1B と同じ形（語彙だけ小さい）。本格的なGPUクラスタ向け
    "1b":    dict(hidden_size=1152, intermediate_size=6912, num_hidden_layers=26, num_attention_heads=4,
                  num_key_value_heads=1, head_dim=256, query_pre_attn_scalar=256, max_seq_len=4096, sliding_window=512),
}
