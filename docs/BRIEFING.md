# Weekly Personal Briefing

Monday morning AI research digest — delivered to Signal at 09:00 CET.

## What it is

The weekly briefing is a **proactive, personal** digest. It shows up in your Signal inbox every Monday without you having to ask. It's different from:

- `/weekly` — paper volume + top papers for the week (on-demand query)
- `/stats` — feedback counts breakdown (on-demand query)
- `/streak` — reading streak only (on-demand query)

The briefing **weaves all of that together** and adds context you can't get from any single command:

- "You might have missed" papers (high-score papers that weren't in your digests)
- Engagement rate (how much you rated vs how much came in)
- A personal nudge based on your streak

## Format

```
🌅 Good morning, Mikey — W13 in AI research
Mon 23 Mar → Sun 29 Mar

🔥 Reading streak: 7 days  (best: 12)
░░░░░░░▓▓▓▓▓▓▓▓  (14d)

📊 Last 7 days
📥 42 papers in  •  8 rated (19% engagement)
❤️ 2  ✅ 3  ⭐ 2  😐 1  ⏭️ 5

📌 Top picks this week (LLM-ranked)

1. Scaling Laws for Reward Model Overoptimization
   🔥 LLM:5/5 • LLM-engineering, RLHF
   We show that reward model score increases then decreases as a function of KL divergence.
   https://arxiv.org/abs/2402.01234

2. Efficient Inference via Speculative Decoding
   ⭐ LLM:4/5 • LLM-engineering
   Speculative decoding accelerates autoregressive decoding by 2-3x.
   https://arxiv.org/abs/2402.05678

📭 You might have missed

• Constitutional AI: Harmlessness from AI Feedback
  ⭐ LLM:4/5 • AI-alignment
  https://arxiv.org/abs/2212.08073

💪 7-day streak — keep it going!
```

## Schedule

Delivered every **Monday at 09:00 CET** via OpenClaw cron → Signal.

The cron job calls `npm run weekly-briefing`, which outputs JSON.
OpenClaw reads the `message` field and sends it to Signal.

## Scripts

```bash
# Run normally (marks briefing as sent)
npm run weekly-briefing

# Dry run (prints JSON, does NOT mark sent)
npm run weekly-briefing -- --dry-run

# Override week (useful for testing / backfill)
npm run weekly-briefing -- --week=2026-W13

# Combine
npm run weekly-briefing -- --week=2026-W13 --dry-run
```

## Output JSON

```json
{
  "status": "sent" | "skipped_already_sent" | "error",
  "weekIso": "2026-W13",
  "message": "<Signal text>",
  "error": null,
  "truncated": false,
  "dryRun": false,
  "stats": {
    "currentStreak": 7,
    "longestStreak": 12,
    "feedbackTotal": 8,
    "papersIngested": 42,
    "topPapers": 3,
    "missedPapers": 1
  }
}
```

## Sections

### Reading streak
- **Current streak**: consecutive days you logged any feedback
- **Longest streak**: personal best (rolling 90-day window)
- **Sparkline**: ▓/░ visual for last 14 days

### Feedback activity (last 7 days)
- Papers ingested vs papers rated
- Engagement rate: `(loved + read + saved + meh) / papersIngested`
- Per-type breakdown: ❤️ loved, ✅ read, ⭐ saved, 😐 meh, ⏭️ skipped

### Top picks
- Up to 3 highest-scored papers matched this week
- Ranked by LLM relevance score first (if available), then keyword score
- Includes first sentence of abstract as a one-line highlight
- Shows track labels (LLM-engineering, RLHF, etc.)

### You might have missed
- Papers scored ≥4/5 (LLM) in the last 14 days that **weren't in any digest** you received
- Powered by `digest_papers` table for precise per-paper dedup
- Falls back gracefully if `digest_papers` or `paper_scores` tables don't exist

### Streak nudge
Varies by state:
- **0 streak**: encourages first `/read` of the week
- **3+ days**: "building momentum"
- **7+ days**: "on a roll!"
- **Matching personal best**: "new personal best!"
- **Below personal best**: nudges to chase it

## Idempotency

Each week is tracked in `sent_weekly_briefings` (SQLite). Running the script twice in the same week returns `status: "skipped_already_sent"` and sends nothing.

Use `--dry-run` to preview without marking sent.

## Code layout

```
src/lib/briefing/
  briefing.ts          — data gathering (streak, feedback, top papers, missed)
  render-briefing.ts   — Signal-ready formatter
  briefing.test.ts     — 48 tests

src/scripts/
  send-weekly-briefing.ts  — runnable entrypoint (JSON output)
```

## OpenClaw cron setup

Add to your cron config (Monday 09:00 CET = 08:00 UTC):

```
# arxiv-coach weekly briefing — Monday 09:00 CET
0 8 * * 1  cd /root/repos/arxiv-coach && npm run weekly-briefing | node -e "
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    const result = JSON.parse(Buffer.concat(chunks).toString());
    if (result.status === 'sent' && result.message) {
      // OpenClaw delivers result.message to Signal
    }
  });
"
```

Or via OpenClaw gateway cron with a `systemEvent` payload that triggers the script and delivers the output.
