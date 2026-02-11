# Feedback Tracking Architecture

**Version:** 1.0  
**Status:** Proposal  
**Author:** Indica  
**Date:** 2026-02-11

## Overview

Feedback tracking transforms arxiv-coach from a one-way broadcast system into a self-improving learning engine. By capturing explicit and implicit signals about which papers Mikey actually reads, skips, or finds valuable, the system can continuously tune relevance scoring, track weights, and content selection.

**Core Value Prop:** Make the tool smarter over time by learning from real usage patterns, not assumptions.

## Problem Statement

Current arxiv-coach workflow (V0):
1. System sends daily digests with scored papers
2. **BLACK BOX** — no visibility into what happens next
3. Did Mikey read the digest? Skip it? Find it helpful? Irrelevant?
4. System repeats with identical scoring logic, blind to results

**Critical unknowns:**
- Which papers did Mikey actually read vs scroll past?
- Are LLM-scored "top papers" actually relevant to his interests?
- Which tracks are high-signal vs noise?
- Is the digest too long? Too short? Just right?
- Are abstracts enough or does he need full PDFs?

**Consequence:** System cannot improve without feedback. We're flying blind.

## User Stories

### Story 1: Implicit Interest Signals
```
Digest includes 5 papers on "LLM inference optimization"
Mikey asks: "/explain speculative decoding" (from paper #2)

Current: System answers, forgets context
Proposed: System infers high interest in paper #2, boosts related topics
Next digest: Prioritizes inference optimization papers higher
```

### Story 2: Explicit Skip Feedback
```
Digest includes paper on "Quantum-inspired neural architectures"
Mikey replies: "/skip quantum" or reacts with 👎

Current: System keeps sending quantum papers
Proposed: System learns Mikey isn't interested in quantum ML
Next digest: Quantum papers deprioritized or filtered out
```

### Story 3: Save for Later
```
Paper on "Constitutional AI via debate" looks interesting but Mikey is busy
Mikey: "/save" or ⭐ reaction

Current: Paper gets lost in history
Proposed: System adds to "reading list" table
Weekly: "You saved 3 papers this week, want summaries?"
```

### Story 4: Track Performance Analysis
```
After 30 days, system analyzes:
- LLM Engineering track: 80% engagement (high value)
- Multimodal Models track: 20% engagement (mostly skipped)

System: "Consider removing Multimodal Models track?"
Mikey: "/unsubscribe multimodal-models"
Result: Cleaner digests, less noise
```

## Feedback Signals

### Explicit Signals (High Confidence)

#### 1. Commands
```
/read <paper-id>       → Strong positive signal (saved, wants full PDF or deep dive)
/skip <paper-id>       → Negative signal (not interested, reduce similar)
/save <paper-id>       → Moderate positive (interesting, read later)
/meh <paper-id>        → Weak negative (not terrible, just not relevant)
/love <paper-id>       → Strong positive (amazing, want more like this)
```

**Implementation:**
- Parse commands in Signal message handler
- Extract paper-id (can be position like "3" or arxiv ID)
- Store interaction with timestamp and signal strength

#### 2. Reactions (Signal Support Pending)
If Signal inline buttons / reactions become available:
```
👍 → Positive
👎 → Negative  
⭐ → Save
🔥 → Love it
💤 → Not relevant (skip similar)
```

#### 3. Direct Feedback Prompts
```
Weekly summary: "Did this week's digests help you stay current?"
[Yes, very helpful] [Somewhat] [Not really] [Too much noise]

Per-track: "LLM Engineering track - still relevant?"
[Yes] [Needs tuning] [Unsubscribe]
```

### Implicit Signals (Medium Confidence)

#### 1. Question-Based Interest
```
If Mikey asks: "/explain <concept from paper>"
→ Strong interest in that paper
→ Boost papers with similar concepts
```

#### 2. Time-on-Paper (Future - if mobile app)
```
Track how long user views each paper
>2 min → High interest
<10 sec → Low interest
```

#### 3. Follow-Up Actions
```
If Mikey asks: "/pdf <paper-id>" or "show me code from paper 3"
→ Very high interest
→ Paper moved to "deep read" category
```

