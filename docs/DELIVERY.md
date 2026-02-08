# Delivery orchestrator (V0)

## V0 behavior

- Send a daily digest **via Signal** as:
  1) header message
  2) one message per track
- Add small delay between messages to preserve ordering.
- Always persist full digest markdown to disk.
- Prevent resends using `sent_digests` keyed by `digest_date`.

## Error handling (V0)

- If any Signal send fails, do **not** mark digest as sent.
- If discovery had errors (e.g. 429), include a friendly note in the header.

## V1 considerations (documented)

- Exactly-once delivery across partial failures (track-level send state)
- Idempotency keys beyond date (tracks hash / version)
- Per-track resend policies
- Delivery pacing and rate limits
- Better observability (structured logs + alerts)
