"""学習したモデルで文章を生成する（完全オフライン）

使い方:
  python chat.py                         # 対話モード: 書き出しを入れると続きを書く
  python chat.py --prompt "吾輩は" -n 300
  python chat.py --temperature 1.0 --top-k 0
"""
import argparse
import os

import torch

from model import GPT, GPTConfig
from tokenizer import CharTokenizer
from train import pick_device

HERE = os.path.dirname(os.path.abspath(__file__))


def load(path, device):
    ckpt = torch.load(path, map_location="cpu")
    cfg = GPTConfig(**ckpt["config"])
    model = GPT(cfg)
    model.load_state_dict(ckpt["model"])
    model.to(device).eval()
    return model, CharTokenizer.from_dict(ckpt["tokenizer"])


def complete(model, tok, prompt, n, temperature, top_k, device):
    ids = tok.encode(prompt) or tok.encode("\n")
    x = torch.tensor([ids], dtype=torch.long, device=device)
    y = model.generate(x, n, temperature=temperature, top_k=top_k)
    return tok.decode(y[0, len(ids):].tolist())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.path.join(HERE, "out", "model.pt"))
    ap.add_argument("--prompt")
    ap.add_argument("-n", "--max-tokens", type=int, default=200)
    ap.add_argument("--temperature", type=float, default=0.8, help="低いほど堅実、高いほど冒険的")
    ap.add_argument("--top-k", type=int, default=40, help="上位k文字からだけ選ぶ（0で制限なし）")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--seed", type=int)
    args = ap.parse_args()

    if not os.path.exists(args.model):
        raise SystemExit(f"{args.model} がありません。先に python train.py で学習してください。")
    if args.seed is not None:
        torch.manual_seed(args.seed)
    device = pick_device(args.device)
    model, tok = load(args.model, device)

    if args.prompt is not None:
        print(args.prompt + complete(model, tok, args.prompt, args.max_tokens, args.temperature, args.top_k, device))
        return

    print("書き出しを入力すると続きを書きます（q か Ctrl+C で終了）")
    while True:
        try:
            prompt = input("\n> ")
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if prompt.strip() == "q":
            break
        print(prompt + complete(model, tok, prompt, args.max_tokens, args.temperature, args.top_k, device))


if __name__ == "__main__":
    main()