#### 4. Click-Through Tracking (Privacy-Aware)
```
When digest includes arXiv links, track if clicked
Requires: unique tracking parameter or link wrapper
Privacy: Only track click yes/no, not browsing behavior
```

### Passive Signals (Low Confidence, Aggregate Only)

#### 1. Read Receipt (Digest-Level)
```
Did Mikey open the Signal digest message?
Did he scroll through it or immediately archive?
(Signal doesn't expose read receipts → proxy via reply timing)
```

#### 2. Engagement Timing
```
Digest sent at 09:00
First interaction at 09:15 → Probably read immediately
First interaction at 18:00 → Probably saved for later
No interaction for 48h → Likely skipped
```

## Data Model

### Schema Extension (builds on existing V0 schema)

```sql
-- Table: user_interactions
-- Tracks every interaction with papers and digests
CREATE TABLE user_interactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    -- What was interacted with?
    interaction_type TEXT NOT NULL CHECK (interaction_type IN (
        'digest_received',
        'digest_opened',
        'paper_viewed',
        'paper_clicked',
        'paper_pdf_requested',
        'paper_explained',
        'command_issued'
    )),
    
    -- Which paper/digest?
    paper_id UUID REFERENCES papers(id) ON DELETE CASCADE,
    digest_id UUID,  -- Future: reference digests table
    track_name TEXT,
    
    -- What action did they take?
    command TEXT,  -- e.g., '/skip', '/read', '/explain'
    signal_strength INTEGER CHECK (signal_strength BETWEEN -10 AND 10),
    -- -10 = strong negative, 0 = neutral, +10 = strong positive
    
    -- Context
    position_in_digest INTEGER,  -- Was this paper #1, #2, #3 in the digest?
    time_since_digest_sent INTERVAL,  -- How long after digest was sent?
    session_id UUID,  -- Group related interactions (e.g., reading one digest)
    
    -- Metadata
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_interactions_paper ON user_interactions(paper_id);
CREATE INDEX idx_interactions_type ON user_interactions(interaction_type);
CREATE INDEX idx_interactions_created ON user_interactions(created_at DESC);
CREATE INDEX idx_interactions_signal ON user_interactions(signal_strength);
CREATE INDEX idx_interactions_track ON user_interactions(track_name);

-- Table: paper_feedback
-- Explicit user feedback on individual papers
CREATE TABLE paper_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    paper_id UUID NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    
    -- Feedback type
    feedback_type TEXT NOT NULL CHECK (feedback_type IN (
        'read',
        'skip',
        'save',
        'love',
        'meh',
        'not_relevant'
    )),
    
    -- Optional context
    reason TEXT,  -- Free-form explanation (e.g., "/skip too theoretical")
    tags TEXT[],  -- Auto-extracted tags (e.g., ['quantum', 'too-advanced'])
    
    -- Track relevance
    expected_track TEXT,  -- Which track was this paper in?
    actual_interest_level INTEGER CHECK (actual_interest_level BETWEEN 0 AND 10),
    
    UNIQUE(paper_id, feedback_type)  -- One feedback type per paper
);

CREATE INDEX idx_feedback_paper ON paper_feedback(paper_id);
CREATE INDEX idx_feedback_type ON paper_feedback(feedback_type);
CREATE INDEX idx_feedback_track ON paper_feedback(expected_track);

-- Table: track_performance
-- Aggregate metrics per track over time
CREATE TABLE track_performance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    track_name TEXT NOT NULL,
    
    -- Time window
    week_start_date DATE NOT NULL,
    
    -- Metrics
    papers_sent INTEGER DEFAULT 0,
    papers_viewed INTEGER DEFAULT 0,
    papers_read INTEGER DEFAULT 0,
    papers_skipped INTEGER DEFAULT 0,
    papers_saved INTEGER DEFAULT 0,
    
    avg_signal_strength FLOAT,  -- Average of all interactions
    engagement_rate FLOAT,  -- papers_viewed / papers_sent
    quality_score FLOAT,  -- (papers_read + papers_saved) / papers_sent
    
    -- Derived recommendations
    recommendation TEXT CHECK (recommendation IN (
        'increase_frequency',
        'maintain',
        'decrease_frequency',
        'needs_tuning',
        'consider_removing'
    )),
    
    UNIQUE(track_name, week_start_date)
);

CREATE INDEX idx_track_perf_name ON track_performance(track_name);
CREATE INDEX idx_track_perf_date ON track_performance(week_start_date DESC);
CREATE INDEX idx_track_perf_quality ON track_performance(quality_score DESC);

-- Table: reading_list
-- Papers Mikey has saved for later
CREATE TABLE reading_list (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    paper_id UUID NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    
    status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN (
        'unread',
        'in_progress',
        'read',
        'archived'
    )),
    
    priority INTEGER DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
    
    notes TEXT,  -- User's notes about why they saved it
    
    read_at TIMESTAMP WITH TIME ZONE,
    archived_at TIMESTAMP WITH TIME ZONE,
    
    UNIQUE(paper_id)
);

CREATE INDEX idx_reading_list_status ON reading_list(status);
CREATE INDEX idx_reading_list_priority ON reading_list(priority DESC);
CREATE INDEX idx_reading_list_created ON reading_list(created_at DESC);
```

