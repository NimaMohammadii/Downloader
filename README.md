# Telegram Instagram Downloader

Telegram bot downloader running only on Cloudflare Workers.

Production endpoint:

`https://downloader.vexaagent.workers.dev`

## Architecture

Telegram -> Cloudflare Worker -> Instagram API/CDN -> Telegram

There is no Render service, Docker container, ffmpeg process, Cloudflare Container, Workflow, or Durable Object in the active downloader path.

## Supported links

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
