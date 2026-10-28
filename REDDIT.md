# Reddit downloader

Send a public Reddit post URL, or `/reddit URL`. Supported input includes
`reddit.com/.../comments/...`, `redd.it`, `/gallery/` and `/r/.../s/...` share
links, plus direct `v.redd.it` video and `i.redd.it` image links.

- Native videos merge the available video and audio tracks into MP4. Posts
  requiring audio fail if audio cannot be obtained; explicitly silent videos
  remain silent. Direct video links preserve audio when the manifest has it.
- Images and galleries are sent as original documents, in gallery order.
- Galleries support up to 20 files, with at most 2 GB of prepared files per
  request. All gallery files are prepared before any upload starts.
- External embeds, profiles, subreddit feeds and unavailable/private posts are
  not downloaded. An external embed never invokes another site's downloader.
- Uncertain Telegram uploads stop without retrying and report confirmed sends.

## Optional Reddit session

Reddit can deny anonymous requests from server IP addresses, even for public
posts. If that happens, the bot returns a Reddit-specific access error. An
authorized browser session can be supplied through the **Worker secret**
`REDDIT_COOKIES`, containing a browser-exported JSON cookie array, for example:

```json
[{"domain":".reddit.com","name":"reddit_session","value":"YOUR_SESSION_VALUE"}]
```

Keep this secret out of the repository. Only Reddit cookie domains are accepted.
The current secret is read for each Reddit job, including rotation or removal;
it is not stored in Workflow parameters, download history or Container storage.
Cookie sessions are scoped to that job's Reddit page requests and are never
forwarded to image/video CDNs. This does not guarantee access when Reddit blocks
the server or the account lacks permission.

## Isolation

`src/reddit.ts` owns Reddit input parsing; `container/reddit.py` owns resolution,
downloads, validation and delivery. Shared files contain only routing, membership,
history, secret forwarding, packaging and existing lifecycle dispatch hooks.
No new download queue or changes to another platform's downloader are required.

Tests: `node --test tests/reddit.test.mjs` and
`python -m unittest discover -s tests -p test_reddit.py` (using the Container's
Python dependencies and FFmpeg).
