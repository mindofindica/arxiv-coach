-- Migration 005: Gap Detector Schema
-- Adds knowledge gap tracking and learning session management
-- Author: Indica
-- Date: 2026-02-11

-- ============================================================================
-- KNOWLEDGE GAPS TABLE
-- Tracks unfamiliar concepts Mikey encounters while reading papers
-- ============================================================================

CREATE TABLE knowledge_gaps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    -- What is the gap?
    concept TEXT NOT NULL,
    context TEXT,  -- Original sentence/paragraph where confusion occurred
    
    -- Where did it come from?
    source_type TEXT NOT NULL CHECK (source_type IN ('paper', 'digest', 'manual')),
    source_id UUID,  -- References papers.id if from a paper
    paper_title TEXT,
    arxiv_id TEXT,
    
    -- Detection metadata
    detection_method TEXT NOT NULL CHECK (detection_method IN (
        'explicit_command',
        'question_pattern',
        'highlight',
        'auto_detected'
    )),
    original_message TEXT,
    
    -- Learning state
    status TEXT NOT NULL DEFAULT 'identified' CHECK (status IN (
        'identified',
        'lesson_queued',
        'lesson_sent',
        'understood',
        'archived'
    )),
    
    priority INTEGER DEFAULT 50 CHECK (priority >= 0 AND priority <= 100),
    
    -- Lesson delivery tracking
    lesson_generated_at TIMESTAMP WITH TIME ZONE,
    lesson_sent_at TIMESTAMP WITH TIME ZONE,
    marked_understood_at TIMESTAMP WITH TIME ZONE,
    
    -- Metadata
    notes JSONB DEFAULT '{}'::jsonb,
    tags TEXT[] DEFAULT '{}'::text[]
);

-- Indexes for common queries
CREATE INDEX idx_gaps_status ON knowledge_gaps(status);
CREATE INDEX idx_gaps_priority ON knowledge_gaps(priority DESC);
CREATE INDEX idx_gaps_created ON knowledge_gaps(created_at DESC);
CREATE INDEX idx_gaps_concept ON knowledge_gaps USING gin(to_tsvector('english', concept));
CREATE INDEX idx_gaps_source ON knowledge_gaps(source_id) WHERE source_id IS NOT NULL;
CREATE INDEX idx_gaps_tags ON knowledge_gaps USING gin(tags);

-- ============================================================================
-- LEARNING SESSIONS TABLE
-- Tracks when/how Mikey engages with micro-lessons
-- ============================================================================

CREATE TABLE learning_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    gap_id UUID NOT NULL REFERENCES knowledge_gaps(id) ON DELETE CASCADE,
    
    -- Lesson content
    lesson_type TEXT NOT NULL CHECK (lesson_type IN (
        'micro',
        'deep_dive',
        'eli12',
        'undergrad',
        'engineer'
    )),
    lesson_content TEXT NOT NULL,
    lesson_format TEXT DEFAULT 'text' CHECK (lesson_format IN (
        'text',
        'code_example',
        'diagram_url',
        'mixed'
    )),
    
    -- Delivery
    delivered_via TEXT CHECK (delivered_via IN (
        'signal_digest',
        'on_demand',
        'weekly_recap',
        'cli'
    )),
    delivered_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Engagement tracking
    read BOOLEAN DEFAULT FALSE,
    read_at TIMESTAMP WITH TIME ZONE,
    
    feedback TEXT CHECK (feedback IN (
        'helpful',
        'too_simple',
        'too_complex',
        'want_more',
        'not_relevant'
    )),
    feedback_text TEXT,
    
    -- Related learning
    followup_questions TEXT[],
    related_gap_ids UUID[],
    
    -- Metadata
    generation_model TEXT,
    generation_prompt TEXT,
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Indexes
CREATE INDEX idx_sessions_gap ON learning_sessions(gap_id);
CREATE INDEX idx_sessions_delivered ON learning_sessions(delivered_at DESC);
CREATE INDEX idx_sessions_feedback ON learning_sessions(feedback) WHERE feedback IS NOT NULL;
CREATE INDEX idx_sessions_read ON learning_sessions(read);

-- ============================================================================
-- GAP RELATIONSHIPS TABLE
-- Track prerequisite chains and concept hierarchies
-- ============================================================================

CREATE TABLE gap_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    parent_gap_id UUID NOT NULL REFERENCES knowledge_gaps(id) ON DELETE CASCADE,
    child_gap_id UUID NOT NULL REFERENCES knowledge_gaps(id) ON DELETE CASCADE,
    
    relationship_type TEXT NOT NULL CHECK (relationship_type IN (
        'prerequisite',
        'related',
        'subtopic',
        'contradicts',
        'extends'
    )),
    
    strength FLOAT DEFAULT 0.5 CHECK (strength >= 0.0 AND strength <= 1.0),
    confidence FLOAT DEFAULT 0.5 CHECK (confidence >= 0.0 AND confidence <= 1.0),
    
    -- Prevent self-references
    CHECK (parent_gap_id != child_gap_id),
    
    -- Prevent duplicate relationships
    UNIQUE(parent_gap_id, child_gap_id, relationship_type)
);

