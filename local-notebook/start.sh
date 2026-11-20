#!/bin/sh
# Mac / Linux 用：ダブルクリックまたは ./start.sh で起動
cd "$(dirname "$0")"
python3 -m pip install -q -r requirements.txt 2>/dev/null
python3 server.py "$@"
