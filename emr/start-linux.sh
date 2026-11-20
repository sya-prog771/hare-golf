#!/bin/sh
# 電子カルテ 院内サーバー（Linux）
cd "$(dirname "$0")" && exec node server/server.js
