# Telegram YouTube Downloader

A Telegram bot backend designed for Cloudflare Workers + Workflows + Containers.

Production endpoint:

`https://downloader.vexaagent.workers.dev`

## What it does

- Receives a YouTube / YouTube Shorts link through a Telegram webhook.
- Starts one durable Cloudflare Workflow per Telegram update.
- Runs `yt-dlp`, `ffmpeg`, and Deno inside a Cloudflare Container.
- Downloads a fast Telegram-friendly version up to 720p.
- Sends the result back as a Telegram video.
- Falls back to `sendDocument` if Telegram cannot treat the MP4 as a playable video.
- Automatically splits files that are too large for Telegram's normal Bot API upload limit.
- Rejects playlists and live streams for now instead of accidentally starting unbounded jobs.
- Uses Telegram `update_id` as the Workflow ID to avoid duplicate downloads when Telegram retries a webhook.

## Architecture

Telegram -> Worker webhook -> Cloudflare Workflow -> Cloudflare Container -> yt-dlp/ffmpeg -> Telegram

The Worker stays lightweight. The Linux-only download tooling runs in the Container, while Workflows keep long-running downloads durable without relying on polling.

## Requirements

- Cloudflare Workers Paid plan (Containers require the paid Workers plan).
- Docker available in the environment that runs `wrangler deploy`.
- A Telegram bot token from BotFather.
- Node.js/npm for Wrangler.

## Install

```bash
npm install
npm run types
```

## Configure secrets

Never commit the bot token.

```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
```

For `WEBHOOK_SECRET`, use a random value containing only letters, numbers, `_` or `-`.

Example generator:

```bash
openssl rand -hex 32
```

## Deploy to Cloudflare

Make sure Docker is running, then:

```bash
npm run deploy
```

Wrangler will build the Docker image, push it to Cloudflare's Container Registry, deploy the Container application, Workflow, Durable Object binding, and Worker.

The Worker name is `downloader`, so on the `vexaagent` workers.dev subdomain the expected URL is:

`https://downloader.vexaagent.workers.dev`

Check it:

```bash
curl https://downloader.vexaagent.workers.dev/health
```

Expected response:

```json
{"ok":true,"service":"telegram-youtube-downloader","domain":"downloader.vexaagent.workers.dev"}
```

## Set the Telegram webhook

Set these in your terminal for the command only:

```bash
export BOT_TOKEN='YOUR_TELEGRAM_BOT_TOKEN'
export WEBHOOK_SECRET='THE_SAME_SECRET_YOU_PUT_IN_CLOUDFLARE'
```

Then register the webhook:

```bash
curl -sS "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=https://downloader.vexaagent.workers.dev/telegram/webhook" \
  --data-urlencode "secret_token=${WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message"]'
```

Check Telegram's webhook status:

```bash
curl -sS "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

## Bot behavior

`/start` tells the user to send a YouTube link.

For a normal YouTube video or Shorts link, the bot shows a short progress message, downloads up to 720p, uploads the file, and removes the progress message after success.

If the final file is too large for the regular Telegram Bot API, it is split into Telegram-safe MP4 parts and sent sequentially.

## Current limitations

- Public single videos and Shorts are the target for v1.
- Playlists are intentionally rejected.
- Live streams are intentionally rejected.
- Private, age-restricted, geo-restricted, or YouTube anti-bot challenged videos can still require authenticated cookies/proxy support later.
- The normal Telegram Bot API has a smaller upload limit than a self-hosted Local Bot API server, so large videos are split in v1.

Only download content when you have permission to do so and comply with the source platform's applicable terms.
