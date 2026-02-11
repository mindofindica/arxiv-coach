-- Migration 006: Feedback Tracking Schema
-- Adds user interaction tracking, explicit feedback, and reading list management
-- Author: Indica
-- Date: 2026-02-11

-- ============================================================================
-- USER INTERACTIONS TABLE
-- Tracks every interaction with papers and digests for pattern analysis
-- ============================================================================

CREATE TABLE user_interactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    -- Interaction type
    interaction_type TEXT NOT NULL CHECK (interaction_type IN (
        'digest_received',
        'digest_opened',
        'paper_viewed',
        'paper_clicked',
        'paper_pdf_requested',
        'paper_explained',
        'command_issued',
        'gap_marked',
        'feedback_given'
    )),
    
    -- Target references
    paper_id UUID REFERENCES papers(id) ON DELETE CASCADE,
    digest_id UUID,  -- Future: reference digests table when created
    track_name TEXT,
    
    -- Action details
    command TEXT,  -- e.g., '/skip', '/read', '/explain'
    signal_strength INTEGER CHECK (signal_strength BETWEEN -10 AND 10),
    -- -10 = strong negative (skip, hate)
    --   0 = neutral (just viewing)
    -- +10 = strong positive (love, deep read)
    
    -- Context metadata
    position_in_digest INTEGER,  -- Was this paper #1, #2, #3?
    time_since_digest_sent INTERVAL,  -- Latency from send to interaction
    session_id UUID,  -- Group related interactions
    
    -- Flexible metadata storage
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Indexes
CREATE INDEX idx_interactions_paper ON user_interactions(paper_id);
CREATE INDEX idx_interactions_type ON user_interactions(interaction_type);
CREATE INDEX idx_interactions_created ON user_interactions(created_at DESC);
CREATE INDEX idx_interactions_signal ON user_interactions(signal_strength);
CREATE INDEX idx_interactions_track ON user_interactions(track_name);
CREATE INDEX idx_interactions_session ON user_interactions(session_id);

-- ============================================================================
-- PAPER FEEDBACK TABLE
-- Explicit user feedback on individual papers
-- ============================================================================

CREATE TABLE paper_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
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
    reason TEXT,  -- Free-form explanation
    tags TEXT[],  -- Auto-extracted or manual tags
    
    -- Track context
    expected_track TEXT,  -- Which track was this paper from?
    actual_interest_level INTEGER CHECK (actual_interest_level BETWEEN 0 AND 10),
    
    -- Prevent duplicate feedback of same type
    UNIQUE(paper_id, feedback_type)
);

-- Indexes
CREATE INDEX idx_feedback_paper ON paper_feedback(paper_id);
CREATE INDEX idx_feedback_type ON paper_feedback(feedback_type);
CREATE INDEX idx_feedback_track ON paper_feedback(expected_track);
CREATE INDEX idx_feedback_created ON paper_feedback(created_at DESC);
CREATE INDEX idx_feedback_tags ON paper_feedback USING gin(tags);

-- Auto-update timestamp
CREATE OR REPLACE FUNCTION update_feedback_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_feedback_timestamp
    BEFORE UPDATE ON paper_feedback
    FOR EACH ROW
    EXECUTE FUNCTION update_feedback_timestamp();

-- ============================================================================
-- TRACK PERFORMANCE TABLE
-- Aggregate metrics per track over time
-- ============================================================================

CREATE TABLE track_performance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    track_name TEXT NOT NULL,
    
    -- Time window
    week_start_date DATE NOT NULL,
    week_end_date DATE NOT NULL,
    
    -- Paper metrics
    papers_sent INTEGER DEFAULT 0 CHECK (papers_sent >= 0),
    papers_viewed INTEGER DEFAULT 0 CHECK (papers_viewed >= 0),
    papers_read INTEGER DEFAULT 0 CHECK (papers_read >= 0),
    papers_skipped INTEGER DEFAULT 0 CHECK (papers_skipped >= 0),
    papers_saved INTEGER DEFAULT 0 CHECK (papers_saved >= 0),
    papers_loved INTEGER DEFAULT 0 CHECK (papers_loved >= 0),
    
    -- Derived metrics
    avg_signal_strength FLOAT,
    engagement_rate FLOAT CHECK (engagement_rate >= 0 AND engagement_rate <= 1),
    quality_score FLOAT CHECK (quality_score >= 0 AND quality_score <= 1),
    
    -- Recommendations
    recommendation TEXT CHECK (recommendation IN (
        'increase_frequency',
        'maintain',
        'decrease_frequency',
        'needs_tuning',
        'consider_removing'
    )),
    recommendation_reason TEXT,
    
    -- Ensure one record per track per week
    UNIQUE(track_name, week_start_date)
);

