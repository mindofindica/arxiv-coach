# Signal Feedback Commands

Give arxiv-coach real-time feedback on papers directly from Signal.

> **Full reference:** [`docs/signal-commands.md`](./signal-commands.md) — complete command docs including `/reading-list`, `/status`, and `/stats`.

## Commands

Reply to any Signal message (or send a new one) with:

### Paper Feedback (require arxiv ID)

| Command | Effect | Signal Strength |
|---------|--------|-----------------|
| `/read 2403.12345` | Mark as read | +8 |
| `/love 2403.12345` | Strong positive; bumps reading-list priority | +10 |
| `/save 2403.12345` | Add to reading list | +5 |
| `/meh 2403.12345` | Weak negative | -2 |
| `/skip 2403.12345` | Deprioritise | -5 |

### Query Commands (no arxiv ID needed)

| Command | What it returns |
|---------|-----------------|
| `/reading-list` | Unread saved papers (default: 5) |
| `/reading-list --status all --limit 10` | All saved papers with custom limit |
| `/status` | System health snapshot (last digest, papers, reading list) |
| `/stats` | 7-day activity breakdown (feedback counts, top tracks) |
| `/stats --days 30` | Longer window (1–90 days) |

## Arxiv ID Formats

All of these work:

```
/read 2403.12345
/read 2403.12345v2          # version suffix stripped automatically
/read arxiv:2403.12345      # arxiv: prefix
/save https://arxiv.org/abs/2403.12345  # full URL
```

## Flags

```
/read 2403.12345 --notes "Interesting approach to sparse attention"
/skip 2403.12345 --reason "Too theoretical for current focus"
/save 2403.12345 --priority 8    # 1-10, default 5
```

## What Happens

1. **`/read`** — Records read, marks as `in_progress` in reading list (if saved)
2. **`/save`** — Adds to reading list with priority; paper stays `unread` until `/read`
3. **`/love`** — Strongest positive signal; system boosts similar papers in future
4. **`/skip`** or **`/meh`** — Negative signals; system deprioritises similar papers
5. **Idempotent** — sending the same command twice is safe (you'll get "Already recorded")

## Integration Architecture

```
Signal message
    ↓
OpenClaw cron agent (every ~5 min, or on-demand)
    ↓
src/scripts/handle-feedback.ts "<message text>"
    ↓
src/lib/feedback/
  ├── parser.ts     — regex parsing of /command arxiv-id [--flags]
  ├── recorder.ts   — SQLite writes (paper_feedback, user_interactions, reading_list)
  ├── handler.ts    — orchestrates parse + record, returns reply text
  └── migrate.ts    — creates feedback tables if not present
    ↓
stdout: JSON { shouldReply, wasCommand, reply?, arxivId? }
    ↓
cron agent sends reply back to Signal (if shouldReply=true)
```

## Cron Integration (OpenClaw)

The cron agent handling Signal feedback should:

1. Receive the incoming message text from Signal
2. Run: `cd /root/.openclaw/workspace/projects/arxiv-coach && npm run handle-feedback -- "<message>"`
3. Parse the JSON output
4. If `shouldReply=true`, send `reply` back to Signal

## DB Tables

Feedback is persisted to three tables (auto-created on first use):

- `paper_feedback` — explicit feedback (read/skip/save/love/meh) per paper
- `user_interactions` — timestamped event log with signal strengths
- `reading_list` — saved papers with status (unread → in_progress → read) and priority

## Reading List

From Signal (shipped):
```
/reading-list               ← unread papers, limit 5
/reading-list --status all --limit 10
/reading-list --status read
```

From CLI:
```bash
tsx src/commands/feedback.ts reading-list
tsx src/commands/feedback.ts reading-list --status unread
tsx src/commands/feedback.ts summary --last 7
```

## What's Shipped (V1)

All of these work today:
- ✅ `/read`, `/love`, `/save`, `/meh`, `/skip` — paper feedback with idempotency
- ✅ `/reading-list` with `--status` and `--limit` flags
- ✅ `/status` — system health snapshot
- ✅ `/stats` — weekly activity breakdown with `--days` window
- ✅ `/love` → reading-list priority bump (max of current and 8)

## Future Work

- **Personalised scoring**: use `signal_strength` history to reweight `llm_scores` at digest selection time
- **Weekly pattern analysis**: surface which paper types get loved vs skipped
- **Auto-expand similar tracks**: if you consistently love `agentic reasoning` papers, add related keywords to that track
- **`/digest`**: on-demand digest for a specific track or topic
