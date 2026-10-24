# Error visibility

Users receive this message for download, preparation, upload, retry, callback,
partial-delivery and membership-check failures:

> ❌ خطایی رخ داده است؛ در حال بررسی و پیگیری هستیم و به‌زودی رفع می‌شود.

The existing reason is retained for the fixed admin ID (`7138547731`) and
reported to that private chat for errors encountered by other users. Groups
always receive the public message. Telegram callback identity comes from the
verified update, never callback data. Internal context fields are removed before
sending to Telegram. Reports redact tokens and URLs.

The policy runs before Telegram drafts and final sends in both the Worker and
Python container. Diagnostic fields returned from the container remain internal
so workflow retry and delivery decisions continue to use the real error codes.
User-provided media captions and successful progress messages are preserved.
Unexpected HTTP failures return the same public message. Admin notification
failure does not weaken the public policy; server diagnostics remain available.

For new error messages, use a leading ❌ or set the Worker's internal
`_errorDetail` field with a safe diagnostic. Send through the shared Telegram
helpers so reporting and masking happen before animation. Never send raw
container results directly to a public API response.

Checks: `npm run check`, `node --test tests/*.test.mjs`, and
`python -m unittest discover -s tests -p test_error_visibility.py`.
