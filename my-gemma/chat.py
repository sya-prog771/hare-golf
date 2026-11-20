"""学習したモデルと話す（完全オフライン）

  python chat.py                                 # SFT済みモデルと会話（out/sft/model.pt）
  python chat.py --model out/pretrain/model.pt   # 事前学習だけのモデル: 書き出しの続きを書く
"""
import argparse
import os

import torch

from model import Gemma, GemmaConfig
from pretrain import pick_device
from tokenizer import BPETokenizer, StreamDecoder

HERE = os.path.dirname(os.path.abspath(__file__))


def load_model(path, device="auto", dtype=None):
    """model.pt とその隣の tokenizer.json を読み込む"""
    device = pick_device(device)
    ckpt = torch.load(path, map_location="cpu", weights_only=False)
    cfg = GemmaConfig.from_dict(ckpt["config"])
    cfg.dropout = 0.0
    model = Gemma(cfg)
    model.load_state_dict(ckpt["model"])
    if dtype is None and device.startswith("cuda") and torch.cuda.is_bf16_supported():
        dtype = torch.bfloat16
    model.to(device=device, dtype=dtype or torch.float32).eval()
    tok = BPETokenizer.load(os.path.join(os.path.dirname(os.path.abspath(path)), "tokenizer.json"))
    return model, tok, bool(ckpt.get("chat"))


def stream_text(model, tok, ids, **gen):
    dec = StreamDecoder(tok)
    for i in model.generate(ids, stop_ids=(tok.eos_id, tok.eot_id), **gen):
        piece = dec.feed(i)
        if piece:
            yield piece
    rest = dec.flush()
    if rest:
        yield rest


def main():
    ap = argparse.ArgumentParser()
    default = os.path.join(HERE, "out", "sft", "model.pt")
    if not os.path.exists(default):
        default = os.path.join(HERE, "out", "pretrain", "model.pt")
    ap.add_argument("--model", default=default)
    ap.add_argument("-n", "--max-tokens", type=int, default=512)
    ap.add_argument("--temperature", type=float, default=0.7)
    ap.add_argument("--top-k", type=int, default=50)
    ap.add_argument("--top-p", type=float, default=0.95)
    ap.add_argument("--repetition-penalty", type=float, default=1.1)
    ap.add_argument("--system", default="", help="AIへの前提の指示")
    ap.add_argument("--device", default="auto")
    args = ap.parse_args()

    if not os.path.exists(args.model):
        raise SystemExit(f"{args.model} がありません。先に pretrain.py（と sft.py）で学習してください。")
    model, tok, is_chat = load_model(args.model, args.device)
    gen = dict(max_new_tokens=args.max_tokens, temperature=args.temperature, top_k=args.top_k,
               top_p=args.top_p, repetition_penalty=args.repetition_penalty)
    print(f"{args.model}（{model.num_params() / 1e6:.0f}M）を読み込みました。"
          + ("会話モード" if is_chat else "続きを書くモード（SFT前のモデル）") + "。q で終了、/reset で会話をリセット")

    history = [{"role": "system", "content": args.system}] if args.system else []
    while True:
        try:
            text = input("\nあなた> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if text == "q":
            break
        if text == "/reset":
            history = history[:1] if args.system else []
            continue
        if not text:
            continue
        if is_chat:
            history.append({"role": "user", "content": text})
            ids = tok.chat_ids(history)
            print("AI> ", end="", flush=True)
        else:
            ids = [tok.bos_id] + tok.encode(text)
            print(text, end="", flush=True)
        answer = ""
        for piece in stream_text(model, tok, ids, **gen):
            answer += piece
            print(piece, end="", flush=True)
        print()
        if is_chat:
            history.append({"role": "assistant", "content": answer})


if __name__ == "__main__":
    main()
