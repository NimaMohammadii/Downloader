#!/bin/sh
set -eu

export DISPLAY="${DISPLAY:-:99}"

# WPC uses a real Chromium instance to mint fallback PO tokens. Cloudflare
# Containers are headless, so provide a tiny virtual X display for Chromium.
Xvfb "$DISPLAY" -screen 0 1280x720x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
sleep 0.5

cd /opt/bgutil/server
node build/main.js --port 4416 >/tmp/pot-provider.log 2>&1 &

# Wait until the fast local bgutil PO-token provider accepts connections.
i=0
until curl -sS -o /dev/null http://127.0.0.1:4416/; do
  i=$((i + 1))
  if [ "$i" -ge 50 ]; then
    cat /tmp/pot-provider.log >&2 || true
    cat /tmp/xvfb.log >&2 || true
    exit 1
  fi
  sleep 0.2
done

cd /app
exec python3 /app/youtube_telegram_guard.py
