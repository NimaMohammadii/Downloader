# Telegram YouTube Downloader

A Telegram bot backend designed to run on Cloudflare Workers Free + Workflows, without Containers or Docker.

Production endpoint:

`https://downloader.vexaagent.workers.dev`

## Architecture

Telegram -> Cloudflare Worker -> Cloudflare Workflow -> YouTube.js -> secure Worker media stream

There is no Docker image, ffmpeg process, Durable Object, or Cloudflare Container in this version.

## What it does

- Accepts normal YouTube and Shorts links.
- Uses `youtubei.js/cf-worker`, the Cloudflare Worker build of YouTube.js.
- Uses one Workflow per Telegram update so duplicate webhook deliveries do not create duplicate jobs.
- Picks a pre-muxed MP4 format that already contains both video and audio.
- For smaller files, Telegram fetches the secure Worker media URL and sends the video directly in chat.
- For larger files, the bot shows a `Download video` button instead of failing.
- `/media/...` streams bytes from YouTube through Cloudflare without loading the whole video into Worker memory.
- Media links are temporary and HMAC-signed using the bot token.
- Rejects private and live/upcoming videos.

## Cloudflare plan

This version does **not** require Cloudflare Containers or Workers Paid.

Cloudflare Workflows are available on the Workers Free plan, subject to the normal Free-plan limits.

## Required secret

Only the Telegram Bot Token must be stored as a Cloudflare secret/environment secret:

`BOT_TOKEN`

Never put the Bot Token in the repository.

The Telegram webhook verification value is intentionally hardcoded in `src/index.ts`:

`dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1`

Because the repository is public, this webhook value is not confidential. The media-download links do not use this value; they are signed with the private `BOT_TOKEN`.

## Deploy

The normal Cloudflare Git build command is enough:

`npx wrangler deploy`

Docker is not required anymore.

After deploy, open:

`https://downloader.vexaagent.workers.dev/health`

Expected shape:

```json
{
  "ok": true,
  "service": "telegram-youtube-downloader",
  "mode": "worker-streaming",
  "domain": "downloader.vexaagent.workers.dev",
  "botConfigured": true
}
```

If `botConfigured` is false, add the `BOT_TOKEN` secret in the Cloudflare Worker settings and deploy again.

## Telegram webhook

Webhook URL:

`https://downloader.vexaagent.workers.dev/telegram/webhook`

Webhook secret:

`dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1`

The webhook only needs to be set again if its URL or secret changes.

## Important limitation of the free architecture

There is no ffmpeg in a normal Worker. That means this version cannot merge separate high-quality YouTube video-only and audio-only tracks.

It intentionally chooses a YouTube MP4 stream that already includes both video and audio. This keeps the system serverless and avoids the paid Container requirement, but some videos may only expose a lower pre-muxed quality such as 360p.

For files too large for Telegram's remote-URL send limit, the bot gives the user a secure direct-download button instead.

Private, age-restricted, region-restricted, or YouTube anti-bot challenged videos may still fail and can require authenticated cookies, a PO-token service, or a proxy later.

Only download content when you have permission to do so and comply with the source platform's applicable terms.
