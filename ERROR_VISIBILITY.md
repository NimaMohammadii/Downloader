# Error visibility

Users receive this message for download, preparation, upload, retry, callback,
partial-delivery and membership-check failures:

> ⚠️ مثل اینکه خطایی پیش اومده، در حال بررسی و پیگیری است، به زودی رفع می‌شود.

The existing reason is retained only for the admin’s own requests in the
private admin chat (`7138547731`). Other users’ errors never trigger admin
notifications. Groups always receive the public message. Telegram callback identity comes from the
verified update, never callback data. Internal context fields are removed before
sending to Telegram.

The public message starts with custom emoji `5447644880824181073`; the three
phrases about the error, investigation and resolution are bold. New private
messages use native draft animation, and status errors reveal the text in three
bounded edits before the final complete message. Callback alerts remain plain
text because Telegram does not support entities or animation there.

The policy runs before Telegram drafts and final sends in both the Worker and
Python container. Diagnostic fields returned from the container remain internal
so workflow retry and delivery decisions continue to use the real error codes.
User-provided media captions and successful progress messages are preserved.
Unexpected HTTP failures return the same public message. Server diagnostics remain
available without sending unsolicited error reports.

For new error messages, use a leading ❌ or set the Worker's internal
`_errorDetail` field with a safe diagnostic. Send through the shared Telegram
helpers so masking happens before animation. Never send raw
container results directly to a public API response.

Checks: `npm run check`, `node --test tests/*.test.mjs`, and
`python -m unittest discover -s tests -p test_error_visibility.py`.
