# ⛳ フェアウェイ予報

都道府県・日付・時間を選ぶと、その時間に雨が降らなそうなゴルフ場を一覧で表示するスマホ向けWebアプリ（PWA）です。

## できること
- 都道府県・日付（16日先まで）・時間帯で、ゴルフ場を「雨なし / 微妙 / 雨」に分けて表示
- 日ごとの「雨なし」ゴルフ場の数を並べて、晴れるゴルフ場が多い日（最多）がひと目でわかる
- 日付・時間・降水確率を変えると、通信なしでその場で判定し直す
- 1時間ごとの天気・降水確率・気温・風、強風・寒さ・暑さの注意表示
- お気に入り（☆）、名前・市町村でのしぼりこみ、現在地から近い順の並べ替え
- 「友人に教える」で、アプリのQRコードとURLを切りかえて表示（コピー・LINEなどで送る）
- 条件つきリンクの共有（`?pref=13&date=2026-11-22&s=480&e=960`）
- ホーム画面に追加して使える（オフライン時は前回のデータを表示）、ダークモード対応

## しくみ
| ファイル | 内容 |
| --- | --- |
| `index.html` | アプリ本体（1ファイル） |
| `courses/XX.json` | 都道府県別ゴルフ場一覧。国税庁の評価倍率表（ゴルフ場用地等用）・OpenStreetMap・Wikipedia・国土地理院から `tools/build_courses_nta.py` で作成（毎月自動更新） |
| `tools/osm_snapshot`・`tools/wikipedia_snapshot.json` | 地図データ（毎月取り直し）と Wikipedia（手動で取り直し）の控え。国税庁の表に名前がない県を補う |
| `weather/XX.json` | 全ゴルフ場の16日予報。`tools/build_weather.py` が Open-Meteo から1日3回取得（gh-pages にのみ置く） |
| `lib/qrcode.js` | QRコード作成ライブラリ [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4（MIT License, © Kazuhiko Arase） |
| `.github/workflows/` | 上記の自動更新と、gh-pages ブランチへの公開 |

同梱の予報が古い・取れないときは、アプリが Open-Meteo に直接問い合わせます。

## 公開
`main` に push すると、GitHub Actions がアプリと最新の予報を `gh-pages` ブランチに公開します（GitHub Pages の公開元を `gh-pages` にしておく）。
