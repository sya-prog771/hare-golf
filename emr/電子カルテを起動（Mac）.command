#!/bin/bash
# 電子カルテ 院内サーバー（親機）を起動する。このウィンドウは閉じないでください。
cd "$(dirname "$0")" || exit 1
for p in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin"; do
  [ -x "$p/node" ] && PATH="$p:$PATH"
done
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  =========================================================="
  echo "   Node.js がまだ入っていません。"
  echo "   いま開いたページで「LTS」と書かれたほうをダウンロードしてインストールし、"
  echo "   もう一度このファイルをダブルクリックしてください。"
  echo "   くわしくは emr フォルダの guide.html（接続ガイド）の手順2を見てください。"
  echo "  =========================================================="
  open "https://nodejs.org/ja/download"
  read -n 1 -s -r -p "  何かキーを押すと閉じます"
  exit 1
fi
node server/server.js