-- Indexes
CREATE INDEX idx_gap_rel_parent ON gap_relationships(parent_gap_id);
CREATE INDEX idx_gap_rel_child ON gap_relationships(child_gap_id);
CREATE INDEX idx_gap_rel_type ON gap_relationships(relationship_type);

-- ============================================================================
-- VIEWS FOR COMMON QUERIES
-- ============================================================================

-- Active gaps with priority
CREATE VIEW v_active_gaps AS
SELECT 
    kg.id,
    kg.concept,
    kg.context,
    kg.priority,
    kg.created_at,
    kg.status,
    kg.tags,
    kg.paper_title,
    kg.arxiv_id,
    COUNT(ls.id) as lesson_count,
    MAX(ls.delivered_at) as last_lesson_at
FROM knowledge_gaps kg
LEFT JOIN learning_sessions ls ON kg.id = ls.gap_id
WHERE kg.status IN ('identified', 'lesson_queued', 'lesson_sent')
GROUP BY kg.id
ORDER BY kg.priority DESC, kg.created_at DESC;

-- Gap learning history with feedback
CREATE VIEW v_gap_learning_history AS
SELECT 
    kg.concept,
    kg.status,
    ls.lesson_type,
    ls.delivered_via,
    ls.delivered_at,
    ls.read,
    ls.feedback,
    ls.feedback_text
FROM knowledge_gaps kg
JOIN learning_sessions ls ON kg.id = ls.gap_id
ORDER BY ls.delivered_at DESC;

-- Prerequisite chains (recursive)
-- Shows what must be learned before a given concept
CREATE VIEW v_prerequisite_chains AS
WITH RECURSIVE prereqs AS (
    -- Base case: direct prerequisites
    SELECT 
        gr.child_gap_id as gap_id,
        gr.parent_gap_id as prerequisite_id,
        kg_parent.concept as prerequisite_concept,
        1 as depth,
        ARRAY[gr.parent_gap_id] as path
    FROM gap_relationships gr
    JOIN knowledge_gaps kg_parent ON gr.parent_gap_id = kg_parent.id
    WHERE gr.relationship_type = 'prerequisite'
    
    UNION ALL
    
    -- Recursive case: prerequisites of prerequisites
    SELECT 
        p.gap_id,
        gr.parent_gap_id as prerequisite_id,
        kg_parent.concept as prerequisite_concept,
        p.depth + 1,
        p.path || gr.parent_gap_id
    FROM prereqs p
    JOIN gap_relationships gr ON p.prerequisite_id = gr.child_gap_id
    JOIN knowledge_gaps kg_parent ON gr.parent_gap_id = kg_parent.id
    WHERE gr.relationship_type = 'prerequisite'
        AND NOT (gr.parent_gap_id = ANY(p.path))  -- Prevent cycles
        AND p.depth < 10  -- Max depth limit
)
SELECT 
    kg.concept as gap_concept,
    p.prerequisite_concept,
    p.depth,
    kg_prereq.status as prerequisite_status
FROM prereqs p
JOIN knowledge_gaps kg ON p.gap_id = kg.id
JOIN knowledge_gaps kg_prereq ON p.prerequisite_id = kg_prereq.id
ORDER BY kg.concept, p.depth;

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Calculate gap priority based on multiple factors
CREATE OR REPLACE FUNCTION calculate_gap_priority(
    p_gap_id UUID
) RETURNS INTEGER AS $$
DECLARE
    v_frequency_weight FLOAT := 0;
    v_recency_weight FLOAT := 0;
    v_difficulty_weight FLOAT := 0;
    v_prerequisite_weight FLOAT := 0;
    v_context_weight FLOAT := 0;
    v_priority INTEGER;
