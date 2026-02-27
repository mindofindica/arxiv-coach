# Signal Commands — Complete Reference

Send any of these commands to Indica on Signal. She'll parse them, update the database, and reply with a confirmation.

---

## Paper Feedback Commands

Give arxiv-coach a signal about a paper. These update your personalisation model and influence which papers appear in future digests.

### `/read <arxiv-id>`

Mark a paper as read. Sends a strong positive signal — you thought it was worth your time.

```
/read 2403.12345
/read 2403.12345 --notes "Great coverage of sparse attention — bookmark"
```

- **Signal strength:** +8
- **Side effect:** If the paper is in your reading list, marks it as `read` and records `read_at`
- **Idempotent:** sending `/read` twice returns "Already recorded"

---

### `/love <arxiv-id>`

Strongest positive feedback. Use this when a paper genuinely excites you.

```
/love 2403.12345
/love 2403.12345 --notes "This is the paper I've been waiting for"
```

- **Signal strength:** +10
- **Side effect:** If the paper is in your reading list, bumps its priority to `max(current, 8)`
- **Use sparingly** — the model learns that ❤️ means *really* relevant, not just interesting

---

### `/save <arxiv-id>`

Add a paper to your reading list without marking it read. Use this for "want to read later."

```
/save 2403.12345
/save 2403.12345 --priority 9 --notes "High priority: applies directly to the agent work"
```

- **Signal strength:** +5
- **Creates an entry** in `reading_list` with status `unread` and priority 1–10 (default: 5)
- **Idempotent:** sending `/save` twice doesn't duplicate; returns confirmation

---

### `/meh <arxiv-id>`

Weak negative. The paper showed up but wasn't worth your time.

```
/meh 2403.12345
/meh 2403.12345 --reason "Surface-level overview, nothing new"
```

- **Signal strength:** -2
- Use this for papers that were *adjacent* to your interests but not useful — helps the model learn the boundary

---

### `/skip <arxiv-id>`

Stronger negative. De-prioritise this paper and similar ones.

```
/skip 2403.12345
/skip 2403.12345 --reason "Too theoretical, not implementable"
```

- **Signal strength:** -5
- Use this when a paper clearly doesn't belong in your feed

---

## Query Commands

These don't require a paper ID — they query the database and return a snapshot.

### `/reading-list`

Show your unread saved papers.

```
/reading-list
/reading-list --limit 10
/reading-list --status all
/reading-list --status read --limit 20
```

**Options:**

| Flag | Values | Default | Description |
|------|--------|---------|-------------|
| `--status` | `unread` \| `read` \| `all` | `unread` | Filter by reading status |
| `--limit` | 1–20 | `5` | Max papers to show |

**Example reply:**
```
📚 Reading list (unread, 3 of max 5):
1. Scaling Laws for Neural Language Models [p8]
   arxiv:2001.08361
   📝 Re-read before the next sprint planning
2. Attention Is All You Need [p5]
   arxiv:1706.03762
3. Chain-of-Thought Prompting [p5]
   arxiv:2201.11903

Commands: /read <id> · /skip <id> · /love <id>
```

---

### `/status`

System health snapshot. Good morning check — shows you what happened overnight.

```
/status
```

No options.

**Example reply:**
```
📡 arxiv-coach status

🗓 Last digest: 2026-02-20 at 06:00 UTC (42 papers)
📄 Papers tracked: 1,973 total · 154 this week
📚 Reading list: 3 unread · 12 saved total
💬 Feedback: 7 papers rated this week
✅ System healthy
```

- Shows last digest time and paper count (requires digests table — populated when the digest runner is active)
- If no digest has run yet, shows "No digest sent yet"
- Always shows DB counts and reading list summary regardless

---

### `/stats`

Weekly activity breakdown. Good for Saturday morning coffee — what did you actually engage with this week?

```
/stats
/stats --days 14
/stats --days 30
```

**Options:**

| Flag | Values | Default | Description |
|------|--------|---------|-------------|
| `--days` | 1–90 | `7` | Window for stats |

**Example reply:**
```
📊 Stats (last 7 days)

Papers ingested: 154
Feedback given: 7
  ❤️ love: 2
  ✅ read: 3
  ⭐ save: 1
  😐 meh: 1
  ⏭️ skip: 0

Top tracks (by paper count):
  • agentic-reasoning: 48 papers
  • llm-efficiency: 31 papers
  • multimodal: 22 papers
```

- Track counts show which topics were most active in the window
- Feedback breakdown tells you how engaged you've been

---

### `/recommend`

Personalised paper recommendations based on your positive feedback history. Looks at papers you've loved, saved, and added to your reading list at high priority — then finds corpus papers with similar themes you haven't seen yet.

```
/recommend
/recommend --limit 10
/recommend --track LLM
```

**Options:**

| Flag | Values | Default | Description |
|------|--------|---------|-------------|
| `--limit` | 1–20 | `5` | Max recommendations to return |
| `--track` | string | — | Filter to a specific track (case-insensitive substring) |

