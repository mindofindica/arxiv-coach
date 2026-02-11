# Gap Detector Architecture

**Version:** 1.0  
**Status:** Proposal  
**Author:** Indica  
**Date:** 2026-02-11

## Overview

The Gap Detector transforms arxiv-coach from a one-way information pipeline into an adaptive learning system. When Mikey encounters unfamiliar concepts while reading paper digests, the system tracks these "knowledge gaps" and generates targeted micro-lessons to fill them.

**Core Value Prop:** Turn confusion into curriculum. Every "I don't understand this" becomes a structured learning opportunity.

## Problem Statement

Current arxiv-coach workflow:
1. System sends daily paper digests
2. Mikey reads (or doesn't)
3. **BLACK BOX** — no visibility into comprehension, confusion, or interest
4. System repeats with no feedback loop

**Gaps:**
- Unknown terms/concepts go untracked
- No differentiation between "read and understood" vs "skimmed and confused"
- Mikey has to self-organize follow-up learning
- System can't adapt difficulty to his current knowledge level

## User Stories

### Story 1: Inline Confusion Detection
```
Mikey reads a digest about "Constitutional AI via RLAIF"
He sees: "We use a debate-based approach with recursive reward modeling"
He thinks: "What the hell is recursive reward modeling?"

Current: Mikey googles it (or doesn't)
Proposed: Mikey replies `/gap recursive reward modeling` or highlights + sends "?"
System: Creates gap entry, surfaces micro-lesson in next digest
```

### Story 2: Auto-Detection from Questions
```
Digest mentions "mixture of experts architectures"
Mikey asks: "How do MoE models route tokens?"

Current: System answers once, context is lost
Proposed: System detects implicit gap from question, tracks "MoE routing" as learning topic
Next digest: Includes 2-min primer on MoE if related papers appear
```

### Story 3: Progressive Learning Path
```
Over 2 weeks, Mikey marks gaps in:
- Chain-of-thought prompting
- Constitutional AI principles  
- RLHF vs RLAIF tradeoffs

System: Identifies "AI alignment & safety" as meta-topic
Proposes: Weekly deep-dive session on alignment fundamentals
```

## Detection Methods

### 1. Explicit Gap Marking (MVP)
**Command:** `/gap <term or concept>`

**Example:**
```
Digest: "...using speculative decoding with draft models..."
Mikey: /gap speculative decoding
```

**System Response:**
```
✓ Tracked: "speculative decoding"
📚 From: "Fast Inference for Large Language Models" (arXiv:2401.12345)
🎯 Will include micro-lesson in next relevant digest
```

**Implementation:**
- Parse `/gap` command in Signal message handler
- Extract term/concept (remainder of message)
- Store with context (paper_id, sentence, timestamp)
- Confirm tracking to user

### 2. Question Pattern Recognition (V2)
Detect implicit gaps from questions like:
- "What is X?"
- "How does X work?"
- "Why would you use X?"
- "What's the difference between X and Y?"

**NLU Approach:**
- Keyword patterns (simple regex for MVP)
- Later: Classify with Claude (is this a knowledge gap question?)
- Extract concept from question structure

### 3. Highlighted Terms (V3)
Allow Mikey to highlight confusing text in digests and reply with "?" or "/explain"

**Technical Challenge:**
- Signal doesn't preserve text selection context
- **Workaround:** Include unique IDs in digest (e.g., `[#s42]`) for each sentence
- Mikey can reply: `/gap #s42` to mark entire sentence as confusing

## Data Model

### Schema v5 Migration

```sql
-- Table: knowledge_gaps
-- Tracks unfamiliar concepts Mikey encounters
CREATE TABLE knowledge_gaps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    -- What is the gap?
    concept TEXT NOT NULL,  -- e.g., "speculative decoding", "RLAIF"
    context TEXT,           -- Original sentence/paragraph where confusion occurred
    
    -- Where did it come from?
    source_type TEXT NOT NULL,  -- 'paper' | 'digest' | 'manual'
    source_id UUID,             -- References papers.id if from a paper
    paper_title TEXT,           -- Denormalized for easy display
    arxiv_id TEXT,              -- Denormalized
    
    -- Detection metadata
    detection_method TEXT NOT NULL,  -- 'explicit_command' | 'question_pattern' | 'highlight'
    original_message TEXT,           -- User's original message that triggered gap detection
    
    -- Learning state
    status TEXT NOT NULL DEFAULT 'identified',  
    -- 'identified' -> 'lesson_queued' -> 'lesson_sent' -> 'understood' -> 'archived'
    
    priority INTEGER DEFAULT 50,  -- 0-100, higher = more important
    -- Auto-calculated from: frequency, recency, prerequisite chains
    
    -- Lesson delivery tracking
    lesson_generated_at TIMESTAMP WITH TIME ZONE,
    lesson_sent_at TIMESTAMP WITH TIME ZONE,
    marked_understood_at TIMESTAMP WITH TIME ZONE,
    
    -- Metadata
    notes JSONB DEFAULT '{}'::jsonb,  -- Flexible storage for future fields
    tags TEXT[] DEFAULT '{}'::text[]  -- e.g., ['llm-inference', 'optimization']
);

CREATE INDEX idx_gaps_status ON knowledge_gaps(status);
CREATE INDEX idx_gaps_priority ON knowledge_gaps(priority DESC);
CREATE INDEX idx_gaps_created ON knowledge_gaps(created_at DESC);
CREATE INDEX idx_gaps_concept ON knowledge_gaps USING gin(to_tsvector('english', concept));

-- Table: learning_sessions
-- Tracks when/how Mikey engages with micro-lessons
CREATE TABLE learning_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    gap_id UUID NOT NULL REFERENCES knowledge_gaps(id) ON DELETE CASCADE,
    
    -- Lesson content
    lesson_type TEXT NOT NULL,  -- 'micro' | 'deep_dive' | 'eli12' | 'undergrad' | 'engineer'
    lesson_content TEXT NOT NULL,  -- The actual explanation/lesson text
    lesson_format TEXT DEFAULT 'text',  -- 'text' | 'code_example' | 'diagram_url'
    
    -- Delivery
    delivered_via TEXT,  -- 'signal_digest' | 'on_demand' | 'weekly_recap'
    delivered_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Engagement tracking
    read BOOLEAN DEFAULT FALSE,
    read_at TIMESTAMP WITH TIME ZONE,
    
    feedback TEXT,  -- 'helpful' | 'too_simple' | 'too_complex' | 'want_more'
    feedback_text TEXT,  -- Free-form feedback from Mikey
    
    -- Related learning
    followup_questions TEXT[],  -- Questions Mikey asked after reading lesson
    related_gap_ids UUID[],     -- Other gaps addressed in same session
    
    -- Metadata
    generation_model TEXT,  -- Which Claude model generated the lesson
    generation_prompt TEXT, -- Prompt used (for debugging/iteration)
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_sessions_gap ON learning_sessions(gap_id);
CREATE INDEX idx_sessions_delivered ON learning_sessions(delivered_at DESC);
CREATE INDEX idx_sessions_feedback ON learning_sessions(feedback);

-- Table: gap_relationships
-- Track prerequisite chains and concept hierarchies
CREATE TABLE gap_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    parent_gap_id UUID NOT NULL REFERENCES knowledge_gaps(id) ON DELETE CASCADE,
    child_gap_id UUID NOT NULL REFERENCES knowledge_gaps(id) ON DELETE CASCADE,
    
    relationship_type TEXT NOT NULL,  
    -- 'prerequisite' (must learn parent before child)
    -- 'related' (similar/overlapping concepts)
    -- 'subtopic' (child is specific instance of parent)
    
    strength FLOAT DEFAULT 0.5,  -- 0.0-1.0, how strong is the relationship
    
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    UNIQUE(parent_gap_id, child_gap_id, relationship_type)
);

CREATE INDEX idx_gap_rel_parent ON gap_relationships(parent_gap_id);
CREATE INDEX idx_gap_rel_child ON gap_relationships(child_gap_id);
```

## Gap Prioritization Logic

**Priority Score (0-100):**

```
priority = (
    frequency_weight * 30 +      # How often concept appears in new papers
    recency_weight * 25 +         # How recently gap was marked
    difficulty_weight * 20 +      # Complexity (easier concepts prioritized)
    prerequisite_weight * 15 +    # Blocks understanding of other concepts
    context_relevance * 10        # Relates to Mikey's active interests
)
```

### Frequency Weight
- Count mentions of concept in papers from last 30 days
- Normalize: 1 mention = 0.2, 5+ mentions = 1.0
- **Insight:** If "speculative decoding" appears in 8 new papers, prioritize learning it

### Recency Weight
- Days since gap marked: 0-1 days = 1.0, 7+ days = 0.3
- Fresh confusion is prioritized (strike while iron is hot)

### Difficulty Weight
- **Inverse difficulty:** Simpler concepts scored higher
- Estimated from: concept length, academic jargon density, prerequisite chain depth
- Rationale: Build foundation first, then tackle complex topics

### Prerequisite Weight
- If concept is a prerequisite for N other gaps: weight = min(N/5, 1.0)
- Example: Understanding "attention mechanisms" unblocks "multi-head attention", "cross-attention", "flash attention"

### Context Relevance
- Relates to Mikey's LLM engineering track? +1.0
- Mentioned in papers he explicitly saved/liked? +0.8
- From track he rarely engages with? +0.2

## Micro-Lesson Generation

### Lesson Types

#### 1. Quick Context (Default)
**Length:** 150-250 words  
**Goal:** "Now I can keep reading"  
**Format:**
```
🎯 Gap: Speculative Decoding

📖 Quick Context:
Speculative decoding is a technique to speed up LLM inference without losing quality. 

The idea: Use a small "draft" model to generate multiple tokens quickly, then verify them in parallel with the big model. If the draft was correct, you saved time. If not, you only wasted cheap draft compute.

Think of it like: autocomplete that double-checks itself.

Why it matters: Makes models like GPT-4 2-3x faster on long generations.

📚 Seen in: "Fast Inference via Speculative Sampling" (arXiv:2401.12345)
🔗 Want deeper dive? Reply /learn speculative-decoding
```

#### 2. Deep Dive (On-Demand)
**Length:** 1000-1500 words  
**Goal:** "Now I could implement this"  
**Includes:**
- Mathematical foundations (if applicable)
- Code examples
- Tradeoffs & limitations
- Links to key papers

**Trigger:** `/learn <concept>` or weekly deep-dive cron

#### 3. ELI12 / Undergrad / Engineer (On-Demand)
User-specified depth levels from arxiv-coach V1 roadmap  
**Trigger:** `/explain <concept> eli12` or `/explain <concept> engineer`

### Generation Approach

**Prompt Template:**
```
You are creating a micro-lesson for an experienced software engineer learning about LLM engineering.

Concept: {concept}
Context: They encountered this in a paper about {paper_title}
Original sentence: "{context_sentence}"

Generate a 200-word explanation that:
1. Defines the concept clearly (no circular definitions)
2. Explains WHY it matters (practical impact)
3. Gives a concrete analogy or example
4. Mentions where it's used in real systems
5. Links to 1-2 key papers if relevant

Tone: Conversational but precise. Like explaining to a smart colleague over coffee.
```

**Model:** Claude Opus (for quality) or Sonnet (for speed/cost)  
**Caching:** Store generated lessons in `learning_sessions` to avoid regenerating

## Integration with Existing Digest Flow

### Current Digest Structure (V0)
```
🔬 LLM Engineering - Feb 11, 2026

📄 Fast Inference via Speculative Sampling
- Novel approach using draft models...
- Achieves 2.3x speedup on Llama-70B...
🔗 https://arxiv.org/abs/2401.12345

📄 Constitutional AI Improvements
- Extends RLAIF with debate-based verification...
...
```

### Enhanced Digest with Gap Lessons (Proposal)
```
🔬 LLM Engineering - Feb 11, 2026

💡 LEARNING MOMENT
You marked "speculative decoding" as confusing yesterday.
Here's a quick primer before today's papers:

🎯 Speculative Decoding
[... 200-word explanation ...]
✓ Mark as understood: /understood speculative-decoding

---

📄 Fast Inference via Speculative Sampling
- Novel approach using draft models... ← This uses speculative decoding!
...
```

**Placement Strategy:**
- If digest contains papers mentioning gap concept: lesson appears BEFORE those papers
- Otherwise: lesson appears at bottom as "Background Building"
- Max 1-2 lessons per digest (avoid overwhelming)

### On-Demand Learning
```
User: /learn speculative-decoding
System: [Generates deep-dive lesson immediately]

User: /explain MoE eli12
System: [Generates ELI12 explanation of Mixture of Experts]
```

## CLI Proof-of-Concept

### Implementation: `src/commands/gap.ts`

**Commands:**

```bash
# Mark a gap from digest reading
arxiv-coach gap mark "speculative decoding" --paper arXiv:2401.12345

# List current gaps by priority
arxiv-coach gap list --status identified --limit 10

# Generate lesson for a gap
arxiv-coach gap learn <gap-id> --type micro --send

# Mark gap as understood
arxiv-coach gap understood <gap-id>

# View learning history
arxiv-coach gap history --last 30d
```

**Interactive Mode (Future):**
```bash
arxiv-coach gap interactive

> Reading digest? Mark confusing terms with /gap <term>
> Ready for micro-lessons? Type 'next'
> Done? Type 'exit'
```

## Testing Strategy

### Unit Tests
- Gap detection from `/gap` commands
- Priority calculation with various inputs
- Lesson generation prompt formatting
- Status transitions (identified → queued → sent → understood)

### Integration Tests
- Full flow: mark gap → trigger lesson → deliver in digest → mark understood
- Prerequisite chain detection
- Multiple gaps from same paper

### User Acceptance
- Mikey marks 5 real gaps during week of testing
- Validates lesson quality (helpful/too simple/too complex)
- Confirms digest integration feels natural (not overwhelming)

## Migration Path

### Phase 1: Detection & Storage (Week 1)
- Deploy schema v5 migration
- Implement `/gap` command
- Build gap list/view CLI commands
- **Ship:** Mikey can start marking gaps, system stores them

### Phase 2: Lesson Generation (Week 2)
- Implement micro-lesson generation
- Add `/learn` command for on-demand lessons
- Test lesson quality with 10 real gaps
- **Ship:** Mikey can request lessons via CLI

### Phase 3: Digest Integration (Week 3)
- Modify digest builder to inject lessons
- Implement lesson delivery tracking
- Add `/understood` feedback mechanism
- **Ship:** Lessons appear automatically in digests

### Phase 4: Prioritization & Auto-Detection (Week 4)
- Implement priority scoring algorithm
- Add question pattern detection
- Build prerequisite relationship detection
- **Ship:** System proactively surfaces important gaps

## Success Metrics

### Engagement
- **Target:** Mikey marks ≥3 gaps per week
- **Target:** ≥70% of generated lessons marked as "helpful"

### Learning Velocity
- **Track:** Time from gap marked → lesson delivered
- **Target:** <24 hours for high-priority gaps

### Comprehension
- **Track:** Reduction in repeat confusion (same concept marked again)
- **Target:** <10% repeat rate

### System Impact
- **Track:** Papers Mikey actually reads after receiving related lesson
- **Hypothesis:** Lessons increase deep engagement with papers by 30%+

## Open Questions

1. **Lesson fatigue:** How many micro-lessons per digest before it feels overwhelming?
   - **Proposal:** Max 2 per digest, with weekly digest for "background building"

2. **Gap lifecycle:** When should gaps archive automatically?
   - **Proposal:** After 90 days with no re-mention in new papers + marked understood

3. **Prerequisite detection:** How to auto-detect concept relationships?
   - **MVP:** Manual tagging by LLM during lesson generation
   - **V2:** Build concept graph from paper abstracts

4. **Lesson personalization:** Should lessons adapt to Mikey's expertise level over time?
   - **Proposal:** Track feedback trends (too simple/too complex) and adjust prompt complexity

## Future Extensions

### V2: Spaced Repetition
- Re-surface learned concepts after 1 week, 1 month, 3 months
- Test retention with quick quiz questions
- Inspired by Anki/SuperMemo algorithms

### V3: Concept Graph Visualization
- Interactive graph of knowledge gaps + learned concepts
- Shows learning progress over time
- Identifies "bottleneck" concepts blocking multiple topics

### V4: Collaborative Learning
- Share anonymized gap data with other arxiv-coach users
- "80% of LLM engineers struggled with this concept"
- Community-sourced micro-lessons

## Comparison to Alternatives

### vs. Manual Google Search
- **Gap Detector:** Tracks context, delivers just-in-time
- **Google:** One-off, no memory of what you learned

### vs. ChatGPT/Claude Conversations
- **Gap Detector:** Builds persistent knowledge graph, spaced repetition
- **ChatGPT:** Stateless, no follow-up unless you remember to ask

### vs. Online Courses
- **Gap Detector:** Adaptive, filled with real-world context from papers you're reading
- **Courses:** Fixed curriculum, may teach things you already know or don't need yet

## Summary

The Gap Detector transforms arxiv-coach from a broadcast system into a personalized learning engine. By tracking what Mikey doesn't understand and delivering targeted micro-lessons, we create a virtuous cycle:

1. Mikey reads digest
2. Marks confusing concepts
3. System generates lesson
4. Mikey learns concept
5. Future papers on that topic become accessible
6. Mikey engages deeper with cutting-edge research

**Core belief:** The best time to learn something is right when you realize you don't know it.

---

**Next Steps:**
- Review this proposal with Mikey
- Prioritize features (MVP scope)
- Build schema migration + CLI commands
- Test with real usage for 1 week
- Iterate based on feedback
