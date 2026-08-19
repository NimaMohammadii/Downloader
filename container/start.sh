#!/bin/sh
set -eu

cd /opt/bgutil/server
node build/main.js --port 4416 >/tmp/pot-provider.log 2>&1 &

# Wait until the local PO-token provider accepts connections before exposing the downloader.
i=0
until curl -sS -o /dev/null http://127.0.0.1:4416/; do
  i=$((i + 1))
  if [ "$i" -ge 50 ]; then
    cat /tmp/pot-provider.log >&2 || true
    exit 1
  fi
  sleep 0.2
done

cd /app
exec python3 /app/youtube_app.py
