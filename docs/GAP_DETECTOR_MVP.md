# Gap Detector MVP

## Overview

The Gap Detector tracks concepts Mikey doesn't fully understand yet and delivers micro-lessons when relevant papers appear. This MVP enables learning-on-demand without disrupting the daily digest flow.

## Architecture

### Database Schema (v5)

Two new tables added to the existing migration system:

#### `knowledge_gaps`
Stores identified knowledge gaps with metadata:
- `id` (TEXT PRIMARY KEY) - UUID
- `created_at` (TEXT) - ISO timestamp
- `concept` (TEXT) - The term/concept (e.g., "Tree of Thoughts")
- `context` (TEXT) - Optional context where it was mentioned
- `source_type` (TEXT) - Where it came from: 'paper' | 'manual' | 'signal_command'
- `source_id` (TEXT) - Optional reference to source
- `arxiv_id` (TEXT) - Optional paper ID if from a paper
- `paper_title` (TEXT) - Auto-fetched paper title
- `detection_method` (TEXT) - How it was detected: 'signal_command' | 'question_pattern' | etc.
- `original_message` (TEXT) - Original user message/query
- `status` (TEXT) - Lifecycle status: 'identified' → 'lesson_queued' → 'lesson_sent' → 'understood'
- `priority` (INTEGER) - Priority score (0-100, default 50)
- `lesson_generated_at` (TEXT) - When lesson was generated
- `lesson_sent_at` (TEXT) - When lesson was sent
- `marked_understood_at` (TEXT) - When marked as understood
- `tags` (TEXT) - JSON array of tags

#### `learning_sessions`
Records each lesson delivery:
- `id` (TEXT PRIMARY KEY) - UUID
- `created_at` (TEXT) - ISO timestamp
- `gap_id` (TEXT) - Foreign key to knowledge_gaps
- `lesson_type` (TEXT) - 'micro' | 'deep_dive' | 'eli12' (only 'micro' for MVP)
- `lesson_content` (TEXT) - The lesson text
- `lesson_format` (TEXT) - 'text' | 'markdown' (default 'text')
- `delivered_via` (TEXT) - 'signal' | 'cli' | null
- `delivered_at` (TEXT) - Delivery timestamp
- `read` (INTEGER) - Read status (0 or 1)
- `read_at` (TEXT) - When marked as read
- `feedback` (TEXT) - User feedback ('helpful' | 'too_simple' | 'too_complex' | 'want_more')
- `feedback_text` (TEXT) - Optional free-form feedback
- `generation_model` (TEXT) - LLM model used ('sonnet' | etc.)

### Library Structure

**`src/lib/gaps/`**
- `repo.ts` - Database CRUD operations
  - `createGap()` - Create new gap entry
  - `getGap()` - Fetch by ID
  - `listGaps()` - List with optional filters
  - `getByStatus()` - Get gaps by status(es)
  - `markUnderstood()` - Mark gap as understood
  - `updateGapStatus()` - Update status and timestamps
  - `createLearningSession()` - Record lesson delivery
  - `getLearningSession()` - Fetch session by ID

- `match.ts` - Paper-to-gap matching
  - `matchGapsToPlaper()` - Check which gaps match a paper (substring on title + abstract)
  - `gapMatchesPaper()` - Boolean check for single gap

- `lesson.ts` - Lesson generation helpers
  - `buildLessonPrompt()` - Generate prompt for LLM (actual generation done by cron agent)
  - `formatLesson()` - Format LLM output for delivery

- `index.ts` - Public exports

### Scripts

**`src/scripts/record-gap.ts`**
- Usage: `npm run record-gap -- <concept> [--paper <arxivId>] [--context "..."]`
- Creates a gap entry in the database
- Fetches paper title if `--paper` provided
- Outputs: `{ kind: 'gapRecorded', id, concept, paperTitle?, arxivId?, status, priority }`
- Called by Indica when Mikey sends `/gap <term>` via Signal

**`src/scripts/list-gaps.ts`**
- Usage: `npm run list-gaps`
- Lists all gaps ordered by priority and creation date
- Outputs: `{ kind: 'gapList', gaps: [...] }`
- Called by Indica for `/gaps` Signal command

**`src/scripts/plan-gap-lessons.ts`**
- Usage: `npm run plan-gap-lessons`
- Reads active gaps (status='identified' or 'lesson_queued')
- Fetches recent papers (last 7 days)
- Matches gaps to papers via substring search
- Outputs: `{ kind: 'gapLessonPlan', gaps: [{ gapId, concept, matchedPapers: [...], prompt }] }`
- Called by cron agent after daily digest generation
- Cron agent then:
  1. Generates lessons via LLM using the provided prompts
  2. Sends lessons as separate Signal messages
  3. Calls `mark-gap-lesson-sent` for each

