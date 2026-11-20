"""自作 Gemma が本家（transformers の Gemma3ForCausalLM）と同じ計算をしているかを確かめる

  pip install transformers
  python test_vs_hf.py

ランダムな重みの小さな Gemma 3 を本家の実装で作り、その重みを自作モデルに移して、
同じ入力に対する出力（次のトークンの確率）が一致するかを比べます。
近くだけ見る層（sliding window）が効くように、窓より長い入力で試します。
"""
import torch

from hf_convert import hf_config_to_ours, hf_state_to_ours
from model import Gemma, KVCache


def main():
    from transformers import Gemma3ForCausalLM, Gemma3TextConfig

    torch.manual_seed(0)
    hf_cfg = Gemma3TextConfig(
        vocab_size=1000, hidden_size=128, intermediate_size=320, num_hidden_layers=7,
        num_attention_heads=4, num_key_value_heads=2, head_dim=32, query_pre_attn_scalar=32,
        sliding_window=16, max_position_embeddings=512, rope_scaling={"rope_type": "linear", "factor": 4.0},
    )
    hf_cfg._attn_implementation = "eager"
    hf = Gemma3ForCausalLM(hf_cfg).eval()
    with torch.no_grad():  # 正規化の重みは初期値が 0 なので、差が出るようにランダムにする
        for name, p in hf.named_parameters():
            if "norm" in name:
                p.normal_(0, 0.5)

    ours = Gemma(hf_config_to_ours(hf_cfg, max_seq_len=512)).eval()
    missing, unexpected = ours.load_state_dict(hf_state_to_ours(hf.state_dict()), strict=False)
    assert not unexpected, unexpected
    assert not missing, missing
    print("層の種類:", ours.cfg.layer_types)

    ids = torch.randint(0, 1000, (2, 60))
    with torch.no_grad():
        ref = hf(ids).logits
        out, _ = ours(ids, targets=torch.zeros_like(ids))
    diff = (ref - out).abs().max().item()
    print(f"全位置の出力の最大誤差: {diff:.2e}")
    assert diff < 1e-4, "本家と一致しません"

    # KVキャッシュを使った1トークンずつの計算でも同じになるか
    cache = KVCache(ours.cfg.num_hidden_layers)
    with torch.no_grad():
        ours(ids[:1, :40], cache=cache)
        steps = [ours(ids[:1, i:i + 1], cache=cache)[0][0, -1] for i in range(40, 60)]
    diff2 = (torch.stack(steps) - ref[0, 40:60]).abs().max().item()
    print(f"KVキャッシュ使用時の最大誤差: {diff2:.2e}")
    assert diff2 < 1e-4, "キャッシュ使用時に一致しません"
    print("OK: 自作 Gemma は本家 Gemma 3 と同じ計算をしています")


if __name__ == "__main__":
    main()
