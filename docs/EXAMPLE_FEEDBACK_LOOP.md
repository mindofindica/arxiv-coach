# Example: Feedback Loop in Action

This document demonstrates how user feedback transforms arxiv-coach from a static system into an adaptive learning engine.

---

## Scenario: 30 Days of Real Usage

### Week 1: Baseline (No Feedback Yet)

**Initial Configuration:**
```yaml
tracks:
  - name: llm-engineering
    query: "large language models OR transformer architecture OR prompt engineering"
    weight: 1.0
  - name: multimodal-models
    query: "vision language models OR multimodal learning"
    weight: 1.0
  - name: ai-alignment
    query: "AI safety OR constitutional AI OR RLHF"
    weight: 1.0
```

**Digest Sent (Feb 1, 2026):**
```
🔬 Daily arXiv Digest - Feb 1, 2026

📚 LLM Engineering (5 papers)
1. Speculative Decoding with Draft Models [Score: 87]
2. Efficient Attention Mechanisms Survey [Score: 82]
3. Theoretical Bounds on Transformer Expressivity [Score: 78]
4. Chain-of-Thought Prompting Improvements [Score: 75]
5. Hardware-Aware LLM Optimization [Score: 72]

📚 Multimodal Models (5 papers)
6. Vision-Language Models for Robotics [Score: 85]
7. Audio-Visual Speech Recognition [Score: 80]
8. Cross-Modal Retrieval Methods [Score: 76]
9. Multimodal Fusion Architectures [Score: 74]
10. Video Understanding with Transformers [Score: 70]

📚 AI Alignment (3 papers)
11. Constitutional AI via Debate [Score: 88]
12. RLAIF Without Human Labels [Score: 82]
13. Reward Model Interpretability [Score: 75]
```

**Mikey's Actions:**
```
/explain speculative decoding          # Paper #1 - high interest
/pdf arXiv:2402.01001                  # Paper #4 - wants to read full paper
/skip 6                                # Paper #6 - not interested in robotics
/skip 7                                # Paper #7 - audio-visual not relevant
/save 11                               # Paper #11 - constitutional AI looks good
```

**System Logs:**
```sql
INSERT INTO user_interactions (paper_id, interaction_type, signal_strength)
VALUES 
  ('uuid-paper-1', 'paper_explained', 8),        -- Explained speculative decoding
  ('uuid-paper-4', 'paper_pdf_requested', 10),   -- Requested full PDF
  ('uuid-paper-6', 'command_issued', -5),        -- Skipped
  ('uuid-paper-7', 'command_issued', -5),        -- Skipped
  ('uuid-paper-11', 'command_issued', 5);        -- Saved

INSERT INTO paper_feedback (paper_id, feedback_type, reason)
VALUES
  ('uuid-paper-6', 'skip', 'robotics not relevant'),
  ('uuid-paper-7', 'skip', 'audio-visual not my focus'),
  ('uuid-paper-11', 'save', NULL);
```

---

### Week 2: System Starts Learning

**Analysis After 7 Days:**
```sql
-- Calculate track engagement
SELECT 
    track_name,
    COUNT(*) as papers_sent,
    COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM user_interactions ui 
        WHERE ui.paper_id = papers.id AND ui.signal_strength > 0
    )) as papers_engaged
FROM (
    SELECT id, unnest(track_matches) as track_name 
    FROM papers 
    WHERE created_at > NOW() - INTERVAL '7 days'
) papers
GROUP BY track_name;
```

**Results:**
```
track_name          | papers_sent | papers_engaged | engagement_rate
--------------------|-------------|----------------|----------------
llm-engineering     | 35          | 28             | 80%
multimodal-models   | 35          | 5              | 14%
ai-alignment        | 21          | 13             | 62%
```

**System Response:**
```
⚠️  Track Alert: Multimodal Models

Low engagement detected (14% over last 7 days)
Papers sent: 35
Papers engaged: 5

Recommendation: consider_removing or decrease_frequency

Actions:
  1. Lower track weight: 1.0 → 0.3
  2. Reduce papers per digest: 5 → 1-2
  3. Only send exceptionally high scores (90+)

Reply /unsubscribe multimodal-models to remove entirely
```

**Updated Configuration:**
```yaml
tracks:
  - name: llm-engineering
    query: "large language models OR transformer architecture OR prompt engineering"
    weight: 1.5  # Boosted from 1.0 (high engagement)
  - name: multimodal-models
    query: "vision language models OR multimodal learning"
    weight: 0.3  # Reduced from 1.0 (low engagement)
  - name: ai-alignment
    query: "AI safety OR constitutional AI OR RLHF"
    weight: 1.2  # Slightly boosted (good engagement)
```

**Topic Extraction from Positive Signals:**
```python
# Papers Mikey engaged with deeply (signal > 7):
high_interest_papers = [
    "Speculative Decoding with Draft Models",
    "Chain-of-Thought Prompting Improvements",
    "Constitutional AI via Debate",
    "Efficient Attention Mechanisms Survey",
    "RLAIF Without Human Labels"
]

# Extract common themes using LLM
topics = extract_topics(high_interest_papers)
# → ["inference optimization", "RLHF", "constitutional AI", "prompting techniques"]
```

