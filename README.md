# arxiv-coach

Personal arXiv → learning pipeline for Mikey (LLM engineering, agent-first).

## Launch log

- 2026-02-08 — V0 shipped + first public post: https://x.com/mindofindica/status/2020621678603341915

## Goals

- Daily 10-minute briefing: max 3–5 high-signal papers relevant to *agents/LLM engineering*.
- Weekly deep dive: pick 1 paper, explain + connect to recent local corpus. (V1 ✓)
- Store PDFs forever + extract text for local search/explanations.
- On-demand explanations: ELI12 / undergrad / engineer breakdown.

## Non-goals (for V0)

- No fragile HTML scraping.
- No heavy UI.
- No embeddings/vector DB yet.

## Project layout

- `tracks.yml` — track definitions (keywords/phrases/categories/scoring)
- `data/`
  - `db.sqlite` — metadata + matches + digest history
  - `papers/YYYY/MM/<arxivId>/paper.pdf`
  - `papers/YYYY/MM/<arxivId>/paper.txt`
  - `papers/YYYY/MM/<arxivId>/meta.json`
  - `digests/daily/YYYY-MM-DD.md`
  - `digests/weekly/YYYY-Www.md`
- `scripts/` — runnable entrypoints
- `docs/` — design notes, ops, and future plans

## Running

### Daily Pipeline

```bash
npm run daily        # Full daily run: discovery + matching + artifacts
npm run plan-daily   # Generate delivery plan JSON for cron agent
npm run mark-sent    # Mark daily digest as sent (pass plan.json path)
```

### LLM Relevance Scoring

Papers are scored 1-5 by Sonnet for actual relevance (not just keyword matches). Low-scoring papers (1-2) are filtered from digests.

```bash
npm run plan-score     # Generate scoring plan for cron agent
npm run record-scores -- /path/to/scores.json  # Write scores to DB
```

See [docs/SCORING.md](docs/SCORING.md) for full documentation.

### Weekly Deep Dive

```bash
npm run plan-weekly-shortlist              # Saturday: generate shortlist of top 3 papers
npm run plan-weekly                        # Sunday: generate deep dive plan
npm run mark-weekly-sent <week> <arxivId>  # Mark weekly as sent

# With specific week:
npm run plan-weekly-shortlist -- --week=2026-W07
npm run plan-weekly -- --week=2026-W07
```

See [docs/WEEKLY.md](docs/WEEKLY.md) for full weekly feature documentation.

### On-Demand Explanations

Get explanations of papers at different technical levels:

```bash
# By arxiv ID
npm run explain -- "2602.06038" --level eli12

# By title search  
npm run explain -- "CommCP paper" --level undergrad

# By digest reference
npm run explain -- "#1 from today"
npm run explain -- "#2 from yesterday" --level engineer
```

**Levels:**
- `eli12` — Simple analogies, no jargon, for a smart 12-year-old
- `undergrad` — Technical but explains concepts, some math OK
- `engineer` — Full technical depth (default)

See [docs/EXPLAIN.md](docs/EXPLAIN.md) for full documentation.

### Signal Feedback Commands

Give real-time feedback on papers directly from Signal. Indica handles these in the main session via OpenClaw's heartbeat.

**Paper feedback** (require arxiv ID):
```
/read 2403.12345      ← mark as read (+8)
/love 2403.12345      ← strong positive (+10); bumps reading-list priority
/save 2403.12345      ← add to reading list (+5)
/meh  2403.12345      ← weak negative (-2)
/skip 2403.12345      ← deprioritise (-5)
```

**Query commands** (no ID needed):
```
/reading-list                        ← unread saved papers (limit 5)
/reading-list --status all --limit 10
/status                              ← system health snapshot
/stats                               ← 7-day activity breakdown
/stats --days 30
```

All commands are idempotent. Flags `--notes`, `--reason`, `--priority` work without quotes (Signal-safe).

See **[docs/signal-commands.md](docs/signal-commands.md)** for the complete reference.

```bash
npm run handle-feedback -- "/status"    # Test from CLI
```

### Other Commands

```bash
npm run init-db      # Initialize/migrate database
npm run artifacts    # Fetch PDFs + extract text for matched papers
```

## Scheduling

We’ll schedule daily delivery for **08:30 CET** (adjustable later). Implementation will read `config.yml` so changing the time won’t require code changes.