## Feedback Loop Integration

### 1. Update LLM Scoring Prompts

**Current Scoring (V0):**
```
Score papers 0-100 for relevance to: "LLM engineering & agents"
```

**Enhanced Scoring (with feedback):**
```
Score papers 0-100 for relevance to: "LLM engineering & agents"

User feedback history (last 30 days):
- HIGH INTEREST: inference optimization, speculative decoding, RLHF
- LOW INTEREST: theoretical proofs, quantum ML, robotics
- SAVED PAPERS: Constitutional AI, chain-of-thought prompting

Boost papers related to high-interest topics.
Penalize papers related to low-interest topics.
```

**Implementation:**
- Query `paper_feedback` for high-signal interactions (read, love, save)
- Extract common themes/keywords from those papers
- Inject into LLM scoring prompt as context

### 2. Adjust Track Weights Dynamically

**Current (V0):** Static track configuration
```yaml
tracks:
  - name: llm-engineering
    weight: 1.0
  - name: multimodal-models
    weight: 1.0
```

**Proposed:** Dynamic weights based on engagement
```yaml
tracks:
  - name: llm-engineering
    weight: 1.5  # Boosted because 80% engagement
  - name: multimodal-models
    weight: 0.3  # Reduced because 15% engagement
```

**Calculation:**
```
new_weight = base_weight * (engagement_rate / 0.5)
# If engagement_rate = 0.8 → weight *= 1.6
# If engagement_rate = 0.2 → weight *= 0.4
```

**Constraints:**
- Min weight: 0.1 (never fully remove unless explicitly unsubscribed)
- Max weight: 2.0 (prevent single track domination)
- Require ≥10 papers per track before adjusting (statistical significance)

### 3. Personalized Digest Composition

**Current:** Fixed number of papers per track (e.g., top 3)

**Proposed:** Adaptive composition based on engagement
```
High-engagement track (80%+): 4-5 papers
Medium-engagement track (40-80%): 2-3 papers
Low-engagement track (<40%): 0-1 papers (only exceptional scores)
```

**Result:** Digest shrinks from 15 papers to 8-10 high-quality papers

### 4. Concept Boosting from Questions

When Mikey asks `/explain <concept>` or marks a knowledge gap:
```sql
-- Find papers mentioning the concept
UPDATE papers
SET score_boost = score_boost + 10
WHERE to_tsvector('english', title || ' ' || abstract) @@ plainto_tsquery('english', '<concept>')
    AND created_at > NOW() - INTERVAL '90 days';
```

**Example:**
- Mikey asks: `/explain speculative decoding`
- System boosts all future papers mentioning "speculative decoding" by +10 points
- Papers about speculative decoding appear higher in digests for next 90 days

## CLI Proof-of-Concept

### Implementation: `src/commands/feedback.ts`

**Commands:**

