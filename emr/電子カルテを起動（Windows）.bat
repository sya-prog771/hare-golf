@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 電子カルテ 院内サーバー（この画面は閉じないでください）
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  ==========================================================
  echo   Node.js がまだ入っていません。
  echo   いま開いたページで「LTS」と書かれたほうをダウンロードしてインストールし、
  echo   パソコンを再起動してから、もう一度このファイルをダブルクリックしてください。
  echo   くわしくは emr フォルダの guide.html（接続ガイド）の手順2を見てください。
  echo  ==========================================================
  start "" "https://nodejs.org/ja/download"
  pause
  exit /b 1
)
node "server\server.js"
echo.
echo  電子カルテのサーバーが終了しました。何かキーを押すとこの画面を閉じます。
pause >nul
