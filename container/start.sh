#!/bin/sh
set -eu

cd /app
exec /opt/venv/bin/python /app/youtube_pipeline.py