---

### Week 3: Enhanced Scoring with Feedback

**LLM Scoring Prompt (Before):**
```
Score these papers 0-100 for relevance to: "LLM engineering & agents"

Papers:
1. Fast Inference via Speculative Sampling
2. Quantum-Inspired Neural Architectures
3. Constitutional AI Extensions
...
```

**LLM Scoring Prompt (After - with feedback context):**
```
Score these papers 0-100 for relevance to: "LLM engineering & agents"

USER FEEDBACK HISTORY (last 30 days):
HIGH INTEREST topics (user engaged deeply):
  - Inference optimization (speculative decoding, efficient attention)
  - RLHF and constitutional AI
  - Prompting techniques (chain-of-thought)

LOW INTEREST topics (user skipped):
  - Robotics applications
  - Audio-visual processing
  - Multimodal fusion (general)

Boost papers matching high-interest topics by +15 points.
Penalize papers matching low-interest topics by -10 points.

Papers to score:
1. Fast Inference via Speculative Sampling
   → Contains "inference optimization" → BOOST
2. Quantum-Inspired Neural Architectures
   → No feedback signal → NEUTRAL
3. Constitutional AI Extensions
   → Contains "constitutional AI" → BOOST
...
```

**Scoring Results Comparison:**

| Paper | Base Score | Feedback Adjustment | Final Score |
|-------|------------|---------------------|-------------|
| Fast Inference via Speculative Sampling | 82 | +15 (inference boost) | **97** ⬆️ |
| Quantum Neural Architectures | 75 | 0 (no signal) | 75 |
| Constitutional AI Extensions | 80 | +15 (RLHF/AI safety boost) | **95** ⬆️ |
| Vision-Language for Robotics | 78 | -10 (robotics skip pattern) | **68** ⬇️ |
| Audio-Visual Transformers | 72 | -10 (multimodal skip) | **62** ⬇️ |

**Digest Composition (Week 3):**
```
🔬 Daily arXiv Digest - Feb 15, 2026

📚 LLM Engineering (6 papers) ← Increased from 5
1. Fast Inference via Speculative Sampling [Score: 97] ⭐ BOOSTED
2. Constitutional AI Extensions [Score: 95] ⭐ BOOSTED
3. Prompt Engineering with Reinforcement Learning [Score: 89] ⭐ BOOSTED
4. Efficient Attention Mechanisms v2 [Score: 86]
5. Memory-Efficient Training Methods [Score: 83]
6. Transformer Architecture Search [Score: 80]

📚 AI Alignment (4 papers) ← Increased from 3
7. RLHF at Scale [Score: 92]
8. Debate-Based AI Safety [Score: 88]
9. Reward Hacking Prevention [Score: 85]
10. Human Preference Learning [Score: 82]

📚 Multimodal Models (1 paper) ← Reduced from 5
11. Vision-Language Foundation Models [Score: 91] ← Only exceptional scores
```

**Key Changes:**
- Digest shrunk from 13 papers → 11 papers
- High-engagement tracks got more space
- Low-engagement track (multimodal) only shows exceptional papers
- Papers matching Mikey's interests appear at the top

---

### Week 4: Concept Boosting in Action

**Mikey Marks Knowledge Gap:**
```
Digest mentions: "We use tree-based speculation for parallel decoding"
Mikey: /gap tree-based speculation
```

**System Response:**
```sql
-- Create knowledge gap entry
INSERT INTO knowledge_gaps (concept, source_id, detection_method)
VALUES ('tree-based speculation', 'uuid-paper-15', 'explicit_command');

-- Boost future papers mentioning this concept
UPDATE papers
SET score_boost = score_boost + 10
WHERE to_tsvector('english', title || ' ' || abstract) 
    @@ plainto_tsquery('english', 'tree-based speculation')
    AND created_at > NOW();
```

**Next Day's Digest:**
```
🔬 Daily arXiv Digest - Feb 22, 2026

💡 LEARNING MOMENT
You marked "tree-based speculation" as confusing yesterday.
Here's a quick primer before today's papers:

🎯 Tree-Based Speculation
[200-word explanation...]
✓ Mark as understood: /understood tree-based-speculation

---

📚 LLM Engineering
1. Tree-Based Speculative Decoding [Score: 95 + 10 boost = 105] ⭐⭐
   ↑ This paper explains tree-based speculation in detail!
2. Parallel Generation Methods [Score: 88 + 10 boost = 98]
   ↑ Also covers tree-based approaches
...
```

**Result:** Papers related to concepts Mikey wants to learn get surfaced automatically!

---

### Day 30: Progress Report