-- Indexes
CREATE INDEX idx_track_perf_name ON track_performance(track_name);
CREATE INDEX idx_track_perf_date ON track_performance(week_start_date DESC);
CREATE INDEX idx_track_perf_quality ON track_performance(quality_score DESC);
CREATE INDEX idx_track_perf_engagement ON track_performance(engagement_rate DESC);

-- ============================================================================
-- READING LIST TABLE
-- Papers saved for later reading
-- ============================================================================

CREATE TABLE reading_list (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    paper_id UUID NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    
    status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN (
        'unread',
        'in_progress',
        'read',
        'archived'
    )),
    
    priority INTEGER DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
    
    -- User notes
    notes TEXT,
    saved_reason TEXT,  -- Why did user save this?
    
    -- Status timestamps
    read_at TIMESTAMP WITH TIME ZONE,
    archived_at TIMESTAMP WITH TIME ZONE,
    
    -- Ensure one entry per paper
    UNIQUE(paper_id)
);

-- Indexes
CREATE INDEX idx_reading_list_status ON reading_list(status);
CREATE INDEX idx_reading_list_priority ON reading_list(priority DESC);
CREATE INDEX idx_reading_list_created ON reading_list(created_at DESC);

-- Auto-update timestamp
CREATE TRIGGER trg_update_reading_list_timestamp
    BEFORE UPDATE ON reading_list
    FOR EACH ROW
    EXECUTE FUNCTION update_feedback_timestamp();

-- ============================================================================
-- VIEWS FOR ANALYTICS
-- ============================================================================

-- High-value papers (lots of positive engagement)
CREATE VIEW v_high_value_papers AS
SELECT 
    p.id,
    p.arxiv_id,
    p.title,
    p.published_date,
    COUNT(DISTINCT ui.id) FILTER (WHERE ui.signal_strength > 5) as positive_interactions,
    COUNT(DISTINCT pf.id) FILTER (WHERE pf.feedback_type IN ('read', 'love', 'save')) as positive_feedback,
    MAX(ui.signal_strength) as max_signal,
    BOOL_OR(rl.id IS NOT NULL) as in_reading_list
FROM papers p
LEFT JOIN user_interactions ui ON p.id = ui.paper_id
LEFT JOIN paper_feedback pf ON p.id = pf.paper_id
LEFT JOIN reading_list rl ON p.id = rl.paper_id
WHERE p.created_at > NOW() - INTERVAL '90 days'
GROUP BY p.id
HAVING COUNT(DISTINCT ui.id) FILTER (WHERE ui.signal_strength > 5) >= 2
ORDER BY positive_interactions DESC, max_signal DESC;

-- Low-engagement papers (sent but ignored)
CREATE VIEW v_low_engagement_papers AS
SELECT 
    p.id,
    p.arxiv_id,
    p.title,
    p.track_matches,
    COUNT(DISTINCT ui.id) as total_interactions,
    MAX(ui.created_at) as last_interaction
FROM papers p
LEFT JOIN user_interactions ui ON p.id = ui.paper_id
WHERE p.created_at > NOW() - INTERVAL '30 days'
    AND p.sent_in_digest = true
GROUP BY p.id
HAVING COUNT(DISTINCT ui.id) = 0
ORDER BY p.created_at DESC;

-- Recent engagement summary (last 7 days)
CREATE VIEW v_recent_engagement AS
SELECT 
    DATE_TRUNC('day', ui.created_at) as interaction_date,
    COUNT(DISTINCT ui.paper_id) as unique_papers,
    COUNT(*) as total_interactions,
    AVG(ui.signal_strength) as avg_signal,
    COUNT(*) FILTER (WHERE ui.signal_strength > 0) as positive_count,
    COUNT(*) FILTER (WHERE ui.signal_strength < 0) as negative_count
FROM user_interactions ui
WHERE ui.created_at > NOW() - INTERVAL '7 days'
GROUP BY DATE_TRUNC('day', ui.created_at)
ORDER BY interaction_date DESC;

