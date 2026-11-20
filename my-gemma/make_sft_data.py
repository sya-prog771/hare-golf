"""文書作成が得意になるための SFT データを、大きな先生モデルに作ってもらう（知識の蒸留）

  python make_sft_data.py meetings --n 500        # 架空の会議の文字起こし → 議事録 のペア
  python make_sft_data.py plans --n 300           # 打ち合わせメモ → 計画書 のペア
  python make_sft_data.py docs --input data/raw/wikipedia --n 2000   # 文書 → 要約・要点・FAQ・ToDo

先生モデルは Ollama などで動かすローカルLLM（既定: qwen3:8b）。
自作モデルは小さいので、先生の出力をまねさせることで「議事録の書き方」などを効率よく覚えさせます。
※ 先生モデルの利用規約で、出力を他のモデルの学習に使ってよいか確認してください（Qwen3 は Apache 2.0）。
"""
import argparse
import glob
import json
import os
import random
import re
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))

TOPICS = [
    "新商品の発売準備", "社内システムの入れ替え", "地域イベントの企画", "採用計画の見直し", "オフィス移転",
    "顧客アンケートの結果共有", "来期の予算編成", "Webサイトのリニューアル", "品質トラブルの再発防止",
    "営業チームの月次定例", "学校行事（文化祭）の準備", "町内会の防災訓練", "研究プロジェクトの進捗報告",
    "飲食店の新メニュー開発", "展示会への出展", "社員研修の企画", "在庫管理の改善", "カスタマーサポートの体制強化",
    "SNS運用方針", "経費精算ルールの変更", "新規取引先との契約", "福利厚生の見直し", "テレワーク規程",
]
DOC_TASKS = [
    ("要約", "次の文章を3〜5文で要約してください。"),
    ("要点", "次の文章の要点を箇条書きで5つ以内にまとめてください。"),
    ("FAQ", "次の文章をもとに、読者が疑問に思いそうな質問と答えを3組、「Q.」「A.」の形で作ってください。"),
    ("見出し", "次の文章に、内容がひと目でわかる見出しを付け、その下に50字程度のリード文を書いてください。"),
    ("説明", "次の文章の内容を、中学生にもわかるようにやさしく説明してください。"),
    ("ToDo", "次の文章から、読者が取るべき行動や確認すべき点を箇条書きで抜き出してください。なければ「特になし」と書いてください。"),
]


class Teacher:
    def __init__(self, backend, url, model):
        self.backend, self.url, self.model = backend, url.rstrip("/"), model

    def __call__(self, prompt, temperature=0.7):
        msgs = [{"role": "user", "content": prompt}]
        if self.backend == "ollama":
            body = {"model": self.model, "messages": msgs, "stream": False,
                    "options": {"temperature": temperature, "num_ctx": 8192}}
            url = self.url + "/api/chat"
        else:
            body = {"model": self.model, "messages": msgs, "temperature": temperature}
            url = self.url + "/chat/completions"
        req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=600) as r:
            d = json.loads(r.read())
        text = d["message"]["content"] if self.backend == "ollama" else d["choices"][0]["message"]["content"]
        return re.sub(r"(?s)<think>.*?</think>", "", text).strip()


def meeting_pair(t, rng):
    topic = rng.choice(TOPICS)
    people = rng.sample(["佐藤", "鈴木", "高橋", "田中", "伊藤", "渡辺", "山本", "中村", "小林", "加藤"], rng.randint(3, 5))
    transcript = t(f"「{topic}」についての会議の文字起こしを、話し言葉のまま書いてください。\n"
                   f"参加者は {'、'.join(people)}。日付・決定事項・担当者と期限のある宿題・結論の出なかった論点を自然に含め、"
                   f"「えー」などの言いよどみや脱線も少し入れてください。800〜1200字。文字起こし本文だけを出力。", 0.9)
    minutes = t("次の会議の文字起こしから議事録を作成してください。見出しは「議事録：（会議名）」「日時」「出席者」「議題」"
                "「議事内容」「決定事項」「ToDo（担当・期限の表）」「保留事項」「次回予定」。資料にない項目は（記載なし）。"
                "Markdownで、前置きなしで出力。\n\n" + transcript, 0.3)
    return [{"role": "user", "content": "次の会議の文字起こしから議事録を作成してください。\n\n" + transcript},
            {"role": "assistant", "content": minutes}]


