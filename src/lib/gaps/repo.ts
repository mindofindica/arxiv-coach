import crypto from 'node:crypto';
import type { Db } from '../db.js';

export interface KnowledgeGap {
  id: string;
  createdAt: string;
  concept: string;
  context: string | null;
  sourceType: string;
  sourceId: string | null;
  paperTitle: string | null;
  arxivId: string | null;
  detectionMethod: string;
  originalMessage: string | null;
  status: string;
  priority: number;
  lessonGeneratedAt: string | null;
  lessonSentAt: string | null;
  markedUnderstoodAt: string | null;
  tags: string[];
}

export interface CreateGapInput {
  concept: string;
  context?: string;
  sourceType: string;
  sourceId?: string;
  arxivId?: string;
  detectionMethod: string;
  originalMessage?: string;
  priority?: number;
  tags?: string[];
}

export interface LearningSession {
  id: string;
  createdAt: string;
  gapId: string;
  lessonType: string;
  lessonContent: string;
  lessonFormat: string;
  deliveredVia: string | null;
  deliveredAt: string;
  read: number;
  readAt: string | null;
  feedback: string | null;
  feedbackText: string | null;
  generationModel: string | null;
}

/**
 * Create a new knowledge gap entry.
 */
export function createGap(db: Db, input: CreateGapInput): KnowledgeGap {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const tags = JSON.stringify(input.tags ?? []);

  // Fetch paper title if arxivId provided
  let paperTitle: string | null = null;
  if (input.arxivId) {
    const row = db.sqlite.prepare('SELECT title FROM papers WHERE arxiv_id = ?').get(input.arxivId) as
      | { title: string }
      | undefined;
    paperTitle = row?.title ?? null;
  }

  db.sqlite
    .prepare(
      `INSERT INTO knowledge_gaps
        (id, created_at, concept, context, source_type, source_id, arxiv_id, paper_title, 
         detection_method, original_message, priority, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      now,
      input.concept,
      input.context ?? null,
      input.sourceType,
      input.sourceId ?? null,
      input.arxivId ?? null,
      paperTitle,
      input.detectionMethod,
      input.originalMessage ?? null,
      input.priority ?? 50,
      tags
    );

  return getGap(db, id)!;
}

/**
 * Get a gap by ID.
 */
export function getGap(db: Db, id: string): KnowledgeGap | null {
  const row = db.sqlite.prepare('SELECT * FROM knowledge_gaps WHERE id = ?').get(id) as RawGapRow | undefined;

  if (!row) return null;

  return mapGapRow(row);
}

/**
 * List all gaps, optionally filtered by status.
 */
export function listGaps(db: Db, options?: { status?: string; limit?: number }): KnowledgeGap[] {
  let sql = 'SELECT * FROM knowledge_gaps';
  const params: unknown[] = [];

  if (options?.status) {
    sql += ' WHERE status = ?';
    params.push(options.status);
  }

  sql += ' ORDER BY priority DESC, created_at DESC';

  if (options?.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  const rows = db.sqlite.prepare(sql).all(...params) as RawGapRow[];

  return rows.map(mapGapRow);
}

/**
 * Get gaps by status (identified or lesson_queued).
 */
export function getByStatus(db: Db, statuses: string[]): KnowledgeGap[] {
  if (statuses.length === 0) return [];

  const placeholders = statuses.map(() => '?').join(',');
  const sql = `SELECT * FROM knowledge_gaps WHERE status IN (${placeholders}) ORDER BY priority DESC, created_at DESC`;

  const rows = db.sqlite.prepare(sql).all(...statuses) as RawGapRow[];

  return rows.map(mapGapRow);
}

/**
 * Mark a gap as understood.
 */
export function markUnderstood(db: Db, id: string): void {
  const now = new Date().toISOString();
  db.sqlite
    .prepare("UPDATE knowledge_gaps SET status = 'understood', marked_understood_at = ? WHERE id = ?")
    .run(now, id);
}

/**
 * Update gap status and lesson timestamps.
 */
export function updateGapStatus(
  db: Db,
  id: string,
  status: string,
  timestamps?: {
    lessonGeneratedAt?: string;
    lessonSentAt?: string;
  }
): void {
  const updates: string[] = ['status = ?'];
  const params: unknown[] = [status];

  if (timestamps?.lessonGeneratedAt) {
    updates.push('lesson_generated_at = ?');
    params.push(timestamps.lessonGeneratedAt);
  }

  if (timestamps?.lessonSentAt) {
    updates.push('lesson_sent_at = ?');
    params.push(timestamps.lessonSentAt);
  }

  params.push(id);

  const sql = `UPDATE knowledge_gaps SET ${updates.join(', ')} WHERE id = ?`;
  db.sqlite.prepare(sql).run(...params);
}

/**
 * Create a learning session entry.
 */
export function createLearningSession(
  db: Db,
  input: {
    gapId: string;
    lessonType: string;
    lessonContent: string;
    deliveredVia?: string;
    generationModel?: string;
  }
): LearningSession {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.sqlite
    .prepare(
      `INSERT INTO learning_sessions
        (id, created_at, gap_id, lesson_type, lesson_content, delivered_via, delivered_at, generation_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, now, input.gapId, input.lessonType, input.lessonContent, input.deliveredVia ?? null, now, input.generationModel ?? null);

  return getLearningSession(db, id)!;
}

/**
 * Get a learning session by ID.
 */
export function getLearningSession(db: Db, id: string): LearningSession | null {
  const row = db.sqlite.prepare('SELECT * FROM learning_sessions WHERE id = ?').get(id) as RawSessionRow | undefined;

  if (!row) return null;

  return mapSessionRow(row);
}

// ── Internal Types & Mappers ──────────────────────────────────────────

interface RawGapRow {
  id: string;
  created_at: string;
  concept: string;
  context: string | null;
  source_type: string;
  source_id: string | null;
  paper_title: string | null;
  arxiv_id: string | null;
  detection_method: string;
  original_message: string | null;
  status: string;
  priority: number;
  lesson_generated_at: string | null;
  lesson_sent_at: string | null;
  marked_understood_at: string | null;
  tags: string;
}

interface RawSessionRow {
  id: string;
  created_at: string;
  gap_id: string;
  lesson_type: string;
  lesson_content: string;
  lesson_format: string;
  delivered_via: string | null;
  delivered_at: string;
  read: number;
  read_at: string | null;
  feedback: string | null;
  feedback_text: string | null;
  generation_model: string | null;
}

function mapGapRow(row: RawGapRow): KnowledgeGap {
  return {
    id: row.id,
    createdAt: row.created_at,
    concept: row.concept,
    context: row.context,
    sourceType: row.source_type,
    sourceId: row.source_id,
    paperTitle: row.paper_title,
    arxivId: row.arxiv_id,
    detectionMethod: row.detection_method,
    originalMessage: row.original_message,
    status: row.status,
    priority: row.priority,
    lessonGeneratedAt: row.lesson_generated_at,
    lessonSentAt: row.lesson_sent_at,
    markedUnderstoodAt: row.marked_understood_at,
    tags: JSON.parse(row.tags),
  };
}

function mapSessionRow(row: RawSessionRow): LearningSession {
  return {
    id: row.id,
    createdAt: row.created_at,
    gapId: row.gap_id,
    lessonType: row.lesson_type,
    lessonContent: row.lesson_content,
    lessonFormat: row.lesson_format,
    deliveredVia: row.delivered_via,
    deliveredAt: row.delivered_at,
    read: row.read,
    readAt: row.read_at,
    feedback: row.feedback,
    feedbackText: row.feedback_text,
    generationModel: row.generation_model,
  };
}
