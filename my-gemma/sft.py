"""指示チューニング（SFT）: 事前学習したモデルに「質問に答える」「指示どおり文書を作る」を教える

  python sft.py --base out/pretrain/model.pt --data data/sft/*.jsonl

データ（.jsonl、1行1件）は次のどちらの形でもよい:
  {"messages": [{"role": "user", "content": "…"}, {"role": "assistant", "content": "…"}]}
  {"instruction": "…", "input": "（任意）", "output": "…"}

AI の発言部分だけで誤差を計算するので、質問文を丸暗記することはありません。
"""
import argparse
import glob
import json
import math
import os
import random
import time
from contextlib import nullcontext

import torch

from model import Gemma, GemmaConfig
from pretrain import pick_device
from tokenizer import BPETokenizer, StreamDecoder

HERE = os.path.dirname(os.path.abspath(__file__))


def load_examples(patterns):
    out = []
    for pat in patterns:
        for path in sorted(glob.glob(pat)):
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    d = json.loads(line)
                    if "messages" in d:
                        msgs = d["messages"]
                    else:
                        user = d.get("instruction", "")
                        if d.get("input"):
                            user += "\n\n" + d["input"]
                        msgs = [{"role": "user", "content": user}, {"role": "assistant", "content": d.get("output", "")}]
                    if any(m["role"] in ("assistant", "model") and m["content"].strip() for m in msgs):
                        out.append(msgs)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.path.join(HERE, "out", "pretrain", "model.pt"))
    ap.add_argument("--tokenizer", help="既定は --base と同じフォルダの tokenizer.json")
    ap.add_argument("--data", nargs="+", default=[os.path.join(HERE, "data", "sft", "*.jsonl")])
    ap.add_argument("--out", default=os.path.join(HERE, "out", "sft"))
    ap.add_argument("--epochs", type=float, default=3)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--grad-accum", type=int, default=4)
    ap.add_argument("--lr", type=float, default=5e-5)
    ap.add_argument("--dropout", type=float, default=0.05)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = pick_device(args.device)
    dev_type = "cuda" if device.startswith("cuda") else device
    bf16 = dev_type == "cuda" and torch.cuda.is_bf16_supported()
    autocast = torch.autocast(device_type="cuda", dtype=torch.bfloat16) if bf16 else nullcontext()

    ckpt = torch.load(args.base, map_location="cpu", weights_only=False)
    cfg = GemmaConfig.from_dict(ckpt["config"])
    cfg.dropout = args.dropout
    tok = BPETokenizer.load(args.tokenizer or os.path.join(os.path.dirname(args.base), "tokenizer.json"))
    model = Gemma(cfg)
    model.load_state_dict(ckpt["model"])
    model.to(device)
    T = cfg.max_seq_len

    # 1) 会話をトークン列にし、AIの発言部分だけを正解として使う
    examples = load_examples(args.data)
    if not examples:
        raise SystemExit(f"{args.data} に学習データがありません。fetch_data.py や make_sft_data.py で作ってください。")
    data, cut = [], 0
    for msgs in examples:
        ids, mask = tok.chat_ids_with_mask(msgs)
        if len(ids) > T + 1:
            ids, mask = ids[:T + 1], mask[:T + 1]
            cut += 1
        if any(mask[1:]):
            data.append((ids, mask))
    random.shuffle(data)
    n_val = max(1, min(200, len(data) // 20))
    val, train = data[:n_val], data[n_val:] or data
    print(f"SFTデータ: 学習 {len(train):,} 件 / 確認 {len(val):,} 件（長すぎて切った: {cut} 件）")

    def collate(batch):
        L = max(len(ids) for ids, _ in batch) - 1
        x = torch.full((len(batch), L), tok.pad_id, dtype=torch.long)
        y = torch.full((len(batch), L), -100, dtype=torch.long)
        for b, (ids, mask) in enumerate(batch):
            n = len(ids) - 1
            x[b, :n] = torch.tensor(ids[:-1])
            tgt = torch.tensor(ids[1:])
            m = torch.tensor(mask[1:])
            y[b, :n] = torch.where(m, tgt, torch.full_like(tgt, -100))
        return x.to(device), y.to(device)

    steps_per_epoch = math.ceil(len(train) / (args.batch * args.grad_accum))
    total = max(1, int(steps_per_epoch * args.epochs))
    warmup = max(1, total // 20)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, betas=(0.9, 0.95), weight_decay=0.0)
    print(f"{total} ステップ（{args.epochs} エポック）学習します")

    @torch.no_grad()
    def val_loss():
        model.eval()
        losses = []
        for i in range(0, len(val), args.batch):
            with autocast:
                losses.append(model(*collate(val[i:i + args.batch]))[1].item())
        model.train()
        return sum(losses) / len(losses)

    def demo():
        model.eval()
        q = val[0][0]
        prompt = q[:q.index(tok.eot_id) + 1] + tok.encode("\n") + [tok.sot_id] + tok.encode("model\n") \
            if tok.eot_id in q else q
        dec = StreamDecoder(tok)
        out = "".join(dec.feed(i) for i in model.generate(prompt, 120, temperature=0.7, stop_ids=(tok.eot_id, tok.eos_id)))
        model.train()
        return tok.decode(prompt).replace("\n", " / ")[-80:], (out + dec.flush()).replace("\n", " / ")

    os.makedirs(args.out, exist_ok=True)
    tok.save(os.path.join(args.out, "tokenizer.json"))
    best = val_loss()
    print(f"学習前の確認用 loss: {best:.3f}")
    model.train()
    order, pos, t0 = [], 0, time.time()
    for step in range(total):
        lr = args.lr * min(1.0, (step + 1) / warmup) * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * step / total)))
        for g in opt.param_groups:
            g["lr"] = lr
        for _ in range(args.grad_accum):
            if pos + args.batch > len(order):
                order, pos = random.sample(range(len(train)), len(train)), 0
            batch = [train[i] for i in order[pos:pos + args.batch]]
            pos += args.batch
            with autocast:
                _, loss = model(*collate(batch))
            (loss / args.grad_accum).backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        opt.zero_grad(set_to_none=True)
        if step % 10 == 0:
            print(f"step {step:5d}/{total} | loss {loss.item():.3f} | lr {lr:.2e} | {time.time() - t0:.0f}秒")
        if (step + 1) % max(1, total // 10) == 0 or step + 1 == total:
            v = val_loss()
            q, a = demo()
            print(f"[評価] step {step + 1} | 確認用 loss {v:.3f}\n  質問: …{q}\n  回答: {a}")
            if v < best:
                best = v
                cfg.dropout = 0.0
                torch.save({"model": model.state_dict(), "config": cfg.to_dict(), "step": step + 1,
                            "val_loss": v, "chat": True}, os.path.join(args.out, "model.pt"))
                cfg.dropout = args.dropout
                print(f"  → 保存: {os.path.join(args.out, 'model.pt')}")
    path = os.path.join(args.out, "model.pt")
    if not os.path.exists(path):  # 一度も改善しなかった場合も最後の状態は残す
        cfg.dropout = 0.0
        torch.save({"model": model.state_dict(), "config": cfg.to_dict(), "step": total, "chat": True}, path)
    print(f"完了。確認用 loss の最小値: {best:.3f} → {path}")


if __name__ == "__main__":
    main()