def plan_pair(t, rng):
    topic = rng.choice(TOPICS)
    memo = t(f"「{topic}」について、担当者が書いた走り書きの打ち合わせメモを書いてください。箇条書き中心で、"
             f"背景・目的・アイデア・予算感・期限・懸念点が雑多に混ざっている状態。400〜700字。メモ本文だけを出力。", 0.9)
    plan = t("次のメモをもとに計画書を作成してください。見出しは「背景と課題」「目的」「目標（KPI）」「実施内容」"
             "「スケジュール（表）」「体制」「予算」「リスクと対策（表）」「次のアクション」。メモにない数値は（要設定）。"
             "Markdownで、前置きなしで出力。\n\n" + memo, 0.3)
    return [{"role": "user", "content": "次のメモをもとに計画書を作成してください。\n\n" + memo},
            {"role": "assistant", "content": plan}]


def iter_doc_chunks(paths, max_chars, rng):
    texts = []
    for p in paths:
        files = glob.glob(os.path.join(p, "**", "*.*"), recursive=True) if os.path.isdir(p) else [p]
        for f in files:
            if f.endswith(".jsonl"):
                with open(f, encoding="utf-8") as fh:
                    texts += [json.loads(l)["text"] for l in fh if l.strip()]
            elif f.endswith((".txt", ".md")):
                with open(f, encoding="utf-8") as fh:
                    texts += [x for x in re.split(r"\n{2,}", fh.read()) if len(x) > 200]
    rng.shuffle(texts)
    for t in texts:
        if len(t) > max_chars:
            start = rng.randint(0, len(t) - max_chars)
            t = t[start:start + max_chars]
        yield t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["meetings", "plans", "docs"])
    ap.add_argument("--n", type=int, default=100)
    ap.add_argument("--input", nargs="*", default=[os.path.join(HERE, "data", "raw")], help="docs で使う文書")
    ap.add_argument("--max-chars", type=int, default=1200, help="docs: 1件あたりの文書の長さ（自作モデルの文脈に収まる長さに）")
    ap.add_argument("--backend", default="ollama", choices=["ollama", "openai"])
    ap.add_argument("--url", default="http://localhost:11434")
    ap.add_argument("--teacher", default="qwen3:8b")
    ap.add_argument("--out")
    ap.add_argument("--seed", type=int)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    t = Teacher(args.backend, args.url, args.teacher)
    out = args.out or os.path.join(HERE, "data", "sft", f"{args.kind}.jsonl")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    chunks = iter_doc_chunks(args.input, args.max_chars, rng) if args.kind == "docs" else None
    made = fails = 0
    with open(out, "a", encoding="utf-8") as f:  # 追記なので、中断しても続きから増やせる
        while made < args.n:
            try:
                if args.kind == "meetings":
                    msgs = meeting_pair(t, rng)
                elif args.kind == "plans":
                    msgs = plan_pair(t, rng)
                else:
                    doc = next(chunks, None)
                    if doc is None:
                        print("文書を使い切りました")
                        break
                    name, inst = rng.choice(DOC_TASKS)
                    msgs = [{"role": "user", "content": f"{inst}\n\n{doc}"},
                            {"role": "assistant", "content": t(f"{inst}前置きなしで答えだけを出力してください。\n\n{doc}", 0.3)}]
            except Exception as e:
                fails += 1
                print(f"  失敗（スキップ）: {e}")
                if fails >= 5:
                    raise SystemExit("5回続けて失敗しました。先生モデル（Ollama など）が動いているか確認してください。")
                continue
            fails = 0
            if not msgs[-1]["content"]:
                continue
            f.write(json.dumps({"messages": msgs}, ensure_ascii=False) + "\n")
            f.flush()
            made += 1
            print(f"  {made}/{args.n} 件")
    print(f"→ {out}")


if __name__ == "__main__":
    main()
