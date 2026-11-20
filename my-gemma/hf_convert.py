"""自作 Gemma ⇔ Hugging Face (transformers) 形式の変換

- hf_config_to_ours: transformers の Gemma3TextConfig（または config.json の辞書）から自作の設定を作る
- hf_state_to_ours:  重みの名前を自作モデル用に付け替える（"model." を外すだけ。lm_head は埋め込みと共有）
"""
from model import GemmaConfig


def _get(c, key, default=None):
    return c.get(key, default) if isinstance(c, dict) else getattr(c, key, default)


def hf_config_to_ours(c, max_seq_len=2048):
    if _get(c, "text_config"):  # マルチモーダル版の config.json の場合は文章部分だけ使う
        c = _get(c, "text_config")
    rope = _get(c, "rope_parameters") or {}
    full = rope.get("full_attention", {}) if isinstance(rope, dict) else {}
    local = rope.get("sliding_attention", {}) if isinstance(rope, dict) else {}
    scaling = _get(c, "rope_scaling") or {}
    factor = full.get("factor") or (scaling.get("factor") if isinstance(scaling, dict) else None) or 1.0
    return GemmaConfig(
        vocab_size=_get(c, "vocab_size"),
        hidden_size=_get(c, "hidden_size"),
        intermediate_size=_get(c, "intermediate_size"),
        num_hidden_layers=_get(c, "num_hidden_layers"),
        num_attention_heads=_get(c, "num_attention_heads"),
        num_key_value_heads=_get(c, "num_key_value_heads"),
        head_dim=_get(c, "head_dim"),
        max_seq_len=max_seq_len,
        rms_norm_eps=_get(c, "rms_norm_eps", 1e-6),
        rope_theta=full.get("rope_theta") or _get(c, "rope_theta", 1_000_000.0),
        rope_local_base_freq=local.get("rope_theta") or _get(c, "rope_local_base_freq", 10_000.0),
        rope_scaling_factor=float(factor),
        sliding_window=_get(c, "sliding_window", 512),
        query_pre_attn_scalar=_get(c, "query_pre_attn_scalar", 256),
        final_logit_softcapping=_get(c, "final_logit_softcapping"),
        attn_logit_softcapping=_get(c, "attn_logit_softcapping"),
        pad_token_id=_get(c, "pad_token_id", 0) or 0,
        eos_token_id=1, bos_token_id=2,
        layer_types=list(_get(c, "layer_types") or []),
    )


def hf_state_to_ours(sd):
    out = {}
    for k, v in sd.items():
        if k.startswith("lm_head."):
            continue
        for prefix in ("model.language_model.", "language_model.model.", "model."):
            if k.startswith(prefix):
                k = k[len(prefix):]
                break
        out[k] = v
    return out


def ours_state_to_hf(sd):
    return {"model." + k: v for k, v in sd.items()}