-- Track engagement matrix
CREATE VIEW v_track_engagement AS
SELECT 
    track_name,
    COUNT(DISTINCT paper_id) as papers_sent,
    COUNT(DISTINCT paper_id) FILTER (
        WHERE EXISTS (
            SELECT 1 FROM user_interactions ui 
            WHERE ui.paper_id = papers.id 
            AND ui.signal_strength > 0
        )
    ) as papers_engaged,
    ROUND(
        COUNT(DISTINCT paper_id) FILTER (
            WHERE EXISTS (
                SELECT 1 FROM user_interactions ui 
                WHERE ui.paper_id = papers.id 
                AND ui.signal_strength > 0
            )
        )::NUMERIC / NULLIF(COUNT(DISTINCT id), 0) * 100,
        1
    ) as engagement_rate_pct
FROM (
    SELECT 
        p.id,
        unnest(p.track_matches) as track_name
    FROM papers p
    WHERE p.created_at > NOW() - INTERVAL '30 days'
) papers
GROUP BY track_name
ORDER BY engagement_rate_pct DESC;

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Calculate track performance metrics for a given week
CREATE OR REPLACE FUNCTION calculate_track_performance(
    p_track_name TEXT,
    p_week_start DATE
) RETURNS track_performance AS $$
DECLARE
    v_result track_performance;
    v_papers_sent INTEGER;
    v_papers_viewed INTEGER;
    v_papers_read INTEGER;
    v_avg_signal FLOAT;
    v_engagement_rate FLOAT;
    v_quality_score FLOAT;
BEGIN
    -- Count papers sent in this track during week
    SELECT COUNT(DISTINCT p.id)
    INTO v_papers_sent
    FROM papers p
    WHERE p_track_name = ANY(p.track_matches)
        AND DATE(p.created_at) BETWEEN p_week_start AND p_week_start + INTERVAL '6 days';
    
    -- Count papers with any interaction
    SELECT COUNT(DISTINCT ui.paper_id)
    INTO v_papers_viewed
    FROM user_interactions ui
    JOIN papers p ON ui.paper_id = p.id
    WHERE p_track_name = ANY(p.track_matches)
        AND DATE(ui.created_at) BETWEEN p_week_start AND p_week_start + INTERVAL '6 days';
    
    -- Count papers marked as 'read' or 'love'
    SELECT COUNT(DISTINCT pf.paper_id)
    INTO v_papers_read
    FROM paper_feedback pf
    JOIN papers p ON pf.paper_id = p.id
    WHERE p_track_name = ANY(p.track_matches)
        AND pf.feedback_type IN ('read', 'love')
        AND DATE(pf.created_at) BETWEEN p_week_start AND p_week_start + INTERVAL '6 days';
    
    -- Average signal strength
    SELECT AVG(ui.signal_strength)
    INTO v_avg_signal
    FROM user_interactions ui
    JOIN papers p ON ui.paper_id = p.id
    WHERE p_track_name = ANY(p.track_matches)
        AND DATE(ui.created_at) BETWEEN p_week_start AND p_week_start + INTERVAL '6 days';
    
    -- Calculate rates
    v_engagement_rate := CASE 
        WHEN v_papers_sent > 0 THEN v_papers_viewed::FLOAT / v_papers_sent
        ELSE 0
    END;
    
    v_quality_score := CASE
        WHEN v_papers_sent > 0 THEN v_papers_read::FLOAT / v_papers_sent
        ELSE 0
    END;
    
    -- Determine recommendation
    v_result.recommendation := CASE
        WHEN v_papers_sent < 5 THEN 'needs_tuning'  -- Not enough data
        WHEN v_engagement_rate < 0.25 THEN 'consider_removing'
        WHEN v_engagement_rate < 0.4 THEN 'decrease_frequency'
        WHEN v_quality_score > 0.7 THEN 'increase_frequency'
        ELSE 'maintain'
    END;
    
    -- Build result
    v_result.track_name := p_track_name;
    v_result.week_start_date := p_week_start;
    v_result.week_end_date := p_week_start + INTERVAL '6 days';
    v_result.papers_sent := v_papers_sent;
    v_result.papers_viewed := v_papers_viewed;
    v_result.papers_read := v_papers_read;
    v_result.avg_signal_strength := v_avg_signal;
    v_result.engagement_rate := v_engagement_rate;
    v_result.quality_score := v_quality_score;
    
    RETURN v_result;
END;
$$ LANGUAGE plpgsql;