```bash
# Give explicit feedback on a paper
arxiv-coach feedback read <paper-id>
arxiv-coach feedback skip <paper-id> --reason "too theoretical"
arxiv-coach feedback save <paper-id>
arxiv-coach feedback love <paper-id>

# Manage reading list
arxiv-coach reading-list add <paper-id>
arxiv-coach reading-list show [--status unread]
arxiv-coach reading-list done <paper-id>

# View track performance
arxiv-coach feedback track-stats [--last 30d]
arxiv-coach feedback track-tune llm-engineering --weight 1.5

# View engagement summary
arxiv-coach feedback summary --last 7d
# Output: "You engaged with 12/25 papers (48%). Top topics: RLHF, inference."
```

## Analytics & Insights

### Personal Dashboard (Weekly Report)

```
📊 arxiv-coach Weekly Report (Feb 4-10, 2026)

Digests received: 7
Papers viewed: 23 / 35 (66%)
Papers deeply engaged: 8 (asked questions, requested PDFs)

Top interests this week:
  🔥 Inference optimization (5 papers)
  📚 Constitutional AI (3 papers)
  💡 Chain-of-thought prompting (2 papers)

Track performance:
  ✅ LLM Engineering: 85% engagement (excellent!)
  ⚠️  Multimodal Models: 20% engagement (consider removing?)
  ✅ AI Alignment: 60% engagement (good)

Suggestions:
  - Boost "inference optimization" papers (high interest)
  - Remove "Multimodal Models" track? Reply /unsubscribe multimodal-models
  - You saved 4 papers - want weekly deep-dive session?
```

### Track Health Check

Automated weekly cron job:
```python
def analyze_track_health():
    for track in get_all_tracks():
        last_30d_metrics = get_track_metrics(track, days=30)
        
        if last_30d_metrics.engagement_rate < 0.25:
            send_alert(f"⚠️ {track.name} has low engagement (25%). Consider:")
            send_alert(f"  1. Adjust query to be more specific")
            send_alert(f"  2. Lower weight (currently {track.weight})")
            send_alert(f"  3. Remove track (/unsubscribe {track.name})")
        
        if last_30d_metrics.quality_score > 0.7:
            send_alert(f"✅ {track.name} is high-value ({last_30d_metrics.quality_score:.0%} quality)")
```

## Privacy & Data Handling

### Principles
1. **Local-only tracking:** All feedback stored in user's own Supabase, never shared
2. **Transparent:** User can view all tracked interactions via CLI
3. **Deletable:** `/feedback clear-history --before 2025-01-01` to purge old data
4. **Opt-out:** `/feedback tracking off` disables all implicit tracking (explicit commands still work)

### Data Retention
- **Interactions:** Keep 90 days, then archive (aggregate only)
- **Explicit feedback:** Keep indefinitely (user-generated)
- **Track performance:** Keep all weekly summaries (small footprint)

## Testing Strategy

### Simulation-Based Testing
```python
# Simulate user behavior patterns
def test_feedback_loop():
    # Week 1: Engage heavily with inference papers
    for paper in get_papers(topic='inference'):
        mark_feedback(paper, 'read')
    
    # Week 2: Check that inference papers scored higher
    new_scores = get_paper_scores(topic='inference')
    assert new_scores > baseline_scores
    
    # Week 3: Skip quantum papers
    for paper in get_papers(topic='quantum'):
        mark_feedback(paper, 'skip')
    
    # Week 4: Check that quantum papers deprioritized
    quantum_count_in_digest = len(get_digest_papers(topic='quantum'))
    assert quantum_count_in_digest < initial_quantum_count
```

### A/B Testing (Future)
- **Control:** No feedback loop (static weights)
- **Treatment:** Full feedback loop
- **Metric:** Engagement rate over 30 days

**Hypothesis:** Feedback loop increases engagement by ≥20%

## Migration Path

### Phase 1: Data Collection (Week 1)
- Deploy schema additions (user_interactions, paper_feedback, etc.)
- Implement `/read`, `/skip`, `/save` commands
- Start logging interactions (no action yet)
- **Ship:** Mikey can start giving feedback

