"""学習データの準備: トークナイザを学習し、全文章をトークン番号の列にして保存する

  python prepare.py --input data/raw            # data/raw 以下の .txt / .md / .jsonl をすべて使う
  python prepare.py --input data/raw --vocab-size 32000

出力（--out、既定 data/tokens）:
  tokenizer.json  自作BPEトークナイザ
  train.bin       学習用トークン列（numpy の uint16/uint32 をそのまま並べたもの）
  val.bin         確認用トークン列
  meta.json       語彙数・トークン数など
"""
import argparse
import glob
import json
import os
import random
import time
from multiprocessing import Pool

import numpy as np

from tokenizer import BPETokenizer

HERE = os.path.dirname(os.path.abspath(__file__))


def list_files(inputs):
    files = []
    for p in inputs:
        if os.path.isdir(p):
            for ext in ("txt", "md", "jsonl"):
                files += glob.glob(os.path.join(p, "**", f"*.{ext}"), recursive=True)
        elif os.path.exists(p):
            files.append(p)
    return sorted(set(files))


def iter_docs(files):
    """1文書ずつ返す。.jsonl は1行1文書（"text" 欄）、.txt/.md は1ファイル1文書"""
    for f in files:
        if f.endswith(".jsonl"):
            with open(f, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if line:
                        try:
                            t = json.loads(line).get("text", "")
                        except json.JSONDecodeError:
                            continue
                        if t.strip():
                            yield t
        else:
            with open(f, encoding="utf-8", errors="replace") as fh:
                t = fh.read()
            if t.strip():
                yield t


def sample_texts(files, max_bytes):
    """トークナイザの学習用に、全体からまんべんなく max_bytes 分を取り出す"""
    total = sum(os.path.getsize(f) for f in files)
    keep = min(1.0, max_bytes / max(total, 1))
    rng = random.Random(0)
    got = 0
    for doc in iter_docs(files):
        if keep >= 1.0 or rng.random() < keep:
            got += len(doc.encode("utf-8"))
            yield doc
            if got >= max_bytes:
                break


_tok = None


def _init(path):
    global _tok
    _tok = BPETokenizer.load(path)


def _encode(doc):
    return [_tok.bos_id] + _tok.encode(doc) + [_tok.eos_id]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", nargs="+", default=[os.path.join(HERE, "data", "raw")])
    ap.add_argument("--out", default=os.path.join(HERE, "data", "tokens"))
    ap.add_argument("--vocab-size", type=int, default=32000)
    ap.add_argument("--tok-sample-mb", type=int, default=100, help="トークナイザの学習に使う量（MB）")
    ap.add_argument("--tokenizer", help="既存の tokenizer.json を使う（追加学習のときなど）")
    ap.add_argument("--val-every", type=int, default=200, help="何文書に1つを確認用にするか")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    args = ap.parse_args()

    files = list_files(args.input)
    if not files:
        raise SystemExit(f"{args.input} に .txt / .md / .jsonl がありません。先に fetch_data.py を実行してください。")
    total_mb = sum(os.path.getsize(f) for f in files) / 1e6
    print(f"入力: {len(files)} ファイル / {total_mb:,.1f} MB")
    os.makedirs(args.out, exist_ok=True)
    tok_path = os.path.join(args.out, "tokenizer.json")

    # 1) トークナイザ
    if args.tokenizer:
        tok = BPETokenizer.load(args.tokenizer)
        tok.save(tok_path)
        print(f"トークナイザ: {args.tokenizer} を使用（語彙 {tok.vocab_size:,}）")
    elif os.path.exists(tok_path):
        tok = BPETokenizer.load(tok_path)
        print(f"トークナイザ: 既存の {tok_path} を使用（作り直すときは削除してください）")
    else:
        print(f"トークナイザを学習中（語彙 {args.vocab_size:,}、最大 {args.tok_sample_mb} MB を使用）…")
        t0 = time.time()
        tok = BPETokenizer.train(sample_texts(files, args.tok_sample_mb * 1_000_000), args.vocab_size)
        tok.save(tok_path)
        print(f"  完了: 語彙 {tok.vocab_size:,}（{time.time() - t0:.0f}秒）")

    # 2) 全文章をトークン列に（並列処理）
    dtype = np.uint16 if tok.vocab_size <= 65535 else np.uint32
    paths = {s: os.path.join(args.out, f"{s}.bin") for s in ("train", "val")}
    counts = {"train": 0, "val": 0}
    t0 = time.time()
    with open(paths["train"], "wb") as ftr, open(paths["val"], "wb") as fva, \
            Pool(args.workers, initializer=_init, initargs=(tok_path,)) as pool:
        for i, ids in enumerate(pool.imap(_encode, iter_docs(files), chunksize=16)):
            split = "val" if (i % args.val_every) == args.val_every - 1 else "train"
            (fva if split == "val" else ftr).write(np.asarray(ids, dtype=dtype).tobytes())
            counts[split] += len(ids)
            if (i + 1) % 10000 == 0:
                print(f"  {i + 1:,} 文書 / {sum(counts.values()):,} トークン（{time.time() - t0:.0f}秒）")

    # 文書が少なくて確認用が空なら、学習用の末尾を確認用に回す
    if counts["val"] < 2048 and counts["train"] > 4096:
        arr = np.fromfile(paths["train"], dtype=dtype)
        n_val = max(2048, len(arr) // 50)
        arr[-n_val:].tofile(paths["val"])
        arr[:-n_val].tofile(paths["train"])
        counts = {"train": len(arr) - n_val, "val": n_val}

    meta = {"vocab_size": tok.vocab_size, "dtype": np.dtype(dtype).name, "train_tokens": counts["train"],
            "val_tokens": counts["val"], "files": len(files)}
    with open(os.path.join(args.out, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(f"完了: 学習用 {counts['train']:,} トークン / 確認用 {counts['val']:,} トークン → {args.out}")
    print(f"  （目安: パラメータ数の約20倍のトークンがあると効率よく学習できます）")


if __name__ == "__main__":
    main()
