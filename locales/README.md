# Bot languages

`messages.json` is the shared presentation catalog for the Worker and Python container.
Each row keeps the existing Persian source (`fa`) and friendly English (`en`) and Russian (`ru`) translations. Public error messages come first, followed by onboarding, buttons, progress, help and dynamic status templates. `{0}`, `{1}`, etc. preserve runtime values.

- `/lang` opens a language picker; `/lang fa`, `/lang en` and `/lang ru` select directly.
- Persian remains the default. Existing Persian messages and download decisions stay unchanged.
- Preferences use separate `language:<user-id>` keys in the existing durable store, with no SQL migration.
- `/lang` sends a complete menu at the current chat position, then removes only the previously saved language menu and the recognized private command. Language buttons edit their existing message. Optional animation uses drafts for new menus and short edit previews for callbacks; preview failures cannot skip the final full message.
- Globe and confirmation icons use custom emoji entities; the menu reads the sticker emoji from Telegram so its fallback text and UTF-16 entity match. The selected language button uses Telegram’s custom icon field. Download messages are never cleanup targets.
- Group buttons belong to the user who opened the picker. Other users cannot change that preference.
- Worker async scopes and container context variables isolate concurrent users. Workflow/container payloads carry only an additional language setting.
- Localize after public error sanitization. Never put raw diagnostics into translations.
- Rebuild Telegram entity offsets in UTF-16 after translation. Callback data, URLs, file IDs and download parameters must stay unchanged.
- Administrative broadcasts retain their authored content. The catalog covers the bot's user interface, not external media titles or a separate web app.

When adding a user-facing message, add both translations here and run `npm run check`, `node --test tests/localization.test.mjs` and `python -m unittest discover -s tests -p test_localization.py`. The Dockerfile copies this same catalog into the container.
