"""テキストからGPTを学習する

使い方:
  python train.py                       # data/ の .txt をすべて使って学習（小さいモデル）
  python train.py --size small --iters 20000
  python train.py --resume              # 前回の続きから学習
"""
import argparse
import glob
import math
import os
import time

import torch

from model import GPT, GPTConfig
from tokenizer import CharTokenizer

HERE = os.path.dirname(os.path.abspath(__file__))

# 大きさのプリセット（パラメータ数はおおよそ。語彙数で少し変わる）
PRESETS = {
    "tiny":   dict(n_layer=4, n_head=4, n_embd=128, block_size=128),  # 約1M   CPUで数分
    "small":  dict(n_layer=6, n_head=6, n_embd=384, block_size=256),  # 約11M  CPUで数時間 / GPUで数分
    "medium": dict(n_layer=8, n_head=8, n_embd=512, block_size=512),  # 約27M  GPU推奨
}


def pick_device(name):
    if name != "auto":
        return name
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"  # Apple Silicon の Mac
    return "cpu"


def load_text(data_dir):
    files = sorted(glob.glob(os.path.join(data_dir, "**", "*.txt"), recursive=True))
    if not files:
        raise SystemExit(f"{data_dir} に .txt がありません。fetch_aozora.py を実行するか、テキストを置いてください。")
    parts = []
    for f in files:
        with open(f, encoding="utf-8") as fh:
            parts.append(fh.read())
    text = "\n\n".join(parts)
    print(f"学習データ: {len(files)} ファイル / {len(text):,} 文字")
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(HERE, "data"))
    ap.add_argument("--out", default=os.path.join(HERE, "out", "model.pt"))
    ap.add_argument("--size", default="tiny", choices=PRESETS)
    ap.add_argument("--iters", type=int, default=3000)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--dropout", type=float, default=0.1)
    ap.add_argument("--eval-every", type=int, default=250)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--seed", type=int, default=1337)
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    device = pick_device(args.device)
    print(f"デバイス: {device}")

    text = load_text(args.data)

    # 1) トークナイザとモデルを用意（続きからなら保存したものを読む）
    ckpt = None
    if args.resume and os.path.exists(args.out):
        ckpt = torch.load(args.out, map_location="cpu")
        tok = CharTokenizer.from_dict(ckpt["tokenizer"])
        cfg = GPTConfig(**ckpt["config"])
        print(f"{args.out} から再開（{ckpt['iter']} 回目まで学習済み）")
    else:
        tok = CharTokenizer.from_text(text)
        cfg = GPTConfig(vocab_size=tok.vocab_size, dropout=args.dropout, **PRESETS[args.size])

    model = GPT(cfg).to(device)
    if ckpt:
        model.load_state_dict(ckpt["model"])
    print(f"語彙数: {tok.vocab_size:,} 文字 / パラメータ数: {model.num_params() / 1e6:.2f}M")

    # 2) 文章を番号の列にして、9割を学習用・1割を確認用に分ける
    data = torch.tensor(tok.encode(text), dtype=torch.long)
    n = int(len(data) * 0.9)
    train_data, val_data = data[:n], data[n:]
    if len(val_data) <= cfg.block_size + 1:
        raise SystemExit("データが少なすぎます。もっと長いテキストを用意してください。")

    def get_batch(split):
        d = train_data if split == "train" else val_data
        ix = torch.randint(len(d) - cfg.block_size - 1, (args.batch,))
        x = torch.stack([d[i:i + cfg.block_size] for i in ix])
        y = torch.stack([d[i + 1:i + 1 + cfg.block_size] for i in ix])  # 1文字ずらしたものが「正解」
        return x.to(device), y.to(device)

    @torch.no_grad()
    def estimate_loss(n_batches=20):
        model.eval()
        out = {}
        for split in ("train", "val"):
            losses = [model(*get_batch(split))[1].item() for _ in range(n_batches)]
            out[split] = sum(losses) / len(losses)
        model.train()
        return out

    # 3) 最適化手法 AdamW。重み減衰は行列の重みだけにかける
    decay = [p for p in model.parameters() if p.dim() >= 2]
    no_decay = [p for p in model.parameters() if p.dim() < 2]
    opt = torch.optim.AdamW(
        [{"params": decay, "weight_decay": 0.1}, {"params": no_decay, "weight_decay": 0.0}],
        lr=args.lr, betas=(0.9, 0.95),
    )
    start = 0
    if ckpt and "optimizer" in ckpt:
        opt.load_state_dict(ckpt["optimizer"])
        start = ckpt["iter"]
    end = start + args.iters

    # 学習率: 最初は少しずつ上げ（ウォームアップ）、あとはコサインで下げる
    warmup = max(1, min(200, args.iters // 10))

    def lr_at(i):
        i -= start
        if i < warmup:
            return args.lr * (i + 1) / warmup
        ratio = (i - warmup) / max(1, args.iters - warmup)
        return args.lr * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * ratio)))

    def save(i):
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        torch.save({
            "model": model.state_dict(),
            "optimizer": opt.state_dict(),
            "config": cfg.to_dict(),
            "tokenizer": tok.to_dict(),
            "iter": i,
        }, args.out)

    # 4) 学習ループ: 予測 → 誤差 → 誤差を減らす方向に重みを少し動かす、の繰り返し
    model.train()
    t0 = time.time()
    best_val = float("inf")
    for i in range(start, end):
        for g in opt.param_groups:
            g["lr"] = lr_at(i)

        x, y = get_batch("train")
        _, loss = model(x, y)
        opt.zero_grad(set_to_none=True)
        loss.backward()                                          # 自動微分で勾配を計算
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)  # 勾配が暴れないように抑える
        opt.step()

        if i % 50 == 0:
            print(f"  {i:6d}/{end}  loss {loss.item():.3f}  ({time.time() - t0:.0f}秒)")

        if (i + 1) % args.eval_every == 0 or i + 1 == end:
            losses = estimate_loss()
            print(f"[評価] {i + 1} 回目  学習 {losses['train']:.3f}  確認 {losses['val']:.3f}")
            if losses["val"] < best_val:
                best_val = losses["val"]
                save(i + 1)
                print(f"  → 保存しました: {args.out}")
            # 途中経過として少しだけ文章を書かせてみる
            model.eval()
            seed = torch.tensor([tok.encode("\n")], device=device)
            sample = model.generate(seed, 80, temperature=0.8, top_k=40)
            model.train()
            print("  サンプル:", tok.decode(sample[0].tolist()).strip().replace("\n", " / "))

    print(f"完了。いちばん良かった確認用 loss: {best_val:.3f}")


if __name__ == "__main__":
    main()
