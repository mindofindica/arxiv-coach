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

### Other Commands

```bash
npm run init-db      # Initialize/migrate database
npm run artifacts    # Fetch PDFs + extract text for matched papers
npm run explain      # On-demand paper explanation (planned)
```

## Scheduling

We’ll schedule daily delivery for **08:30 CET** (adjustable later). Implementation will read `config.yml` so changing the time won’t require code changes.