### Phase 2: Analytics (Week 2)
- Build track performance calculation
- Implement weekly summary report
- Add `/feedback summary` CLI command
- **Ship:** Mikey can see engagement patterns

### Phase 3: Score Tuning (Week 3)
- Integrate feedback into LLM scoring prompts
- Implement concept boosting from questions
- Test scoring improvements on historical data
- **Ship:** Digests adapt to Mikey's interests

### Phase 4: Dynamic Weights (Week 4)
- Implement automatic track weight adjustment
- Add track health alerts
- Build adaptive digest composition
- **Ship:** System self-tunes based on real usage

## Success Metrics

### Engagement
- **Baseline (V0):** Unknown (no tracking)
- **Target (V1):** ≥60% of papers viewed/interacted with
- **Measure:** `papers_with_interaction / total_papers_sent`

### Relevance
- **Baseline:** Unknown (no feedback)
- **Target:** ≥70% of deeply-read papers rated "read" or "love"
- **Measure:** `(feedback_read + feedback_love) / total_deep_reads`

### Efficiency
- **Baseline:** 15-20 papers per digest (V0)
- **Target:** 8-12 papers per digest with ≥60% engagement (V1)
- **Measure:** Smaller digests with higher quality

### Learning Velocity
- **Track:** Time from paper publication → Mikey reads it
- **Target:** <3 days for high-relevance papers
- **Measure:** `avg(time_to_read)` for papers with `/read` feedback

## Open Questions

1. **Cold start problem:** How to bootstrap feedback loop with no data?
   - **Proposal:** Start with 2 weeks of manual feedback collection before tuning

2. **Feedback fatigue:** Will Mikey get tired of giving explicit feedback?
   - **Mitigation:** Rely more on implicit signals (questions, PDF requests)
   - Weekly batch feedback: "Did these 5 papers help? Yes/No"

3. **Overfitting to recent interests:** System might over-optimize for short-term patterns
   - **Mitigation:** Blend recent feedback (30d) with long-term trends (6mo)
   - Periodically inject "exploration" papers (10% of digest)

4. **Negative feedback loop:** If system only shows papers Mikey already likes, he misses new areas
   - **Solution:** Reserve 10-20% of digest for "discovery" papers (high arXiv scores but outside comfort zone)

## Future Extensions

### V2: Collaborative Filtering
- Compare Mikey's feedback with other arxiv-coach users (anonymized)
- "Users who liked Constitutional AI papers also liked RLHF papers"

### V3: Predictive Engagement
- Train ML model to predict which papers Mikey will read before he sees them
- Pre-fetch PDFs for predicted high-engagement papers

### V4: Conversation-Based Feedback
```
System: "I noticed you skipped 3 robotics papers this week. Should I remove that topic?"
Mikey: "Yeah, not relevant to my work"
System: [Auto-adjusts filters]
```

## Comparison to Alternatives

### vs. Static Configuration
- **Feedback Loop:** Adapts to changing interests automatically
- **Static:** Requires manual config edits when interests shift

### vs. Pure LLM Scoring
- **Feedback Loop:** LLM scoring + real usage data = double signal
- **Pure LLM:** Only knows paper content, not what Mikey actually values

### vs. Manual Curation
- **Feedback Loop:** Automated insights from usage patterns
- **Manual:** Mikey has to consciously reflect on what's working

## Summary

Feedback tracking closes the loop between content delivery and content value. By capturing how Mikey actually uses arxiv-coach, the system can:

1. **Boost relevance:** Papers Mikey cares about rise to the top
2. **Reduce noise:** Topics he skips get deprioritized
3. **Adapt to change:** As interests evolve, scoring evolves
4. **Provide insights:** "You're spending 80% of time on inference papers—this matters!"

**Core belief:** A system that learns from usage beats a static system, every time.

The best recommendation engine is one that watches what you do, not what you say you want.

---

**Next Steps:**
- Review this proposal with Mikey
- Prioritize features (MVP = commands + analytics, V2 = auto-tuning)
- Build schema migration + CLI commands
- Run 2-week feedback collection experiment
- Analyze results and tune weights
