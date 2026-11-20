"""学習データを集める

  python fetch_data.py aozora              # 青空文庫の小説（数MB。動作確認向け）
  python fetch_data.py wikipedia           # 日本語版ウィキペディア全体（約 1.5GB の文章。要 pip install pyarrow）
  python fetch_data.py wikipedia --max-files 2   # 一部だけ
  python fetch_data.py dolly-ja            # 日本語の指示データ 約1.5万件（SFT用）

自分の文書（議事録・企画書・メモなど）を data/raw/ に .txt で置けば、それも事前学習に使われます。
ライセンス: ウィキペディア CC BY-SA 4.0 / dolly-ja CC BY-SA 3.0 / 青空文庫 著作権切れの作品
"""
import argparse
import io
import json
import os
import re
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "data", "raw")
SFT = os.path.join(HERE, "data", "sft")
UA = {"User-Agent": "my-gemma-fetch/1.0"}


def http_get(url, timeout=120):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def download(url, path):
    """大きなファイルを少しずつ保存（途中経過を表示）"""
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r, open(path + ".part", "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        while True:
            buf = r.read(1 << 20)
            if not buf:
                break
            f.write(buf)
            done += len(buf)
            if total:
                print(f"\r    {done / 1e6:,.0f} / {total / 1e6:,.0f} MB", end="", flush=True)
    print()
    os.replace(path + ".part", path)


# ---------------- 青空文庫 ----------------
AOZORA = {
    "natsume_wagahai": "https://www.aozora.gr.jp/cards/000148/files/789_ruby_5639.zip",
    "natsume_botchan": "https://www.aozora.gr.jp/cards/000148/files/752_ruby_2438.zip",
    "natsume_kokoro": "https://www.aozora.gr.jp/cards/000148/files/773_ruby_5968.zip",
    "akutagawa_rashomon": "https://www.aozora.gr.jp/cards/000879/files/127_ruby_150.zip",
    "miyazawa_ginga": "https://www.aozora.gr.jp/cards/000081/files/456_ruby_145.zip",
    "dazai_melos": "https://www.aozora.gr.jp/cards/000035/files/1567_ruby_4948.zip",
    "dazai_ningen": "https://www.aozora.gr.jp/cards/000035/files/301_ruby_5915.zip",
}


def clean_aozora(text):
    text = text.replace("\r\n", "\n")
    parts = re.split(r"\n-{10,}\n", text)
    if len(parts) >= 3:
        text = parts[0].split("\n")[0] + "\n" + "\n".join(parts[2:])
    text = re.split(r"\n底本：", text)[0]
    text = re.sub(r"《[^》]*》", "", text)
    text = re.sub(r"［＃[^］]*］", "", text)
    return re.sub(r"\n{3,}", "\n\n", text.replace("｜", "")).strip() + "\n"


def fetch_aozora(args):
    out = os.path.join(RAW, "aozora")
    os.makedirs(out, exist_ok=True)
    for name, url in AOZORA.items():
        try:
            z = zipfile.ZipFile(io.BytesIO(http_get(url)))
            txt = next(n for n in z.namelist() if n.endswith(".txt"))
            body = clean_aozora(z.read(txt).decode("cp932", errors="replace"))
            with open(os.path.join(out, name + ".txt"), "w", encoding="utf-8") as f:
                f.write(body)
            print(f"  {name}: {len(body):,} 文字")
        except Exception as e:
            print(f"  {name}: 失敗 ({e})")


# ---------------- ウィキペディア ----------------
WIKI_API = "https://huggingface.co/api/datasets/wikimedia/wikipedia/parquet/{config}/train"


def fetch_wikipedia(args):
    try:
        import pyarrow.parquet as pq
    except ImportError:
        raise SystemExit("pip install pyarrow を実行してください")
    urls = json.loads(http_get(WIKI_API.format(config=args.wiki_config)))
    if args.max_files:
        urls = urls[:args.max_files]
    out = os.path.join(RAW, "wikipedia")
    tmp = os.path.join(HERE, "data", "download")
    os.makedirs(out, exist_ok=True)
    os.makedirs(tmp, exist_ok=True)
    print(f"{len(urls)} ファイルをダウンロードします（{args.wiki_config}）")
    for i, url in enumerate(urls):
        dst = os.path.join(out, f"wiki_{i:03d}.jsonl")
        if os.path.exists(dst):
            print(f"  {i + 1}/{len(urls)} 済み")
            continue
        pq_path = os.path.join(tmp, f"wiki_{i:03d}.parquet")
        print(f"  {i + 1}/{len(urls)} {url.rsplit('/', 1)[-1]}")
        download(url, pq_path)
        n = 0
        with open(dst + ".part", "w", encoding="utf-8") as f:
            for batch in pq.ParquetFile(pq_path).iter_batches(columns=["title", "text"], batch_size=2000):
                for title, text in zip(batch.column("title").to_pylist(), batch.column("text").to_pylist()):
                    if text and len(text) >= args.min_chars:
                        f.write(json.dumps({"text": f"{title}\n\n{text}"}, ensure_ascii=False) + "\n")
                        n += 1
        os.replace(dst + ".part", dst)
        os.remove(pq_path)
        print(f"    {n:,} 記事")


# ---------------- 指示データ（SFT用） ----------------
DOLLY_JA = "https://huggingface.co/datasets/kunishou/databricks-dolly-15k-ja/resolve/main/databricks-dolly-15k-ja.json"


def fetch_dolly(args):
    os.makedirs(SFT, exist_ok=True)
    data = json.loads(http_get(DOLLY_JA))
    path = os.path.join(SFT, "dolly-ja.jsonl")
    with open(path, "w", encoding="utf-8") as f:
        for d in data:
            if d.get("output"):
                f.write(json.dumps({"instruction": d.get("instruction", ""), "input": d.get("input", ""),
                                    "output": d["output"]}, ensure_ascii=False) + "\n")
    print(f"  {len(data):,} 件 → {path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["aozora", "wikipedia", "dolly-ja"])
    ap.add_argument("--max-files", type=int, help="wikipedia: 先頭の何ファイルだけ取るか")
    ap.add_argument("--wiki-config", default="20231101.ja")
    ap.add_argument("--min-chars", type=int, default=200, help="wikipedia: これより短い記事は使わない")
    args = ap.parse_args()
    {"aozora": fetch_aozora, "wikipedia": fetch_wikipedia, "dolly-ja": fetch_dolly}[args.what](args)


if __name__ == "__main__":
    main()
