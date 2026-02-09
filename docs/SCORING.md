# LLM-Assisted Relevance Scoring

arxiv-coach uses LLM-assisted scoring to improve paper relevance beyond keyword matching. Papers are evaluated by an AI model (Sonnet) for their actual relevance to LLM agent engineering.

## Overview

Keyword matching catches papers that mention relevant terms, but can't tell if a paper is truly relevant or just uses similar vocabulary. LLM scoring adds a "second opinion" that reads the title and abstract to judge actual relevance.

**Key insight:** The scoring doesn't happen in Node.js code. An OpenClaw cron agent does the LLM scoring using the plan-score output, then writes results via record-scores. This keeps the codebase simple and leverages OpenClaw's AI capabilities.

## Scoring Scale

| Score | Meaning | Example |
|-------|---------|---------|
| 1 | Not relevant | Different field, keyword coincidence |
| 2 | Tangentially relevant | Mentions concepts but isn't about them |
| 3 | Somewhat relevant | Related field, useful background |
| 4 | Relevant | Directly about LLM agents, tool use, or AI engineering |
| 5 | Highly relevant | Must-read for someone building LLM agent systems |

## Pipeline Flow

```
07:30 CET — Scoring Cron
┌─────────────────────────────────────────────────────────────┐
│  1. Run `npm run plan-score`                                │
│     → Outputs papers needing scores + scoring prompt        │
│                                                             │
│  2. Cron agent scores each paper using Sonnet               │
│     → Uses the embedded prompt                              │
│     → Collects {"score": N, "reasoning": "..."} per paper   │
│                                                             │
│  3. Write scores to JSON file                               │
│                                                             │
│  4. Run `npm run record-scores -- /path/to/scores.json`     │
│     → Persists scores to database                           │
└─────────────────────────────────────────────────────────────┘

08:30 CET — Daily Digest
┌─────────────────────────────────────────────────────────────┐
│  Selection query now uses LLM scores:                       │
│  • Papers with score <= 2 are filtered out (noise)          │
│  • Papers with score >= 3 are ranked by LLM score           │
│  • Papers without scores fall back to keyword ranking       │
└─────────────────────────────────────────────────────────────┘
```

## CLI Commands

### Generate Scoring Plan

```bash
npm run plan-score
```

Output:
```json
{
  "kind": "scorePlan",
  "papersToScore": [
    {
      "arxivId": "2602.06038",
      "title": "CommCP: A Multi-Agent LLM Framework",
      "abstract": "We present CommCP...",
      "keywordScore": 5,
      "tracks": ["Agent Evaluation & Reliability"]
    }
  ],
  "alreadyScored": 12,
  "prompt": "You are evaluating arXiv papers..."
}
```

### Record Scores

```bash
npm run record-scores -- /path/to/scores.json
```

Input file format:
```json
{
  "scores": [
    {
      "arxivId": "2602.06038",
      "relevanceScore": 5,
      "reasoning": "Directly about multi-agent LLM coordination",
      "model": "sonnet"
    }
  ]
}
```

## How the Cron Agent Uses the Plan

The cron agent receives the `plan-score` output and:

1. **Reads the prompt** — Uses the embedded system prompt for scoring
2. **For each paper** — Sends title + abstract to Sonnet
3. **Collects responses** — Parses JSON: `{"score": N, "reasoning": "..."}`
4. **Writes scores** — Creates a JSON file and calls `record-scores`

Example cron agent flow:
```
1. Run plan-score, capture output
2. For paper in papersToScore:
   - prompt: {plan.prompt}
   - user: "Title: {paper.title}\n\nAbstract: {paper.abstract}"
   - parse response as JSON
3. Write scores to /tmp/scores-YYYY-MM-DD.json
4. Run record-scores with that file
```

## How Scores Affect Selection

### Priority Order

1. **Papers with llmScore >= 3** — Ranked by llmScore DESC, then keyword score DESC
2. **Papers without llmScore** — Ranked by keyword score DESC (fallback)
3. **Papers with llmScore <= 2** — **Excluded** (noise filter)

### Noise Filtering

Papers scored 1 or 2 are filtered out completely. This catches:
- Keyword coincidences (e.g., "agent" in a different context)
- Tangentially related papers that would waste reading time
- Papers from related but different fields

### Fallback Behavior

Papers without LLM scores still appear in the digest, ranked by keyword score. This ensures:
- New papers aren't hidden if scoring hasn't run yet
- The system works even if scoring cron fails
- Backwards compatibility with existing data

## Database Schema

```sql
CREATE TABLE llm_scores (
  arxiv_id TEXT PRIMARY KEY,
  relevance_score INTEGER NOT NULL CHECK (relevance_score BETWEEN 1 AND 5),
  reasoning TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT 'sonnet',
  scored_at TEXT NOT NULL,
  FOREIGN KEY (arxiv_id) REFERENCES papers(arxiv_id) ON DELETE CASCADE
);
CREATE INDEX idx_llm_scores_score ON llm_scores(relevance_score);
```

## Digest Display

### Signal Message Format

```
Daily digest — Agents / Planning

• CommCP: A Multi-Agent LLM Framework
  http://arxiv.org/abs/2602.06038
  relevance: 5/5 • matched: agent, tool use
  We present CommCP, a framework for coordinating...
```

### Markdown Format

```markdown
## Agents / Planning

- **CommCP: A Multi-Agent LLM Framework**
  - http://arxiv.org/abs/2602.06038
  - score: 5 • relevance: 5/5 • matched: agent, tool use
  - We present CommCP, a framework for coordinating...
```

The relevance score only appears if the paper has been LLM-scored.