**`src/scripts/mark-gap-lesson-sent.ts`**
- Usage: `npm run mark-gap-lesson-sent -- <gapId> [--lesson-content "..."] [--model "sonnet"]`
- Updates gap status to 'lesson_sent'
- Sets lesson_sent_at timestamp
- Creates learning_session entry if lesson-content provided
- Outputs: `{ kind: 'gapLessonSent', gapId, concept, status, sentAt }`
- Called by cron agent after delivering each lesson

## User Flow

### Recording a Gap (Signal Command)

1. **User:** Mikey sends `/gap Tree of Thoughts` via Signal
2. **Indica (main session):** Receives message, calls:
   ```bash
   npm run record-gap -- "Tree of Thoughts"
   ```
3. **Script:** Creates DB entry, outputs JSON confirmation
4. **Indica:** Sends confirmation to Mikey via Signal:
   ```
   ✓ Gap tracked: Tree of Thoughts
   Priority: 50/100 | Status: identified
   📚 Will include micro-lesson when it appears in a relevant paper
   ```

### Listing Gaps (Signal Command)

1. **User:** Mikey sends `/gaps` via Signal
2. **Indica:** Calls:
   ```bash
   npm run list-gaps
   ```
3. **Script:** Outputs JSON list of gaps
4. **Indica:** Formats and sends via Signal:
   ```
   📚 Your Knowledge Gaps (3)

   1. Tree of Thoughts
      Priority: 50/100 | Status: identified

   2. RLHF
      Priority: 50/100 | Status: lesson_sent
      From: Alignment Paper Title (2501.12345)

   3. Vector Databases
      Priority: 50/100 | Status: understood
   ```

### Lesson Delivery (Automated)

1. **Daily digest cron runs** (generates and sends digest)
2. **After digest sent, cron calls:**
   ```bash
   npm run plan-gap-lessons
   ```
3. **Script outputs:**
   ```json
   {
     "kind": "gapLessonPlan",
     "gaps": [
       {
         "gapId": "uuid-123",
         "concept": "Tree of Thoughts",
         "matchedPapers": [
           {
             "arxivId": "2501.12345",
             "title": "Tree of Thoughts: Deliberate Problem Solving",
             "abstract": "...",
             "matchedIn": ["title", "abstract"]
           }
         ],
         "prompt": "You are helping Mikey learn..."
       }
     ]
   }
   ```
4. **Cron agent (for each gap):**
   - Sends prompt to LLM (Sonnet)
   - Gets lesson text back
   - Formats using `formatLesson()`
   - Sends as **separate Signal message** (not in digest)
   - Calls:
     ```bash
     npm run mark-gap-lesson-sent -- <gapId> --lesson-content "..." --model "sonnet"
     ```
5. **User receives:**
   - Daily digest (normal papers)
   - Separate lesson message:
     ```
     🎯 **Tree of Thoughts**

     Tree of Thoughts (ToT) is a framework that extends Chain-of-Thought reasoning...
     [3-4 paragraphs of explanation]

     📚 Seen in: Tree of Thoughts: Deliberate Problem Solving (arXiv:2501.12345)

     💡 Reply "/gaps" to see all tracked concepts
     ```

## Design Decisions

### 1. `/gap` Command Handled by Indica (Main Session)
**Decision:** Signal commands are routed through Indica's main session, not a built-in CLI router.

**Rationale:**
- Simplest for MVP - no need to build command routing infrastructure
- Indica can provide immediate feedback and context
- Allows conversational follow-up ("What about X?")
- Consistent with current `/explain` command pattern

**V2 Consideration:** Could add dedicated router if command set grows significantly.

---

### 2. Micro-Lessons Generated at Digest Time
**Decision:** Lessons are generated by Sonnet at digest delivery time, not pre-generated.

**Rationale:**
- Simpler architecture - no pre-generation pipeline needed
- Acceptable latency (~5-10 seconds per lesson)
- Lesson content is always fresh and can reference latest paper context
- Avoids stale lessons if user marks gap as understood before delivery
- Reduces storage - don't store generated-but-not-sent lessons

**V2 Consideration:** Could pre-generate if latency becomes an issue or want to queue for rate limiting.

---

### 3. Paper-to-Gap Matching via Substring
**Decision:** Use case-insensitive substring matching on title + abstract.

**Rationale:**
- Fast - no LLM calls during matching phase
- Deterministic and testable
- Some false positives are acceptable for MVP (e.g., "agent" matches "Agent Systems" and "Agents")
- False negatives less likely for explicit term matches
- Zero cost - substring search is free

**Tradeoffs:**
- **False Positives:** "memory" matches "memory-efficient training" (not really a gap about memory systems)
- **Misses Synonyms:** Won't match "retrieval" if gap is "RAG"
- **Misses Semantic Relations:** Won't match "attention mechanism" for "transformer" gap

**V2 Enhancement:** Add optional LLM-based semantic matching at scoring time for high-priority gaps or when substring matching has low confidence.

---

### 4. Lessons Delivered as Separate Messages
**Decision:** Send lessons as separate Signal messages after the digest, not embedded in digest.