**Weekly Summary Email:**
```
📊 arxiv-coach Monthly Report (Feb 1-28, 2026)

ENGAGEMENT OVERVIEW
Digests received: 28
Papers sent: 312
Papers engaged with: 189 (61%)
Papers deeply read: 45 (14%)

LEARNING VELOCITY
Average time from paper → read: 2.1 days
Papers saved to reading list: 12
Papers marked as "love": 8

TOP INTERESTS THIS MONTH
  🔥 Inference optimization (28 papers, 89% engagement)
  📚 Constitutional AI & RLHF (19 papers, 76% engagement)
  💡 Prompting techniques (15 papers, 68% engagement)

TRACK HEALTH
  ✅ LLM Engineering: 82% engagement (EXCELLENT)
     Weight adjusted: 1.0 → 1.5
     Papers per digest: 5 → 6
  
  ✅ AI Alignment: 65% engagement (GOOD)
     Weight adjusted: 1.0 → 1.2
     Papers per digest: 3 → 4
  
  ⚠️  Multimodal Models: 18% engagement (LOW)
     Weight adjusted: 1.0 → 0.3
     Papers per digest: 5 → 1
     Recommendation: Consider removing? Reply /unsubscribe multimodal-models

SYSTEM IMPROVEMENTS
  📈 Scoring accuracy improved by 35% (based on read patterns)
  📉 Digest size optimized: 13 → 11 papers average
  🎯 Relevance increased: 48% → 61% engagement
  💡 Knowledge gaps tracked: 7 concepts, 5 lessons delivered

YOUR READING LIST
  📚 12 papers saved
  ✅ 5 completed
  📄 7 remaining (want weekly deep-dive session?)

SUGGESTED ACTIONS
  1. Remove "Multimodal Models" track (low value)
  2. Add "LLM Inference" as dedicated track (high interest)
  3. Increase daily paper budget for LLM Engineering (demand > supply)
```

---

## Before vs After Comparison

### Digest Quality (Week 1 vs Week 4)

**Week 1 (No Feedback):**
- Papers sent: 13
- Papers engaged: 6 (46%)
- Papers deeply read: 2 (15%)
- Relevance: Mixed (lots of noise)

**Week 4 (Full Feedback Loop):**
- Papers sent: 11 (smaller but denser)
- Papers engaged: 8 (73%) ⬆️ +27%
- Papers deeply read: 4 (36%) ⬆️ +21%
- Relevance: High (tailored to interests)

### Track Composition

**Week 1:**
```
LLM Engineering: 5 papers (38%)
Multimodal: 5 papers (38%)
AI Alignment: 3 papers (23%)
```

**Week 4:**
```
LLM Engineering: 6 papers (55%) ⬆️
AI Alignment: 4 papers (36%) ⬆️
Multimodal: 1 paper (9%) ⬇️
```

### Scoring Accuracy

**Metric: Correlation between score and actual engagement**

Week 1: r = 0.42 (weak correlation)  
Week 4: r = 0.78 (strong correlation) ⬆️

**Interpretation:** By Week 4, high-scored papers are much more likely to match what Mikey actually wants to read.

---

## Key Takeaways

### 1. Feedback Loop Creates Virtuous Cycle
```
Send papers → User engages → Track patterns → Improve scoring → Better papers → Higher engagement
```

### 2. Dynamic Weights Matter
- Static configuration: All tracks equal (noise)
- Dynamic weights: High-value tracks get more space (signal)

### 3. Topic Extraction Powers Relevance
- Explicit feedback: Immediate, clear signal
- Implicit patterns: Emergent interests (e.g., "inference optimization" cluster)

### 4. Concept Boosting Accelerates Learning
- User marks confusion → System surfaces explanations + related papers
- Just-in-time learning beats random discovery

### 5. Smaller, Denser Digests Win
- Week 1: 13 papers, 46% engagement → 6 papers read
- Week 4: 11 papers, 73% engagement → 8 papers read
- **Result: 33% more papers read with 15% less content**

---

## Privacy & Transparency

All feedback data shown here is stored locally in the user's Supabase instance. The user can:

```bash
# View all tracked interactions
arxiv-coach feedback summary --last 30d

# View what the system learned
arxiv-coach feedback track-stats

# Clear old data
arxiv-coach feedback clear-history --before 2025-12-01

# Export feedback data
arxiv-coach feedback export --format json > my-feedback.json

# Disable implicit tracking (keep explicit commands only)
arxiv-coach feedback tracking off
```

---

## Next Steps for Mikey

After reviewing this proposal:

1. **MVP Scope Decision:**
   - Which feedback signals to implement first? (Explicit commands? Implicit questions?)
   - What's the minimum viable tracking for Week 1?

2. **Scoring Integration:**
   - Should feedback context inject into LLM prompts? (Yes, IMO)
   - Or hard-coded boost/penalty values? (Faster but less adaptive)

3. **User Experience:**
   - How often to show track performance reports? (Weekly? On-demand only?)
   - Automatic weight adjustments or ask first?

4. **Testing Plan:**
   - Run for 2 weeks with explicit feedback only
   - Analyze engagement trends
   - Iterate on scoring before adding auto-tuning

This feedback loop is what transforms arxiv-coach from a broadcast tool into a personalized learning engine. Let's build it! 🚀
