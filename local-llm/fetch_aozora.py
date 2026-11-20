"""青空文庫（著作権の切れた日本語の小説）から学習用テキストを集める

使い方:
  python fetch_aozora.py                     # 下の一覧をまとめて data/ に保存
  python fetch_aozora.py --url https://www.aozora.gr.jp/cards/.../files/xxx_ruby_yyy.zip

URLは各作品の図書カードページ下部「テキストファイル(ルビあり)」のzipへのリンクです。
"""
import argparse
import io
import os
import re
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))

WORKS = {
    "natsume_wagahai":   "https://www.aozora.gr.jp/cards/000148/files/789_ruby_5639.zip",
    "natsume_botchan":   "https://www.aozora.gr.jp/cards/000148/files/752_ruby_2438.zip",
    "natsume_kokoro":    "https://www.aozora.gr.jp/cards/000148/files/773_ruby_5968.zip",
    "akutagawa_rashomon": "https://www.aozora.gr.jp/cards/000879/files/127_ruby_150.zip",
    "miyazawa_ginga":    "https://www.aozora.gr.jp/cards/000081/files/456_ruby_145.zip",
    "dazai_melos":       "https://www.aozora.gr.jp/cards/000035/files/1567_ruby_4948.zip",
    "dazai_ningen":      "https://www.aozora.gr.jp/cards/000035/files/301_ruby_5915.zip",
}


def clean(text):
    """ルビ・注記・前書き/後書きを取り除いて本文だけにする"""
    text = text.replace("\r\n", "\n")
    # 冒頭の「-----」で囲まれた記号の説明を消す
    parts = re.split(r"\n-{10,}\n", text)
    if len(parts) >= 3:
        text = parts[0].split("\n")[0] + "\n" + "\n".join(parts[2:])
    # 末尾の「底本：」以降を消す
    text = re.split(r"\n底本：", text)[0]
    text = re.sub(r"《[^》]*》", "", text)   # ルビ  漢字《かんじ》
    text = re.sub(r"［＃[^］]*］", "", text)  # 入力者注  ［＃改ページ］
    text = text.replace("｜", "")            # ルビの開始位置記号
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip() + "\n"


def fetch(name, url, out_dir):
    req = urllib.request.Request(url, headers={"User-Agent": "local-llm-fetch/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        z = zipfile.ZipFile(io.BytesIO(r.read()))
    txt_name = next(n for n in z.namelist() if n.endswith(".txt"))
    raw = z.read(txt_name).decode("cp932", errors="replace")  # 青空文庫は Shift_JIS
    body = clean(raw)
    path = os.path.join(out_dir, f"{name}.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)
    print(f"  {name}: {len(body):,} 文字 → {path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", action="append", help="追加でダウンロードするzipのURL（複数可）")
    ap.add_argument("--out", default=os.path.join(HERE, "data", "aozora"))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    works = dict(WORKS)
    for u in args.url or []:
        works[os.path.splitext(os.path.basename(u))[0]] = u

    for name, url in works.items():
        try:
            fetch(name, url, args.out)
        except Exception as e:  # 1作品失敗しても他は続ける
            print(f"  {name}: 失敗しました ({e})")


if __name__ == "__main__":
    main()
