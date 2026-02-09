import type { Db } from '../db.js';

export interface LlmScore {
  arxivId: string;
  relevanceScore: number; // 1-5
  reasoning: string;
  model: string;
  scoredAt: string;
}

export interface UnscoredPaper {
  arxivId: string;
  title: string;
  abstract: string;
  keywordScore: number;
  tracks: string[];
}

/**
 * Get papers that have track matches but no LLM score yet.
 * Returns papers aggregated with their tracks and highest keyword score.
 */
export function getUnscoredPapers(db: Db): UnscoredPaper[] {
  const rows = db.sqlite.prepare(
    `SELECT
      p.arxiv_id as arxivId,
      p.title as title,
      p.abstract as abstract,
      MAX(tm.score) as keywordScore,
      GROUP_CONCAT(DISTINCT tm.track_name) as tracksConcat
    FROM papers p
    JOIN track_matches tm ON tm.arxiv_id = p.arxiv_id
    LEFT JOIN llm_scores ls ON ls.arxiv_id = p.arxiv_id
    WHERE ls.arxiv_id IS NULL
    GROUP BY p.arxiv_id
    ORDER BY keywordScore DESC, p.updated_at DESC`
  ).all() as Array<{
    arxivId: string;
    title: string;
    abstract: string;
    keywordScore: number;
    tracksConcat: string;
  }>;

  return rows.map((r) => ({
    arxivId: r.arxivId,
    title: r.title,
    abstract: r.abstract,
    keywordScore: r.keywordScore,
    tracks: r.tracksConcat ? r.tracksConcat.split(',') : [],
  }));
}

/**
 * Get the LLM score for a paper, or null if not scored.
 */
export function getScore(db: Db, arxivId: string): LlmScore | null {
  const row = db.sqlite.prepare(
    `SELECT
      arxiv_id as arxivId,
      relevance_score as relevanceScore,
      reasoning,
      model,
      scored_at as scoredAt
    FROM llm_scores
    WHERE arxiv_id = ?`
  ).get(arxivId) as {
    arxivId: string;
    relevanceScore: number;
    reasoning: string;
    model: string;
    scoredAt: string;
  } | undefined;

  if (!row) return null;

  return {
    arxivId: row.arxivId,
    relevanceScore: row.relevanceScore,
    reasoning: row.reasoning,
    model: row.model,
    scoredAt: row.scoredAt,
  };
}

/**
 * Insert or update a single LLM score.
 */
export function upsertScore(db: Db, score: LlmScore): void {
  db.sqlite.prepare(
    `INSERT INTO llm_scores (arxiv_id, relevance_score, reasoning, model, scored_at)
    VALUES (@arxivId, @relevanceScore, @reasoning, @model, @scoredAt)
    ON CONFLICT(arxiv_id) DO UPDATE SET
      relevance_score = excluded.relevance_score,
      reasoning = excluded.reasoning,
      model = excluded.model,
      scored_at = excluded.scored_at`
  ).run({
    arxivId: score.arxivId,
    relevanceScore: score.relevanceScore,
    reasoning: score.reasoning,
    model: score.model,
    scoredAt: score.scoredAt,
  });
}

/**
 * Insert or update multiple LLM scores in a transaction.
 */
export function upsertScores(db: Db, scores: LlmScore[]): void {
  const insert = db.sqlite.prepare(
    `INSERT INTO llm_scores (arxiv_id, relevance_score, reasoning, model, scored_at)
    VALUES (@arxivId, @relevanceScore, @reasoning, @model, @scoredAt)
    ON CONFLICT(arxiv_id) DO UPDATE SET
      relevance_score = excluded.relevance_score,
      reasoning = excluded.reasoning,
      model = excluded.model,
      scored_at = excluded.scored_at`
  );

  const insertMany = db.sqlite.transaction((items: LlmScore[]) => {
    for (const score of items) {
      insert.run({
        arxivId: score.arxivId,
        relevanceScore: score.relevanceScore,
        reasoning: score.reasoning,
        model: score.model,
        scoredAt: score.scoredAt,
      });
    }
  });

  insertMany(scores);
}

/**
 * Count papers that have been scored.
 */
export function countScoredPapers(db: Db): number {
  const row = db.sqlite.prepare('SELECT COUNT(*) as count FROM llm_scores').get() as { count: number };
  return row.count;
}