-- Log interaction helper
CREATE OR REPLACE FUNCTION log_interaction(
    p_paper_id UUID,
    p_interaction_type TEXT,
    p_command TEXT DEFAULT NULL,
    p_signal_strength INTEGER DEFAULT 0,
    p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS UUID AS $$
DECLARE
    v_interaction_id UUID;
BEGIN
    INSERT INTO user_interactions (
        paper_id,
        interaction_type,
        command,
        signal_strength,
        metadata
    ) VALUES (
        p_paper_id,
        p_interaction_type,
        p_command,
        p_signal_strength,
        p_metadata
    ) RETURNING id INTO v_interaction_id;
    
    RETURN v_interaction_id;
END;
$$ LANGUAGE plpgsql;

-- Add paper to reading list
CREATE OR REPLACE FUNCTION add_to_reading_list(
    p_paper_id UUID,
    p_notes TEXT DEFAULT NULL,
    p_priority INTEGER DEFAULT 5
) RETURNS UUID AS $$
DECLARE
    v_list_id UUID;
BEGIN
    INSERT INTO reading_list (paper_id, notes, priority)
    VALUES (p_paper_id, p_notes, p_priority)
    ON CONFLICT (paper_id) DO UPDATE
        SET priority = EXCLUDED.priority,
            notes = COALESCE(EXCLUDED.notes, reading_list.notes),
            updated_at = NOW()
    RETURNING id INTO v_list_id;
    
    RETURN v_list_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- TRIGGER: Auto-log feedback as interaction
-- ============================================================================

CREATE OR REPLACE FUNCTION log_feedback_as_interaction()
RETURNS TRIGGER AS $$
DECLARE
    v_signal INTEGER;
BEGIN
    -- Map feedback type to signal strength
    v_signal := CASE NEW.feedback_type
        WHEN 'love' THEN 10
        WHEN 'read' THEN 8
        WHEN 'save' THEN 5
        WHEN 'meh' THEN -2
        WHEN 'skip' THEN -5
        WHEN 'not_relevant' THEN -8
        ELSE 0
    END;
    
    -- Log as interaction
    INSERT INTO user_interactions (
        paper_id,
        interaction_type,
        command,
        signal_strength
    ) VALUES (
        NEW.paper_id,
        'feedback_given',
        NEW.feedback_type,
        v_signal
    );
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_log_feedback_interaction
    AFTER INSERT ON paper_feedback
    FOR EACH ROW
    EXECUTE FUNCTION log_feedback_as_interaction();

-- ============================================================================
-- SAMPLE DATA (for testing)
-- ============================================================================

-- Uncomment to insert sample interactions for testing
/*
-- Simulate 2 weeks of interactions
INSERT INTO user_interactions (paper_id, interaction_type, signal_strength, command)
SELECT 
    p.id,
    (ARRAY['paper_viewed', 'paper_explained', 'command_issued'])[floor(random() * 3 + 1)],
    floor(random() * 20 - 10)::INTEGER,
    (ARRAY['/read', '/skip', '/save', NULL])[floor(random() * 4 + 1)]
FROM papers p
WHERE p.created_at > NOW() - INTERVAL '14 days'
ORDER BY RANDOM()
LIMIT 50;

-- Simulate explicit feedback
INSERT INTO paper_feedback (paper_id, feedback_type, expected_track)
SELECT 
    p.id,
    (ARRAY['read', 'skip', 'save'])[floor(random() * 3 + 1)],
    (p.track_matches)[1]
FROM papers p
WHERE p.created_at > NOW() - INTERVAL '14 days'
ORDER BY RANDOM()
LIMIT 20
ON CONFLICT DO NOTHING;
*/

-- ============================================================================
-- ROLLBACK (if needed)
-- ============================================================================

-- DROP TRIGGER trg_log_feedback_interaction ON paper_feedback;
-- DROP FUNCTION log_feedback_as_interaction();
-- DROP FUNCTION add_to_reading_list(UUID, TEXT, INTEGER);
-- DROP FUNCTION log_interaction(UUID, TEXT, TEXT, INTEGER, JSONB);
-- DROP FUNCTION calculate_track_performance(TEXT, DATE);
-- DROP VIEW v_track_engagement;
-- DROP VIEW v_recent_engagement;
-- DROP VIEW v_low_engagement_papers;
-- DROP VIEW v_high_value_papers;
-- DROP TRIGGER trg_update_reading_list_timestamp ON reading_list;
-- DROP TRIGGER trg_update_feedback_timestamp ON paper_feedback;
-- DROP TABLE reading_list;
-- DROP TABLE track_performance;
-- DROP TABLE paper_feedback;
-- DROP TABLE user_interactions;
-- DROP FUNCTION update_feedback_timestamp();
