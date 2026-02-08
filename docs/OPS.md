# Ops / How to run

## Configuration (planned)

- `config.yml`
  - `timezone`: default `Europe/Amsterdam`
  - `dailyDigestTime`: e.g. `08:30`
  - `weeklyDigestDay`: e.g. `Sun`
  - `weeklyDigestTime`: e.g. `11:00`
  - `storageRoot`: default `data/`

## Scripts (planned)

- `node scripts/run-daily.mjs` — discover/match/download/extract + produce digest
- `node scripts/run-weekly.mjs` — select deep dive + weekly recap
- `node scripts/explain.mjs <arxivId> --level ...` — explanation

## Dependencies

- Node.js (already present)
- `pdftotext` (Poppler utils) for extraction (we’ll install if missing)

## Changing schedule

Schedule is driven by the gateway cron job, but the delivery time should live in `config.yml` so it can be updated easily.

When Mikey’s schedule changes:
- update cron job time, or
- move to a "heartbeat checks config and decides whether to send" model.

We’ll pick whichever is simpler once V0 is running.
