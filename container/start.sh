#!/bin/sh
set -eu

cd /opt/bgutil/server
node build/main.js --port 4416 &

# Give the local PO-token provider a moment to start before the downloader
# begins accepting jobs on its Cloudflare Container port.
sleep 2

exec python /app/app.py
