# Architecture (V0 → V2)

## North star
Primary: **LLM engineering** with emphasis on **agents**.

This tool is not a paper collector; it is a learning pipeline that creates daily/weekly learning artifacts.

---

## V0 (ship fast, stay useful)

### Inputs
- arXiv Atom feeds (category-first polling) and/or arXiv API queries.
- Track definitions (`tracks.yml`).

### Pipeline
1. **Discover**: fetch Atom feeds for selected categories for the last N days.
   - V0 cap: **100 results per category** (conservative / arXiv-friendly). Revisit if we miss too much.
2. **Normalize**: parse entries into canonical `Paper` objects.
3. **Match**: local scoring of title+abstract to tracks (deterministic).
4. **Acquire**: download PDF, extract text to `.txt`.
5. **Digest**: produce daily brief (max 5 items overall; max 2 per track).
6. **Deliver**: send via Signal.

### Stored artifacts
- SQLite metadata + track matches + run logs
- PDFs + extracted text
- Digest markdown snapshots

---

## V1 (learning loop)

- Better ranking tuned for agents (tool use, planning, memory, eval, reliability)
- "Gap detector": track unknown terms/questions + suggest micro-lessons
- On-demand explain uses local corpus (related papers from last 30 days)
- Track user feedback: read/skip + confusion points

---

## V2 (local research OS)

- Chunking + embeddings for retrieval
- Compare papers (claims/evals/ablations)
- Idea generator grounded in your stored corpus
- Optional UI/dashboard

---

## Key design constraints

- No fragile scraping.
- No bundler required.
- Deterministic matching in V0; LLM is additive, not required to function.
- All times configurable (CET default) so schedule can change without refactor.
