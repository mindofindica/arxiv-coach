# Incident: Cron Auth Outage (2026-04-08 → 2026-05-01)

**Duration:** ~22 days (April 8 – May 1, 2026)  
**Affected crons:** All 8 arxiv-coach crons + Memory Processing + 2 proactivity crons  
**Impact:** LLM scoring paused (accumulated 122-paper backlog), daily digest failed 22/24 days, weekly crons missed entirely

---

## Root Cause

All crons were using `model: "sonnet"` (= `anthropic/claude-sonnet-4-6`) with the default global fallback chain:

```
anthropic/claude-sonnet-4-6 → anthropic/claude-opus-4-5 → openai-codex/gpt-5.1
```

**Three simultaneous failures:**

1. **Anthropic quota exhausted** — Claude.ai web token profiles (`anthropic:default` and `anthropic:manual`) hit usage limits. Error: `"You're out of extra usage. Add more at claude.ai/settings/usage"`. Both profiles fail, triggering cooldown.

2. **OpenAI Codex OAuth expired** — The `openai-codex:default` OAuth token became stale/invalid. Error: `"OAuth token refresh failed for openai-codex: Failed to refresh OpenAI Codex token. Please try again or re-authenticate."` This is a manual re-auth that Mikey needs to do.

3. **OpenRouter credits depleted** (briefly) — Around April 6, OpenRouter credits ran out. This has since been resolved (balance: $5.00 as of May 2).

All three fallback paths failed simultaneously, causing `FallbackSummaryError: All models failed (N)` on every cron run.

---

## Why It Self-Healed

The daily digest and LLM scoring crons recovered on **May 1, 2026** when Anthropic usage quota reset (monthly reset). The OpenAI Codex OAuth remains broken.

---

## Fix Applied (Night Shift, 2026-05-02)

Added **OpenRouter fallbacks** to all affected crons via `cron.update`:

```json
{
  "fallbacks": [
    "openrouter/google/gemini-2.5-flash",
    "openrouter/meta-llama/llama-4-maverick"
  ]
}
```

Updated crons:
- `8a4579df` — arxiv-coach LLM scoring (pre-digest)
- `ad4774c2` — arxiv-coach daily digest (Telegram)
- `9ab9fee3` — arxiv-coach: fetch artifacts (PDFs)
- `c101cb0e` — arxiv-coach weekly shortlist (Saturday)
- `77b0bd6d` — arxiv-coach: hot paper instant alerts
- `b73f55c7` — arxiv-coach weekly deep dive (Sunday) ← opus → [sonnet, gemini-flash, llama-4]
- `0b6045f8` — arxiv-coach: weekly top papers
- `985c2e24` — arxiv-coach: weekly personal briefing
- `c359226f` — Memory Processing
- `abe4f1bb` — proactivity: prune moments
- `05ba873c` — proactivity: resolve tentpole events

---

## Future Resilience

The new fallback chain for all crons is now:

```
anthropic/claude-sonnet-4-6         ← primary (fastest, best quality)
  → anthropic/claude-opus-4-5       ← Anthropic fallback (global default)
  → openrouter/google/gemini-2.5-flash   ← OpenRouter (different provider!)
  → openrouter/meta-llama/llama-4-maverick  ← second OpenRouter option
```

This means any single provider outage will not halt all crons. OpenRouter requires credits — monitor at `/api/quota` dashboard endpoint.

---

## Remaining Action Items for Mikey

1. **OpenAI Codex re-auth** — The Codex OAuth token is expired. To fix:
   - Open a terminal and run: `/usr/bin/openclaw auth codex` (or similar)
   - Or check the OpenClaw docs for Codex re-authentication flow

2. **Monitor OpenRouter credits** — $5 balance as of May 2. Dashboard at `localhost:8420/api/quota` via SSH tunnel.

---

## Backlog Status (as of 2026-05-02 01:00 UTC)

- **Papers requiring scoring:** 122 (track-matched but unscored)
- **Total papers ingested since outage:** ~478 (April 6 + May 1 fetches)
- **Scoring cron last ran:** May 1 ✅ (scored 15 papers)
- **Daily digest last ran:** May 1 ✅ (sent to Telegram)

The backlog will be cleared at 15 papers/day. At current rate: ~8 days to clear fully.
If faster clearing is needed, Mikey can trigger a manual scoring run:

```bash
cd /root/.openclaw/workspace/projects/arxiv-coach
npm run plan-score | head -c 10000  # check backlog
# Then let the scoring cron run naturally, or trigger it manually
```
