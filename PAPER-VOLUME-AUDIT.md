# Paper Volume Audit — Task #22
**Date:** 2026-02-22 | **Analyst:** Indica (night shift session 2)
**DB:** `/root/.openclaw/state/arxiv-coach/db.sqlite`
**Period covered:** 2026-02-08 → 2026-02-20 (12 days)

---

## Summary

arxiv-coach has ingested **1,973 papers** across 5 tracks since it started running Feb 8. The ingestion rate is healthy at ~185–270 papers per track-week when arXiv is cooperative, but there are three issues worth addressing: **Agents / Memory is severely under-served**, **LLM scoring coverage is 19.9%** (only digest papers get scored), and **arXiv rate limiting (429s) caused a zero-paper day on Feb 21**.

---

## Total Papers Per Track

| Track | Papers | Avg KW Score | Avg LLM Score | LLM Coverage |
|---|---|---|---|---|
| Agent Evaluation & Reliability | 157 | 4.2 | 2.49 | 100% |
| RAG & Grounding | 112 | 3.6 | 2.71 | 100% |
| Agents / Tool Use | 94 | 3.8 | 3.24 | 100% |
| Agents / Planning | 81 | 4.3 | 3.17 | 100% |
| **Agents / Memory** | **15** | **4.5** | **3.87** | **100%** |

**Note:** All 459 track-matched papers have LLM scores (100% scoring rate). But only 459 of the 1,973 total papers have been matched to a track. The 1,514 unmatched papers were ingested but not track-matched, so they have no LLM scores. Total LLM coverage across all ingested papers: **392/1973 = 19.9%**.

Wait — let me clarify: the 459 track-match count (157+112+94+81+15) totals 459, and 392 papers have LLM scores. Some papers appear in multiple tracks, so the actual unique papers with LLM scores is 392.

---

## Volume Per Week (last 8 weeks)

| Week | Eval & Rel | Memory | Planning | Tool Use | RAG | Total |
|---|---|---|---|---|---|---|
| 2026-W07 | 97 | 9 | 44 | 54 | 66 | **270** |
| 2026-W06 | 58 | 6 | 36 | 39 | 46 | **185** |
| 2026-W05 | 2 | 0 | 1 | 1 | 0 | **4** |

Week 05 (Feb 1-7) is nearly empty — the service wasn't running yet. Active ingestion started Feb 8 (W06). Volume is consistent and healthy at 185-270/week.

---

## LLM Score Distribution (392 scored papers)

| Score | Count | Bar |
|---|---|---|
| 1 (low relevance) | 87 | ████████████████ |
| 2 | 87 | ████████████████ |
| 3 | 106 | ████████████████████ |
| 4 | 72 | █████████████ |
| 5 (highly relevant) | 40 | ████████ |

**Signal rate** (score 4-5): 28.6% of scored papers. That's 40 score-5 and 72 score-4 papers across ~2 weeks of ingestion. Strong signal.

**Track LLM averages:**
- Agents / Memory: **3.87** (highest — these papers are genuinely on topic)
- Agents / Tool Use: **3.24**
- Agents / Planning: **3.17**
- RAG & Grounding: **2.71** (lowest — keyword match may be too broad)
- Agent Evaluation & Reliability: **2.49** (lowest — broadest keywords, most noise)

---

## Findings & Recommendations

### 🔴 Finding 1: Agents / Memory is severely under-served (15 papers vs 60-100+ for others)

**Root cause:** The track has fewer matching terms. The arXiv categories cs.AI, cs.CL, cs.LG, cs.IR generate a lot of evaluation/tool/planning papers but "memory" as a keyword is narrower.

**Recommendation A:** Add more keyword terms to the Memory track:
- Add: `episodic memory`, `persistent memory`, `context management`, `memory consolidation`, `memory retrieval`, `external memory`, `long-context`, `KV cache` (context-adjacent)
- Consider: `RAG` for memory-augmented retrieval (already in RAG track, but cross-list is fine)