**Example reply:**
```
🔮 5 picks based on 12 papers you loved/saved:
   Profile: speculative, decoding, inference, attention, transformer

1. Fast Speculative Inference for LLMs [LLM Efficiency] ★4
   2026-01-15 · arxiv:2601.12345
2. Attention-Optimised Decoder Architectures [LLM] ★5
   2026-01-12 · arxiv:2601.23456
...

Commands: /love <id> · /save <id> · /skip <id>
Options: /recommend --limit 10 · /recommend --track LLM
```

**How it works:**
1. Collects "seed" papers: anything you've loved, saved, or added to your reading list with priority ≥ 7
2. Extracts topic keywords from seed paper titles (stop-word filtered)
3. Runs an FTS5 query to find corpus papers matching those keywords
4. Excludes papers already seen in digests, in your reading list, or previously rated
5. Re-ranks by FTS relevance + LLM score + recency
6. Returns the top-N unseen papers most aligned with your taste profile

**When it says "not enough data":** Send `/love` or `/save` on a few papers you genuinely liked — that's the minimum signal needed to build a recommendation profile.

---

### `/search <query>`

Full-text search over the entire paper corpus. Useful when you want to explore a specific topic on demand.

```
/search speculative decoding
/search "retrieval augmented generation"
/search LoRA fine-tuning --limit 10
/search agent --track LLM
/search RLHF --from 2026
```

**Options:**

| Flag | Values | Default | Description |
|------|--------|---------|-------------|
| `--limit` | 1–20 | `5` | Max results to return |
| `--track` | string | — | Filter to papers in a specific track |
| `--from` | YYYY, YYYY-MM | — | Only papers published on or after this date |

---

## ArXiv ID Formats

All feedback commands accept the same ID formats:

```
/read 2403.12345            ← bare ID (most common)
/read 2403.12345v2          ← version suffix (stripped automatically)
/read arxiv:2403.12345      ← arxiv: prefix
/read https://arxiv.org/abs/2403.12345   ← full URL (paste from browser)
```

---

## Flags

All paper feedback commands support optional flags:

| Flag | Type | Description |
|------|------|-------------|
| `--notes <text>` | string | Free-text note stored with the feedback |
| `--reason <text>` | string | Why you skipped/mehed (useful for calibration) |
| `--priority <1-10>` | int | `/save` only — reading list priority (default: 5) |

**Quoting is optional** — Signal strips quotes, so multi-word values work either way:
```
/save 2403.12345 --notes interesting approach to sparse attention
/save 2403.12345 --notes "interesting approach to sparse attention"
```

Both are equivalent.

---

## Command Summary Table

| Command | Requires ID? | Signal | What it does |
|---------|-------------|--------|--------------|
| `/read` | ✅ | +8 | Mark as read; update reading-list status |
| `/love` | ✅ | +10 | Strongest positive; bump reading-list priority |
| `/save` | ✅ | +5 | Add to reading list (unread) |
| `/meh` | ✅ | -2 | Weak negative |
| `/skip` | ✅ | -5 | Deprioritise paper + type |
| `/reading-list` | ❌ | — | Show saved papers |
| `/status` | ❌ | — | System health snapshot |
| `/stats` | ❌ | — | Weekly activity breakdown |
| `/weekly` | ❌ | — | Weekly paper summary (current or given ISO week) |
| `/search <query>` | ❌ | — | FTS5 full-text search over corpus |
| `/recommend` | ❌ | — | Personalised recommendations from feedback history |

---

## Error Replies

If something goes wrong, you'll get a clear error:

| Situation | Reply |
|-----------|-------|
| Unknown command | `⚠️ Unknown command: /foo. Supported: /read /skip /save /love /meh /reading-list` |
| Missing arxiv ID | `⚠️ Missing arxiv ID. Usage: /read <arxiv-id>` |
| Invalid arxiv ID | `⚠️ Could not find a valid arxiv ID in: "xyz"` |
| Paper not in DB | `❓ Paper not found in local DB: 2403.12345` |
| DB error | `❌ Error recording feedback: <detail>` |

Paper-not-found usually means the paper hasn't been ingested yet (digest hasn't run, or the paper is very new). You can check https://arxiv.org/abs/2403.12345 to verify the ID.

---

## Integration

Commands are handled by OpenClaw via a heartbeat rule in `HEARTBEAT.md`:

```
When a message starts with /read, /save, /skip, /love, /meh,
/reading-list, /status, or /stats:

  cd /root/.openclaw/workspace/projects/arxiv-coach
  echo "<message>" | npm run handle-feedback --

Parse JSON output:
  shouldReply=true → send reply to Signal
  wasCommand=false → not an arxiv command, ignore
```

The underlying script is `src/scripts/handle-feedback.ts`. It opens the SQLite database, parses the message, records the feedback or runs the query, and writes JSON to stdout. No network calls, no side effects beyond the local DB.

---

## See Also

- [`docs/signal-feedback.md`](./signal-feedback.md) — original feedback integration design
- [`docs/FEEDBACK_TRACKING.md`](./FEEDBACK_TRACKING.md) — how signal strengths affect scoring
- [`docs/OPS.md`](./OPS.md) — operations guide (DB location, digest schedule, etc.)
- `src/lib/feedback/` — all source code for command parsing and handling
