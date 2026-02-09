# Weekly Deep Dive Feature

The weekly deep dive is a feature that selects one paper from the week's matches and generates an in-depth analysis for Mikey.

## Overview

Every week, arxiv-coach:
1. **Saturday**: Sends a shortlist of the top 3 papers from the week
2. **Sunday**: Delivers a deep dive on the selected paper

The deep dive includes:
- **TL;DR**: Quick summary
- **Key Ideas**: Main contributions
- **How It Works**: Technical approach
- **Why It Matters For You**: Connection to Mikey's interests (agents, LLM engineering)
- **Related This Week**: Cross-references to other papers from the weekly corpus

## Paper Selection

### Hybrid Selection Model

1. **Shortlist (Saturday)**
   - Query all papers matched in the past 7 days (ISO week: Monday to Sunday)
   - Rank by highest score across all tracks
   - Pick top 3 candidates
   - Send a shortlist message asking Mikey to pick one

2. **Final Selection (Sunday)**
   - Check for user pick file at `/root/.openclaw/state/arxiv-coach/weekly-pick.json`
   - If pick file exists and contains a valid arxivId from this week's candidates, use it
   - Otherwise, auto-select the highest-scored paper

### Pick File Format

```json
{
  "arxivId": "2602.06013"
}
```

## Plan Output Formats

### plan-weekly-shortlist.ts Output

```json
{
  "kind": "weeklyShortlist",
  "weekIso": "2026-W07",
  "alreadySent": false,
  "candidates": [
    {
      "rank": 1,
      "arxivId": "2602.06013",
      "title": "Paper Title",
      "score": 5,
      "tracks": ["Agents / Planning"],
      "absUrl": "https://arxiv.org/abs/2602.06013",
      "abstract": "..."
    }
  ],
  "shortlistMessage": "arxiv-coach — weekly shortlist (2026-W07)\n\n..."
}
```

### plan-weekly.ts Output

```json
{
  "kind": "weeklyPlan",
  "weekIso": "2026-W07",
  "alreadySent": false,
  "selectedPaper": {
    "arxivId": "2602.06013",
    "title": "Paper Title",
    "authors": ["Author One", "Author Two"],
    "abstract": "...",
    "absUrl": "https://arxiv.org/abs/2602.06013",
    "pdfUrl": "https://arxiv.org/pdf/2602.06013",
    "score": 5,
    "tracks": ["Agents / Planning"],
    "textPath": "/root/.openclaw/state/arxiv-coach/papers/2026/02/2602.06013/paper.txt",
    "hasFullText": true
  },
  "relatedPapers": [
    { "arxivId": "...", "title": "...", "score": 3, "tracks": ["..."] }
  ],
  "sections": ["header", "tldr", "key_ideas", "how_it_works", "why_it_matters", "related"],
  "headerMessage": "arxiv-coach — weekly deep dive (2026-W07)\n\n..."
}
```

## Cron Job Setup

The cron agent needs to:

### Saturday: Shortlist Delivery

1. Run `npm run plan-weekly-shortlist`
2. Parse the JSON output
3. If `alreadySent` is true, skip
4. If `candidates` is empty, optionally send the "quiet week" message
5. Send `shortlistMessage` to Signal

### Sunday: Deep Dive Delivery

1. Run `npm run plan-weekly`
2. Parse the JSON output
3. If `alreadySent` is true, skip
4. If `selectedPaper` is null, send the `headerMessage` (quiet week) and skip
5. Read the paper's full text from `selectedPaper.textPath`
6. Generate each section using AI (header is already provided in `headerMessage`)
7. Send each section as a separate Signal message
8. Call `npm run mark-weekly-sent <weekIso> <arxivId>` after successful delivery

### Cron Schedule Example

```
# Saturday 10:00 CET - Send shortlist
0 9 * * 6 cd /path/to/arxiv-coach && npm run plan-weekly-shortlist | openclaw-deliver

# Sunday 10:00 CET - Deliver deep dive
0 9 * * 0 cd /path/to/arxiv-coach && npm run plan-weekly | openclaw-deliver-weekly
```

## Manual Triggering

### Generate Shortlist for Current Week

```bash
npm run plan-weekly-shortlist
```

### Generate Shortlist for Specific Week

```bash
npm run plan-weekly-shortlist -- --week=2026-W07
```

### Generate Deep Dive Plan for Current Week

```bash
npm run plan-weekly
```

### Generate Deep Dive Plan for Specific Week

```bash
npm run plan-weekly -- --week=2026-W07
```

### Mark Weekly as Sent

```bash
npm run mark-weekly-sent -- 2026-W07 2602.06013 '["header","tldr","key_ideas"]'
```

## Edge Cases

### No Papers Matched This Week

- Shortlist returns empty `candidates` array
- `shortlistMessage` contains a "quiet week" message
- Plan returns `selectedPaper: null`
- `headerMessage` contains a friendly "no papers" message

### Selected Paper Has No Full Text

- The script attempts to download PDF and extract text if not already present
- If extraction fails, `hasFullText` will be `false`
- The header message will include a warning about abstract-only analysis
- The cron agent should still generate a deep dive, but note the limitation

### Week Already Sent

- Both scripts check `alreadySent` flag
- The flag is based on the `sent_weekly_digests` table
- If true, the cron agent should skip delivery
- This ensures idempotency

### Pick File Contains Invalid arxivId

- If the pick file contains an arxivId not found in this week's candidates
- The selection ignores the pick and auto-selects highest-scored paper
- This prevents issues if user picks a paper from last week

## Database Schema

The weekly feature adds a new table in schema v3:

```sql
CREATE TABLE sent_weekly_digests (
  week_iso TEXT PRIMARY KEY,  -- e.g., "2026-W07"
  kind TEXT NOT NULL,         -- always 'weekly'
  sent_at TEXT NOT NULL,      -- ISO timestamp
  arxiv_id TEXT NOT NULL,     -- the paper that was featured
  sections_json TEXT NOT NULL -- JSON array of sections sent
);
```

## ISO Week Calculation

The feature uses ISO week numbering:
- Weeks start on Monday
- Week 1 is the week containing January 4th (or the first Thursday)
- December 31st might be in week 1 of the next year
- January 1st might be in week 52/53 of the previous year

Example: December 29, 2025 (Monday) is the first day of 2026-W01.