BEGIN
    -- Frequency: how often concept appears in recent papers (last 30 days)
    -- (Simplified: count mentions in paper titles/abstracts - would need FTS in real impl)
    SELECT LEAST(1.0, COUNT(*) * 0.2)
    INTO v_frequency_weight
    FROM papers p
    JOIN knowledge_gaps kg ON kg.id = p_gap_id
    WHERE p.created_at > NOW() - INTERVAL '30 days'
        AND (
            to_tsvector('english', p.title) @@ plainto_tsquery('english', kg.concept)
            OR to_tsvector('english', p.abstract) @@ plainto_tsquery('english', kg.concept)
        );
    
    -- Recency: days since gap marked (0-1 days = 1.0, 7+ days = 0.3)
    SELECT CASE
        WHEN AGE(NOW(), created_at) < INTERVAL '1 day' THEN 1.0
        WHEN AGE(NOW(), created_at) < INTERVAL '3 days' THEN 0.7
        WHEN AGE(NOW(), created_at) < INTERVAL '7 days' THEN 0.5
        ELSE 0.3
    END
    INTO v_recency_weight
    FROM knowledge_gaps
    WHERE id = p_gap_id;
    
    -- Difficulty: inverse complexity (simpler = higher priority)
    -- Estimate from concept length and word complexity
    SELECT CASE
        WHEN LENGTH(concept) < 20 THEN 1.0
        WHEN LENGTH(concept) < 40 THEN 0.7
        ELSE 0.4
    END
    INTO v_difficulty_weight
    FROM knowledge_gaps
    WHERE id = p_gap_id;
    
    -- Prerequisite: how many other gaps depend on this one
    SELECT LEAST(1.0, COUNT(*) * 0.2)
    INTO v_prerequisite_weight
    FROM gap_relationships
    WHERE parent_gap_id = p_gap_id
        AND relationship_type = 'prerequisite';
    
    -- Context relevance: placeholder (would check against user's track preferences)
    v_context_weight := 0.5;
    
    -- Calculate weighted priority (0-100)
    v_priority := ROUND(
        v_frequency_weight * 30 +
        v_recency_weight * 25 +
        v_difficulty_weight * 20 +
        v_prerequisite_weight * 15 +
        v_context_weight * 10
    );
    
    RETURN v_priority;
END;
$$ LANGUAGE plpgsql;

-- Auto-update priority when gap or relationships change
CREATE OR REPLACE FUNCTION update_gap_priority()
RETURNS TRIGGER AS $$
BEGIN
    -- Recalculate priority for affected gap(s)
    IF TG_TABLE_NAME = 'knowledge_gaps' THEN
        NEW.priority := calculate_gap_priority(NEW.id);
    ELSIF TG_TABLE_NAME = 'gap_relationships' THEN
        UPDATE knowledge_gaps
        SET priority = calculate_gap_priority(id)
        WHERE id IN (NEW.parent_gap_id, NEW.child_gap_id);
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers
CREATE TRIGGER trg_update_gap_priority
    BEFORE INSERT OR UPDATE ON knowledge_gaps
    FOR EACH ROW
    EXECUTE FUNCTION update_gap_priority();

CREATE TRIGGER trg_update_gap_priority_on_relationship
    AFTER INSERT OR UPDATE ON gap_relationships
    FOR EACH ROW
    EXECUTE FUNCTION update_gap_priority();

-- ============================================================================
-- SAMPLE DATA (for testing)
-- ============================================================================

-- Uncomment to insert sample gaps for testing
/*
INSERT INTO knowledge_gaps (concept, context, source_type, detection_method, priority, tags) VALUES
('speculative decoding', 'We achieve 2.3x speedup using speculative decoding with draft models.', 'paper', 'explicit_command', 75, ARRAY['llm-inference', 'optimization']),
('RLAIF', 'Constitutional AI via RLAIF improves alignment without human feedback.', 'paper', 'question_pattern', 70, ARRAY['alignment', 'rlhf']),
('mixture of experts', 'MoE architectures route tokens dynamically to specialized sub-networks.', 'digest', 'explicit_command', 65, ARRAY['llm-architecture', 'scaling']);

-- Mark relationships
INSERT INTO gap_relationships (parent_gap_id, child_gap_id, relationship_type, strength) 
SELECT 
    (SELECT id FROM knowledge_gaps WHERE concept = 'RLAIF'),
    (SELECT id FROM knowledge_gaps WHERE concept = 'Constitutional AI'),
    'prerequisite',
    0.8
WHERE EXISTS (SELECT 1 FROM knowledge_gaps WHERE concept IN ('RLAIF', 'Constitutional AI'));
*/

-- ============================================================================
-- ROLLBACK (if needed)
-- ============================================================================

-- DROP VIEW v_prerequisite_chains;
-- DROP VIEW v_gap_learning_history;
-- DROP VIEW v_active_gaps;
-- DROP TRIGGER trg_update_gap_priority_on_relationship ON gap_relationships;
-- DROP TRIGGER trg_update_gap_priority ON knowledge_gaps;
-- DROP FUNCTION update_gap_priority();
-- DROP FUNCTION calculate_gap_priority(UUID);
-- DROP TABLE gap_relationships;
-- DROP TABLE learning_sessions;
-- DROP TABLE knowledge_gaps;
