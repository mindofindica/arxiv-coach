# arxiv-coach

Personal arXiv → learning pipeline for Mikey (LLM engineering, agent-first).

## Goals

- Daily 10-minute briefing: max 3–5 high-signal papers relevant to *agents/LLM engineering*.
- Weekly deep dive: pick 1 paper, explain + connect to recent local corpus.
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

## Running (planned)

- Daily ingestion + digest: `node scripts/run-daily.mjs`
- Weekly deep dive: `node scripts/run-weekly.mjs`
- Explain: `node scripts/explain.mjs <arxivId> --level eli12|undergrad|engineer`

## Scheduling

We’ll schedule daily delivery for **08:30 CET** (adjustable later). Implementation will read `config.yml` so changing the time won’t require code changes.