**Rationale:**
- Keeps digest clean and focused on new papers
- Lessons are contextually distinct from paper recommendations
- Allows user to process digest and lessons separately
- Easier to reference and reply to individual lessons
- No digest formatting complexity

**V2 Consideration:** Could add digest footer like "📚 2 new micro-lessons ready" with links.

---

### 5. Schema Migration v5 is Additive Only
**Decision:** Only add new tables, no modifications to existing schema.

**Rationale:**
- Zero risk to existing functionality
- No data migration needed
- Rollback is trivial (just revert code, data stays)
- Existing tests remain valid
- Follows safe schema evolution practices

**Constraint:** If v6+ needs to reference gaps from existing tables, foreign keys must be nullable or use triggers.

---

## Deferred to V2

### Question Pattern Detection
**What:** Automatically detect gaps when Mikey asks questions like "What is X?" or "I don't understand Y."

**Why Defer:** Requires NLP/LLM classification, adds complexity. MVP focuses on explicit `/gap` commands.

**V2 Approach:** Add `detectGapFromMessage(message: string)` function that uses Sonnet to identify implicit knowledge gaps in conversation.

---

### Prerequisite Chains
**What:** Model concept dependencies (e.g., understanding "transformer" before "self-attention").

**Why Defer:** Requires concept graph, adds significant complexity. MVP treats gaps independently.

**V2 Approach:** Add `gap_relationships` table (already exists in POC schema) with `relationship_type='prerequisite'`. Build dependency graph, order lesson delivery by prerequisites.

---

### Semantic Matching (LLM-Based)
**What:** Use LLM to match papers to gaps semantically, not just substring.

**Why Defer:** Adds LLM cost per paper per gap. Substring matching sufficient for MVP.

**V2 Approach:** After substring pass, run LLM check on high-priority gaps or ambiguous matches: "Does this paper '{title}' discuss '{concept}'? Yes/No/Somewhat" 

---

### Feedback Loop
**What:** Adjust lesson style and priority based on user feedback.

**Why Defer:** Need to collect feedback data first. Schema supports it (`learning_sessions.feedback`).

**V2 Approach:**
- Track feedback patterns (too_simple → increase priority for future concepts)
- Adjust lesson_type preference (if always wants deep_dive, default to that)
- Auto-mark gaps as understood after N positive feedback sessions

---

### Progressive Learning Paths
**What:** Multi-step lessons that build on each other (e.g., intro → intermediate → advanced).

**Why Defer:** Requires content planning and sequencing logic. MVP delivers one-shot micro-lessons.

**V2 Approach:**
- Add `lesson_sequence` table linking sessions in order
- Support lesson_type = 'follow_up' that references previous session
- Track user progress through sequences

---

## Testing

### Unit Tests
- **`repo.test.ts`** - CRUD operations for gaps and learning sessions
- **`match.test.ts`** - Substring matching logic (exact, partial, case-insensitive, no match)
- **`lesson.test.ts`** - Prompt builder and formatter

### Integration Tests
- **`plan-gap-lessons.test.ts`** - Full script flow with temp database

### Test Coverage
- All functions in `src/lib/gaps/` tested
- Edge cases: missing papers, empty gaps, old papers excluded, multiple matches
- Following existing vitest patterns (temp DBs, seed helpers)

**Run tests:**
```bash
npm run test
npm run typecheck
```

## Migration Safety

### Zero-Risk Deployment
1. **Additive schema only** - No changes to existing tables
2. **Independent feature** - Doesn't touch daily/weekly/scoring flows
3. **Gradual rollout:**
   - Deploy code to production
   - Run migration (creates empty tables)
   - Test `/gap` command manually
   - Enable cron job for lesson delivery

### Rollback Plan
If issues arise:
1. Disable cron job (stops automated lessons)
2. Revert code (tables remain but unused)
3. Data preserved, can re-enable later

No data loss, no impact on existing features.

---

## Future Enhancements

### Near-Term (Post-MVP)
- [ ] Mark gap as understood via Signal reply (`/understood <concept>`)
- [ ] Adjust gap priority manually (`/gap priority <concept> 80`)
- [ ] Support multiple lesson types (currently only 'micro')
- [ ] Weekly gap summary ("You learned 3 new concepts this week")

### Mid-Term
- [ ] Question pattern detection
- [ ] Semantic matching for high-priority gaps
- [ ] Feedback-driven adjustments
- [ ] Gap relationship modeling (prerequisites)

### Long-Term
- [ ] Progressive learning sequences
- [ ] Spaced repetition reminders
- [ ] Visual concept maps
- [ ] Integration with personal knowledge base

---

## Conclusion

This MVP delivers a lightweight, safe knowledge gap tracking system that integrates seamlessly with the existing arxiv-coach digest flow. By focusing on explicit user commands and deterministic substring matching, we avoid complexity while providing immediate value. The schema and architecture support future enhancements without breaking changes.

**Status:** ✅ Ready for review and merge
