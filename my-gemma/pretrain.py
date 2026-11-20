"""事前学習: 大量の文章で「次のトークンを当てる」練習をさせて、言葉そのものを覚えさせる

  python pretrain.py --preset nano --max-steps 300          # 動作確認（CPUで数分）
  python pretrain.py --preset small --batch 32 --grad-accum 4 --compile
  torchrun --nproc_per_node=8 pretrain.py --preset 270m ...  # GPU 8枚で並列学習
  python pretrain.py --resume                                # 中断したところから再開

1ステップで学習するトークン数 = batch × grad_accum × GPU数 × max_seq_len
"""
import argparse
import json
import math
import os
import time
from contextlib import nullcontext

import numpy as np
import torch
import torch.distributed as dist

from model import PRESETS, Gemma, GemmaConfig
from tokenizer import BPETokenizer, StreamDecoder

HERE = os.path.dirname(os.path.abspath(__file__))


def get_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(HERE, "data", "tokens"))
    ap.add_argument("--out", default=os.path.join(HERE, "out", "pretrain"))
    ap.add_argument("--preset", default="tiny", choices=PRESETS)
    ap.add_argument("--seq-len", type=int, help="プリセットの max_seq_len を上書き")
    ap.add_argument("--batch", type=int, default=16, help="GPU1枚あたりの1回の文章数")
    ap.add_argument("--grad-accum", type=int, default=4, help="何回分ためてから重みを更新するか")
    ap.add_argument("--max-steps", type=int, default=20000)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--min-lr", type=float, default=1e-4)
    ap.add_argument("--warmup", type=int, default=1000)
    ap.add_argument("--weight-decay", type=float, default=0.1)
    ap.add_argument("--eval-every", type=int, default=500)
    ap.add_argument("--eval-batches", type=int, default=40)
    ap.add_argument("--save-every", type=int, default=1000)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--dtype", default="auto", choices=["auto", "float32", "bfloat16", "float16"])
    ap.add_argument("--compile", action="store_true", help="torch.compile で高速化（GPU向け）")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--init-from", help="既存のモデル（.pt）から続けて学習する")
    ap.add_argument("--seed", type=int, default=1337)
    return ap.parse_args()


