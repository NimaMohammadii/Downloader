# Telegram Instagram Downloader

Telegram bot with Instagram delivery on Cloudflare Workers and full YouTube downloads in a Cloudflare Container.

Production endpoint:

`https://downloader.vexaagent.workers.dev`

## Architecture

Telegram -> Cloudflare Worker -> Instagram API/CDN -> Telegram

Instagram keeps its existing Worker path. YouTube links are handled by a Workflow and a Container running yt-dlp, ffmpeg and Telethon.

## YouTube in bot chat

Send a YouTube video or Shorts URL, then select 360p, 480p, 720p, 1080p or audio. Only available qualities are offered. The complete file is delivered as one message, up to 2,000,000,000 bytes; larger files are rejected with a request to choose a lower quality. Unavailable fragments abort the download instead of producing incomplete videos.

Set Worker secrets `API_ID` and `API_HASH` from my.telegram.org alongside `BOT_TOKEN`. The Worker passes them to the Container environment; no user login or session string is needed. Telethon authenticates as the existing bot and preserves its HTTP webhook. Eight upload parts are in flight at a time with bounded memory; YouTube fragment downloads also use eight concurrent requests. These are transfer optimizations, not a fixed speed guarantee.

The Docker image and Container/Workflow bindings must be deployed with `npx wrangler deploy`. A source commit alone does not activate this feature. There are up to 20 Container instances and they sleep after five minutes idle; Cloudflare Container and Workflow charges apply.

## Supported Instagram links

- Instagram Reel
- Instagram video post
- Instagram carousel media
- Instagram Story
- Instagram Highlights

Public Reel/Post downloads are attempted without an Instagram session first. A valid Instagram session can improve reliability and is required for Stories when Instagram requires login.

## Telegram delivery

The bot does not show a download-link button. The Worker resolves the Instagram media and creates a short-lived signed media proxy URL. Telegram fetches that URL and posts the actual video/photo into the chat.

Telegram's Bot API remote-URL limits apply: currently 20 MB for videos/other content and 5 MB for photos. The Worker tries lower Instagram renditions when a larger rendition exceeds that limit.

## Required Cloudflare secret

`BOT_TOKEN`

Never commit the bot token to the repository.

## Optional Instagram secrets

For Story/Highlight support and content that Instagram gates behind login, add these as Cloudflare Worker secrets/environment variables:

- `INSTAGRAM_SESSIONID` — main required Instagram session cookie
- `INSTAGRAM_CSRFTOKEN` — optional but recommended when available
- `INSTAGRAM_DS_USER_ID` — optional

Do not commit Instagram cookies to GitHub.

## Deploy

Cloudflare build/deploy command:

`npx wrangler deploy`

After deploy open:

`https://downloader.vexaagent.workers.dev/health`

Expected shape:

```json
{
  "ok": true,
  "service": "telegram-instagram-downloader",
  "mode": "cloudflare-only",
  "botConfigured": true,
  "instagramSessionConfigured": false
}
```

`instagramSessionConfigured` becomes `true` after `INSTAGRAM_SESSIONID` is added.

## Telegram webhook

Webhook URL remains unchanged:

`https://downloader.vexaagent.workers.dev/telegram/webhook`

Webhook verification value remains:

`dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1`

You do not need to set the webhook again just because the downloader changed from YouTube to Instagram.

Only download content when you have permission to do so and comply with the source platform's applicable terms.