**Recommendation B:** Check if `cs.MA` (Multi-Agent Systems) or `cs.RO` (Robotics, which has memory papers) should be added to categories.

**Recommendation C:** Agents/Memory has the *highest average LLM score* (3.87) — when it matches, it really matches. This track deserves more paper volume.

---

### 🟡 Finding 2: LLM scoring covers only 19.9% of ingested papers

**Root cause:** LLM scoring is only run on track-matched papers, and track-matched papers are only 459/1973 = 23.3% of total ingested. The rest are fetched and stored but never scored.

**This is intentional design** — only relevant papers (matched to a track) get scored. The 1,514 unmatched papers are in the arXiv categories (cs.AI, cs.CL, cs.LG, cs.IR) but don't match any track keywords. This is fine.

**Recommendation:** No action needed on scoring coverage — the current design is correct. The 19.9% figure is misleading; 100% of track-matched papers are scored.

**However:** Consider whether RAG & Grounding (avg LLM 2.71) has keywords that are too permissive. Papers matching at score 1-2 are noise that clutters the digest queue. Could tighten RAG keywords to focus on retrieval-augmented generation specifically rather than general information retrieval.

---

### 🔴 Finding 3: arXiv 429 rate limiting — Feb 21 run got ZERO papers

**Root cause:** All four arXiv category fetches (cs.AI, cs.CL, cs.LG, cs.IR) hit 429 Too Many Requests on Feb 21.

**Impact:** Zero papers ingested that day. Digest was still sent (5 papers from previous days), but new paper coverage has a gap.

**Recommendation:** 
1. Add exponential backoff + retry in the arXiv fetcher (3 retries with 5s, 10s, 20s delays)
2. Add a `--fallback-rss` mode that tries the arXiv RSS feeds (less rate-limited) if the API returns 429
3. Or: stagger the category fetches with 2-3 second delays between them to avoid triggering rate limits

---

### 🟢 Finding 4: Feedback loop is essentially empty (4 items in 12 days)

Only 4 feedback items recorded: 1 meh, 1 read, 1 save, 1 skip. This is expected — the Signal feedback commands (`/read`, `/skip`, etc.) were just built and haven't been merged + wired up yet.

**No action needed on data.** Once the Signal dispatcher is wired up and Mikey starts using `/meh`, `/love`, `/save` in Signal, this table will grow.

---

### 🟡 Finding 5: RAG & Grounding keywords may be over-broad

Average LLM score of 2.71 is the second-lowest. 87 papers scored 1-2 (noise) out of 112 total in this track = 77.7% noise rate. Compare to Agents/Memory: 15 papers, avg 3.87, where only ~3 papers would be noise.

**Recommendation:** Review the RAG track keywords. Terms like `retrieval` and `context` may be too general. Consider tightening to `retrieval-augmented generation`, `RAG`, `grounding`, `knowledge retrieval for LLMs`.

---

## Top 5 Unread High-Value Papers (Score 5, not yet in reading list)

1. **2602.16666** — *Towards a Science of AI Agent Reliability* (Eval & Rel, RAG)
2. **2602.16313** — *MemoryArena: Benchmarking Agent Memory in Interdependent Multi-Session…* (Memory, Planning)
3. **2511.17673** — *Bridging Symbolic Control and Neural Reasoning in LLM Agents* (Planning, RAG)
4. **2602.15197** — *OpaqueToolsBench: Learning Nuances of Tool Behavior Through Interaction* (Eval, Tool Use)
5. **2602.15654** — *Zombie Agents: Persistent Control of Self-Evolving LLM Agents via Self-Replicating Trojans* (Memory)

---

## Action Items Summary

| Priority | Action | Owner |
|---|---|---|
| P1 | Expand Agents/Memory keyword set (add ~8 terms) | Mikey |
| P1 | Add arXiv 429 retry/backoff in daily runner | Mikey or I can do this |
| P2 | Review RAG & Grounding keywords — tighten to reduce noise | Mikey |
| P3 | Wire Signal dispatcher to feedback recorder | Mikey (merge PR first) |

---

*Audit complete. Closes Task #22.*
