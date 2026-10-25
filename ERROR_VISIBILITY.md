# Membership timing and error visibility

The admin membership panel retains its enable/disable switch and adds three
persistent timing choices: at start, at the first link/download request, or after
the first successfully delivered download (the existing default). Modes do not
reset prior delivery history. The first-link trigger persists after restart;
commands, downloadable media and existing download buttons cannot bypass it.
Start mode also checks direct requests from users who skip /start. Channel
membership is checked again so leaving the channel restores the gate. The admin
remains exempt. Disabled mode does not enforce membership.

Public errors are selected from `container/public_errors.json`, shared by the
Worker and Python container. The catalog distinguishes invalid links/selections,
private or expired content, formats, audio, recognition, source and Telegram
limits, processing timeouts, file size, partial/uncertain delivery, membership
checks, capacity, network and internal service failures. User restrictions require
an explicit user-access signal; source/account/service restrictions never imply
that the user is banned. Unknown errors retain the general investigation message.

Messages contain only fixed user-safe text and a relevant next action. Provider
names, credentials, raw codes, URLs, account setup and diagnostic text are never
interpolated into public replies. Original reasons remain available to the admin;
this visibility policy does not forward user failures to the admin. Group replies
remain public and callback identity comes from the authenticated Telegram update.

The warning custom emoji (`5447644880824181073`), bold text, native draft animation
and progressive status edits apply to every catalog message. Validated animation
prefixes retain their entities without exposing original errors. Callback alerts
remain plain text because Telegram does not support entities/animation there.
Media captions, successful progress, internal retry codes and delivery decisions
are preserved. Container results remain internal.

Checks: `npm run check`, `node --test tests/*.test.mjs`, and Python unittest
discovery for `test_error_visibility.py`, `test_public_error_catalog.py` and
`test_usage.py`. Shared examples in `tests/public-error-cases.json` exercise both
language implementations.