def pick_device(name):
    if name != "auto":
        return name
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def main():
    args = get_args()

    # ---- 複数GPU（torchrun で起動したとき） ----
    ddp = int(os.environ.get("WORLD_SIZE", "1")) > 1
    if ddp:
        backend = "nccl" if torch.cuda.is_available() else "gloo"
        dist.init_process_group(backend)
        rank, world = dist.get_rank(), dist.get_world_size()
        local_rank = int(os.environ.get("LOCAL_RANK", 0))
        device = f"cuda:{local_rank}" if torch.cuda.is_available() else "cpu"
        if device.startswith("cuda"):
            torch.cuda.set_device(device)
    else:
        rank, world = 0, 1
        device = pick_device(args.device)
    master = rank == 0
    log = print if master else (lambda *a, **k: None)
    torch.manual_seed(args.seed + rank)

    dev_type = "cuda" if device.startswith("cuda") else device
    if args.dtype == "auto":
        dtype = "bfloat16" if dev_type == "cuda" and torch.cuda.is_bf16_supported() else "float32"
    else:
        dtype = args.dtype
    ptdtype = {"float32": torch.float32, "bfloat16": torch.bfloat16, "float16": torch.float16}[dtype]
    autocast = nullcontext() if dtype == "float32" else torch.autocast(device_type=dev_type, dtype=ptdtype)
    scaler = torch.amp.GradScaler(enabled=(dtype == "float16"))
    if dev_type == "cuda":
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True

    # ---- データ ----
    with open(os.path.join(args.data, "meta.json"), encoding="utf-8") as f:
        meta = json.load(f)
    tok = BPETokenizer.load(os.path.join(args.data, "tokenizer.json"))
    np_dtype = np.dtype(meta["dtype"])
    train_data = np.memmap(os.path.join(args.data, "train.bin"), dtype=np_dtype, mode="r")
    val_data = np.memmap(os.path.join(args.data, "val.bin"), dtype=np_dtype, mode="r")

    # ---- モデル ----
    os.makedirs(args.out, exist_ok=True)
    ckpt_path = os.path.join(args.out, "ckpt.pt")
    ckpt = None
    if args.resume and os.path.exists(ckpt_path):
        ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)
        cfg = GemmaConfig.from_dict(ckpt["config"])
        log(f"{ckpt_path} から再開（{ckpt['step']} ステップ目）")
    elif args.init_from:
        ckpt0 = torch.load(args.init_from, map_location="cpu", weights_only=False)
        cfg = GemmaConfig.from_dict(ckpt0["config"])
    else:
        preset = dict(PRESETS[args.preset])
        if args.seq_len:
            preset["max_seq_len"] = args.seq_len
        cfg = GemmaConfig(vocab_size=tok.vocab_size, **preset)
    if cfg.vocab_size != tok.vocab_size:
        raise SystemExit(f"モデルの語彙数 {cfg.vocab_size} とトークナイザ {tok.vocab_size} が違います")
    T = cfg.max_seq_len
    if len(val_data) <= T + 1:
        raise SystemExit("データが少なすぎます（確認用データが max_seq_len より短い）。--seq-len を小さくするかデータを増やしてください。")

    model = Gemma(cfg)
    if ckpt:
        model.load_state_dict(ckpt["model"])
    elif args.init_from:
        model.load_state_dict(ckpt0["model"])
    model.to(device)
    n_params = model.num_params()
    tokens_per_step = args.batch * args.grad_accum * world * T
    log(f"デバイス: {device} × {world} / 精度: {dtype}")
    log(f"パラメータ: {n_params / 1e6:.1f}M（埋め込み以外 {model.num_params(True) / 1e6:.1f}M）")
    log(f"学習データ: {len(train_data):,} トークン / 1ステップ {tokens_per_step:,} トークン / "
        f"全体で {tokens_per_step * args.max_steps / 1e9:.2f}B トークン（データ {tokens_per_step * args.max_steps / max(len(train_data), 1):.1f} 周）")

    # ---- 最適化（AdamW。行列だけに重み減衰） ----
    decay = [p for n, p in model.named_parameters() if p.dim() >= 2]
    no_decay = [p for n, p in model.named_parameters() if p.dim() < 2]
    opt = torch.optim.AdamW([{"params": decay, "weight_decay": args.weight_decay},
                             {"params": no_decay, "weight_decay": 0.0}],
                            lr=args.lr, betas=(0.9, 0.95), eps=1e-8,
                            fused=(dev_type == "cuda"))
    start_step = 0
    if ckpt:
        opt.load_state_dict(ckpt["optimizer"])
        start_step = ckpt["step"]

    raw_model = model
    if args.compile:
        model = torch.compile(model)
    if ddp:
        from torch.nn.parallel import DistributedDataParallel as DDP
        model = DDP(model, device_ids=[int(os.environ.get("LOCAL_RANK", 0))] if dev_type == "cuda" else None)

    def get_batch(split):
        d = train_data if split == "train" else val_data
        ix = torch.randint(len(d) - T - 1, (args.batch,))
        x = torch.stack([torch.from_numpy(d[i:i + T].astype(np.int64)) for i in ix.tolist()])
        y = torch.stack([torch.from_numpy(d[i + 1:i + 1 + T].astype(np.int64)) for i in ix.tolist()])
        if dev_type == "cuda":
            return x.pin_memory().to(device, non_blocking=True), y.pin_memory().to(device, non_blocking=True)
        return x.to(device), y.to(device)

    def lr_at(step):
        if step < args.warmup:
            return args.lr * (step + 1) / args.warmup
        ratio = min(1.0, (step - args.warmup) / max(1, args.max_steps - args.warmup))
        return args.min_lr + 0.5 * (1 + math.cos(math.pi * ratio)) * (args.lr - args.min_lr)

    @torch.no_grad()
    def evaluate():
        # 評価は1台（rank 0）だけで行うので、並列化していない元のモデルを使う
        model = raw_model
        model.eval()
        out = {}
        for split in ("train", "val"):
            losses = torch.zeros(args.eval_batches)
            for k in range(args.eval_batches):
                x, y = get_batch(split)
                with autocast:
                    _, loss = model(x, y)
                losses[k] = loss.item()
            out[split] = losses.mean().item()
        model.train()
        return out

    def sample(prompt="日本の", n=60):
        raw_model.eval()
        dec = StreamDecoder(tok)
        ids = [tok.bos_id] + tok.encode(prompt)
        text = prompt + "".join(dec.feed(i) for i in raw_model.generate(ids, n, temperature=0.8, stop_ids=(tok.eos_id,))) + dec.flush()
        raw_model.train()
        return text.replace("\n", " / ")

    def save(step, best_val):
        torch.save({"model": raw_model.state_dict(), "optimizer": opt.state_dict(), "config": cfg.to_dict(),
                    "step": step, "best_val": best_val, "args": vars(args)}, ckpt_path)

    # ---- 学習ループ ----
    if master:
        tok.save(os.path.join(args.out, "tokenizer.json"))  # モデルと同じフォルダに置いておく
    model.train()
    t0 = time.time()
    best_val = ckpt.get("best_val", float("inf")) if ckpt else float("inf")
    x, y = get_batch("train")
    for step in range(start_step, args.max_steps):
        lr = lr_at(step)
        for g in opt.param_groups:
            g["lr"] = lr

        for micro in range(args.grad_accum):
            if ddp:  # 最後の小分けのときだけGPU間で勾配を平均する
                model.require_backward_grad_sync = micro == args.grad_accum - 1
            with autocast:
                _, loss = model(x, y)
                loss = loss / args.grad_accum
            x, y = get_batch("train")  # 次のデータを先に用意しておく
            scaler.scale(loss).backward()
        scaler.unscale_(opt)
        gnorm = torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        scaler.step(opt)
        scaler.update()
        opt.zero_grad(set_to_none=True)

        if step % 10 == 0:
            dt = time.time() - t0
            t0 = time.time()
            tps = tokens_per_step * (10 if step > start_step else 1) / max(dt, 1e-9)
            log(f"step {step:6d} | loss {loss.item() * args.grad_accum:.3f} | lr {lr:.2e} | "
                f"勾配 {gnorm:.2f} | {tps:,.0f} トークン/秒")

        last = step + 1 == args.max_steps
        if master and ((step + 1) % args.eval_every == 0 or last):
            losses = evaluate()
            log(f"[評価] step {step + 1} | 学習 {losses['train']:.3f} | 確認 {losses['val']:.3f} "
                f"| 困惑度 {math.exp(min(losses['val'], 20)):.1f}")
            log(f"  サンプル: {sample()}")
            if losses["val"] < best_val:
                best_val = losses["val"]
                torch.save({"model": raw_model.state_dict(), "config": cfg.to_dict(), "step": step + 1,
                            "val_loss": best_val}, os.path.join(args.out, "model.pt"))
                log(f"  → 一番良いモデルを保存: {os.path.join(args.out, 'model.pt')}")
        if master and ((step + 1) % args.save_every == 0 or last):
            save(step + 1, best_val)
        if ddp and ((step + 1) % args.eval_every == 0 or last):
            dist.barrier()

    if master:
        log(f"完了。確認用 loss の最小値: {best_val:.3f}")
    if ddp:
        dist.destroy_process_group()


if __name__ == "__main__":
    main()
