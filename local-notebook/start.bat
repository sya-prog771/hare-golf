@echo off
rem Windows 用：ダブルクリックで起動
cd /d "%~dp0"
py -m pip install -q -r requirements.txt
py server.py %*
pause
