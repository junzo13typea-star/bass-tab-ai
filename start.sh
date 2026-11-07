#!/bin/bash
# BassTab AI - ローカル起動スクリプト
PORT=8080
echo "🎸 BassTab AI スタジオを起動しています..."
echo "👉 ブラウザで http://localhost:${PORT} を開いてください"

# Macのデフォルトブラウザで自動で開く
sleep 1 && open "http://localhost:${PORT}" &

python3 -m http.server $PORT
