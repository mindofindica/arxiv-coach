# On-Demand Paper Explanations

The explain feature provides on-demand explanations of papers from your arxiv-coach corpus. Ask for explanations at different levels of technical depth.

## Quick Start

```bash
# By arxiv ID
npm run explain -- "2602.06038" --level eli12

# By title search
npm run explain -- "CommCP paper" --level undergrad

# By digest reference
npm run explain -- "#1 from today"
```

## Query Formats

The explain feature auto-detects your query type:

### 1. Arxiv ID (Exact Match)

Lookup by the paper's arxiv identifier. Version suffixes are automatically stripped.

```bash
npm run explain -- "2602.06038"
npm run explain -- "2602.06038v1"   # v1 stripped, looks up 2602.06038
npm run explain -- "2501.12345v2"
```

### 2. Title Search (Fuzzy Match)

Search by keywords in the paper title. Stopwords like "the", "paper", "about" are filtered out.

```bash
npm run explain -- "CommCP"
npm run explain -- "conformal prediction"
npm run explain -- "the paper about multi-agent coordination"
npm run explain -- "LLM agents"
```

If multiple papers match, the system returns them as candidates (ambiguous result).

### 3. Digest Reference (Position-Based)

Reference papers by their position in a daily digest. Papers are ranked by match score.

```bash
npm run explain -- "#1 from today"        # Top paper from today
npm run explain -- "#2 from yesterday"    # Second paper from yesterday
npm run explain -- "#3 from 2026-02-08"   # Third paper from Feb 8
npm run explain -- "#1"                   # Defaults to today
```

## Explanation Levels

Choose the technical depth:

| Level      | Description                                      | Target Audience              |
|------------|--------------------------------------------------|------------------------------|
| `eli12`    | Simple analogies, no jargon, concrete examples   | Smart 12-year-old            |
| `undergrad`| Technical but explains concepts, some math OK    | CS/ML undergraduate          |
| `engineer` | Full technical depth, assumes ML background      | ML practitioner (default)    |

```bash
npm run explain -- "2602.06038" --level eli12
npm run explain -- "2602.06038" --level undergrad
npm run explain -- "2602.06038"                    # defaults to engineer
```

## Output Format

The script outputs a single JSON line with an `ExplainPlan`:

### Ready (Paper found, text available)

```json
{
  "kind": "explainPlan",
  "status": "ready",
  "level": "engineer",
  "paper": {
    "arxivId": "2602.06038",
    "title": "CommCP: Conformal Prediction for Multi-Agent Systems",
    "authors": ["Author One", "Author Two"],
    "abstract": "We present...",
    "absUrl": "https://arxiv.org/abs/2602.06038",
    "textPath": "/data/papers/2026/02/2602.06038/paper.txt",
    "hasFullText": true
  },
  "query": "2602.06038"
}
```

### Not Found

```json
{
  "kind": "explainPlan",
  "status": "not-found",
  "level": "engineer",
  "query": "quantum computing paper"
}
```

### Ambiguous (Multiple Matches)

```json
{
  "kind": "explainPlan",
  "status": "ambiguous",
  "level": "engineer",
  "candidates": [
    { "arxivId": "2602.00001", "title": "Multi-Agent Games", "score": 5, "tracks": ["AI Safety"] },
    { "arxivId": "2602.00002", "title": "Multi-Agent Learning", "score": 3, "tracks": ["LLM Engineering"] }
  ],
  "query": "multi-agent"
}
```

### No Text (Paper found but text unavailable)

```json
{
  "kind": "explainPlan",
  "status": "no-text",
  "level": "engineer",
  "paper": {
    "arxivId": "2602.06038",
    "title": "Paper Title",
    "authors": ["Author"],
    "abstract": "Abstract text...",
    "absUrl": "https://arxiv.org/abs/2602.06038",
    "textPath": "/data/papers/2026/02/2602.06038/paper.txt",
    "hasFullText": false
  },
  "query": "2602.06038"
}
```

## Conversational Usage (Signal)

The OpenClaw agent uses this feature conversationally. Example interactions:

**User:** "Explain the CommCP paper to me"
**Agent:** (runs lookup, finds paper, generates explanation at engineer level)

**User:** "Can you explain paper #1 from today like I'm 12?"
**Agent:** (runs explain with level=eli12, generates kid-friendly explanation)

**User:** "Tell me about 2602.06038 at undergrad level"
**Agent:** (direct arxiv ID lookup, undergrad-level explanation)

**Ambiguous result handling:**
**User:** "Explain the multi-agent paper"
**Agent:** "I found multiple papers matching 'multi-agent':
1. Multi-Agent Coordination in Games (score: 5)
2. Multi-Agent Learning Systems (score: 3)
Which one did you mean?"

## How Paper Lookup Works

The lookup engine automatically detects query type:

1. **Arxiv ID Detection:** Pattern `/^\d{4}\.\d{4,5}(v\d+)?$/`
   - Strips version suffix before querying
   - Exact match on `papers.arxiv_id`

2. **Digest Reference Detection:** Pattern `/#\d+\s*(from|today|yesterday|\d{4}-\d{2}-\d{2})/i`
   - Parses position (1-indexed) and date
   - Queries `track_matches` for papers matched on that date
   - Orders by score DESC, returns Nth paper

3. **Title Search (Default):**
   - Splits query into tokens, filters stopwords
   - Requires ALL tokens to appear in title (case-insensitive)
   - Returns sorted by `track_matches.score` DESC
   - Single match = found, multiple = ambiguous

## How Text Preparation Works

When a paper is found, the system ensures text is available:

1. **Check existing text file:** If `paper.txt` exists and is >100 bytes → ready
2. **Extract from PDF:** If PDF exists, run `pdftotext -layout` → ready
3. **Download + extract:** If `pdfUrl` available, download PDF then extract → ready
4. **Fail gracefully:** Return `status: 'no-text'` if all attempts fail

The first 50,000 characters of text are included in the response for the agent to use in generating explanations.

## Error States

| Status          | Meaning                                    | Agent Action                           |
|-----------------|-------------------------------------------|----------------------------------------|
| `ready`         | Paper found, text available               | Generate explanation                   |
| `not-found`     | No paper matches query                    | Ask user to clarify                    |
| `ambiguous`     | Multiple papers match                     | Show candidates, ask which one         |
| `no-text`       | Paper found but text unavailable          | Explain from abstract only             |

## Requirements

- `pdftotext` (from poppler-utils) for PDF text extraction
- Papers must be ingested via daily pipeline first
- Text extraction happens on-demand if not already done
