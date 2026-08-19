#!/bin/bash
set -u

REAL_YTDLP="/opt/venv/bin/yt-dlp-real"
TMPDIR_YTDLP="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_YTDLP"' EXIT

rewrite_and_run() {
  local client="$1"
  local out_file="$2"
  local err_file="$3"
  shift 3

  local -a rewritten=()
  local arg
  for arg in "$@"; do
    if [[ "$arg" == youtube:player_client=* ]]; then
      rewritten+=("youtube:player_client=${client}")
    else
      rewritten+=("$arg")
    fi
  done

  "$REAL_YTDLP" \
    --force-overwrites \
    --force-ipv4 \
    --sleep-requests 1 \
    --extractor-retries 1 \
    --retry-sleep extractor:1 \
    "${rewritten[@]}" \
    >"$out_file" 2>"$err_file"
}

# Keep clients isolated so a token/URL generated for one client is never reused
# by another. mweb + PO provider remains the primary path.
clients=("mweb" "web_safari" "android_vr" "web_embedded")
last_code=1
attempt=0

for client in "${clients[@]}"; do
  attempt=$((attempt + 1))
  out_file="$TMPDIR_YTDLP/out-${attempt}"
  err_file="$TMPDIR_YTDLP/err-${attempt}"

  if rewrite_and_run "$client" "$out_file" "$err_file" "$@"; then
    cat "$out_file"
    exit 0
  else
    last_code=$?
  fi
done

for i in $(seq 1 "$attempt"); do
  if [[ -s "$TMPDIR_YTDLP/err-${i}" ]]; then
    header="===== yt-dlp attempt ${i} (${clients[$((i - 1))]}) ====="
    echo "$header" >&2
    cat "$TMPDIR_YTDLP/err-${i}" >&2
    if [[ -w /proc/1/fd/2 ]]; then
      echo "$header" > /proc/1/fd/2
      cat "$TMPDIR_YTDLP/err-${i}" > /proc/1/fd/2
    fi
  fi
done

exit "$last_code"
