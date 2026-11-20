# 💎 my-gemma：Gemma 3 と同じ設計のLLMを0から作る

Google の **Gemma 3 と同じ設計** の言語モデルを部品から自分で書き、
**トークナイザ作り → 事前学習 → 指示チューニング（SFT） → 会話・API公開** までを全部自前で行うためのフォルダです。
Hugging Face などの既製モデル・既製トークナイザは使いません（使うのは PyTorch の行列計算と自動微分だけ）。

> ゴルフ場アプリ本体とは無関係で、公開サイト（gh-pages）にも含まれません。

## 本当に Gemma と同じ？
`model.py` は Gemma 3 の特徴をすべて手書きしています。

| 部品 | 内容 |
| --- | --- |
| RMSNorm（1+w 形式） | 大きさだけをそろえる正規化 |
| サンドイッチ正規化 | Attention・MLP の前後両方で正規化 |
| GQA | Key/Value の頭を減らしてメモリ節約 |
| QK-Norm | Query・Key を頭ごとに正規化（Gemma 3 の新機能） |
| RoPE（θ=1万／100万） | 近く用・全体用で回転の速さを変える |
| ローカル5：グローバル1 | 5層は直近だけ、6層目ごとに全体を見る（長文でも省メモリ） |
| GeGLU | GELU のゲート付き MLP |
| 埋め込み×√d・入出力共有 | Gemma 独特の埋め込みの扱い |

**検証**：`python test_vs_hf.py` で、Google 公式の実装（transformers の `Gemma3ForCausalLM`）と同じ重みを入れて出力を比べます。
誤差は 0.000002 未満で、KV キャッシュを使った生成時も一致することを確認済みです（`pip install transformers` が必要）。

トークナイザも Gemma（SentencePiece）と同じ考え方の「文字単位 BPE ＋ バイト・フォールバック」を自作しています（`tokenizer.py`）。
会話の形式も Gemma と同じ `<start_of_turn>user … <end_of_turn>` です。

## 先に知っておいてほしいこと（規模と費用）
設計が同じでも、賢さは「モデルの大きさ × 学習した文章の量 × 計算量」で決まります。
目安（計算量 ≒ 6 × パラメータ数 × トークン数。GPU の実効性能を RTX 4090 ≒ 60 TFLOPS、H100 ≒ 400 TFLOPS として概算）：

| プリセット | パラメータ | 学習トークン | RTX 4090 ×1 | H100 ×8 | できるようになること（目安） |
| --- | --- | --- | --- | --- | --- |
| `nano` | 1.5M | 〜数百万 | CPUで数分 | – | 動作確認用。意味のある文は書けない |
| `tiny` | 25M | 5億 | 30分〜1時間 | – | それらしい日本語の文の形 |
| `small` | 85M | 17億 | 4〜8時間 | – | 文法的な日本語。短い要約をまねる |
| `270m` | 270M | 54億 | 2〜3日 | 1時間 | 簡単な指示に従う。決まった書式の文書 |
| `1b` | 1B | 200億 | 約1か月（※） | 半日 | 簡単な要約・議事録の型 |
| （本家 Gemma 3 1B） | 1B | **2兆** | 約6年 | 約1.5か月（GPU代 数百万円） | 本家なみ |

- ※ `1b` は学習時に 16GB 以上のメモリを使うため、24GB の GPU では `--batch` をかなり小さくする必要があります
- 「学習トークン」はパラメータの約20倍（効率がよいとされる量）。本家はその100倍学習しています
- 日本語版ウィキペディア全体でおよそ 10億トークン前後です。それ以上は Web の文章（CC-100 など）が必要です
- **おすすめの進め方**：`nano` で流れを確認 → `tiny`/`small` を自分のGPU（またはクラウドGPUを数時間）で学習 →
  先生モデルに作ってもらった議事録・計画書データで SFT。小さなモデルでも「決まった書式に整える」のは得意になります

## 使い方
```bash
cd my-gemma
pip install torch numpy          # GPU があれば https://pytorch.org の手順で CUDA 版を
pip install pyarrow              # ウィキペディアを使う場合

# 1. 学習データを集める（自分の文書を data/raw/ に .txt で置いてもよい）
python fetch_data.py aozora                    # 青空文庫（少量・動作確認向け）
python fetch_data.py wikipedia --max-files 2   # 日本語ウィキペディアの一部（全部なら --max-files を外す）

# 2. トークナイザを作り、文章をトークン列にする
python prepare.py --vocab-size 32000

# 3. 事前学習（中断しても --resume で再開できる）
python pretrain.py --preset nano --max-steps 300          # まず動作確認
python pretrain.py --preset small --batch 32 --grad-accum 4 --max-steps 20000 --compile
torchrun --nproc_per_node=8 pretrain.py --preset 270m --batch 32 --grad-accum 2 --compile   # GPU 複数枚

# 4. 指示チューニング（SFT）用のデータを作って学習
python fetch_data.py dolly-ja                  # 日本語の指示データ 約1.5万件
ollama pull qwen3:8b                           # 先生モデル（議事録・計画書の手本を作ってもらう）
python make_sft_data.py meetings --n 1000      # 会議の文字起こし → 議事録
python make_sft_data.py plans --n 500          # メモ → 計画書
python make_sft_data.py docs --n 2000          # 文書 → 要約・要点・FAQ・ToDo
python sft.py --base out/pretrain/model.pt

# 5. 話す・使う
python chat.py                                 # ターミナルで会話
python serve.py                                # OpenAI 互換 API: http://localhost:8000/v1
```

### ノートブックAI（`../local-notebook`）から使う
`python serve.py` を起動したまま、ノートブックAIの ⚙ 設定で
「LLMの種類：OpenAI互換」「URL：`http://localhost:8000/v1`」「モデル：`my-gemma`」「文脈の長さ：`2048`」にすると、
自作モデルで資料への質問や議事録作成ができます（賢さはモデルの大きさと学習量しだい）。

## ファイル
| ファイル | 中身 |
| --- | --- |
| `model.py` | Gemma 3 と同じ設計のモデル本体・KVキャッシュ・生成・大きさのプリセット |
| `tokenizer.py` | 文字単位 BPE ＋ バイト・フォールバックのトークナイザ（学習も変換も自作） |
| `prepare.py` | トークナイザの学習と、データのトークン化（並列処理） |
| `pretrain.py` | 事前学習（混合精度・勾配累積・複数GPU・再開に対応） |
| `sft.py` | 指示チューニング（AIの発言部分だけで誤差を計算） |
| `make_sft_data.py` | 先生モデルから、議事録・計画書・要約などの手本データを作る |
| `fetch_data.py` | ウィキペディア・青空文庫・日本語指示データのダウンロード |
| `chat.py` / `serve.py` | 会話・OpenAI 互換 API サーバー |
| `test_vs_hf.py` / `hf_convert.py` | 本家 Gemma 3 実装との数値照合・重みの名前の変換 |

## loss の見方
- 事前学習の確認用 loss：語彙 32,000 で、10 前後から始まり 3 台に入るとそれらしい日本語になってきます
- 学習用だけ下がって確認用が上がる → 丸暗記（データ不足）。データを増やすか、モデルを小さく
- SFT の確認用 loss が下がり続けているのに回答がおかしい → 事前学習の不足。SFT だけでは知識は増えません

## データのライセンス
- ウィキペディア：CC BY-SA 4.0 ／ dolly-ja：CC BY-SA 3.0 ／ 青空文庫：著作権切れの作品
- 先生モデルの出力を学習に使う場合は、そのモデルの利用規約を確認してください（Qwen3 は Apache 2.0）
