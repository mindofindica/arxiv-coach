/**
 * query.ts — Query and format knowledge gaps for the /gaps Signal command.
 *
 * Supports:
 *   /gaps                     — list active gaps (status: identified or lesson_queued)
 *   /gaps --all               — include understood gaps too
 *   /gaps --limit 10          — override result count (default 8)
 *   /gaps --status understood — only show understood gaps
 *
 * Output is Signal-ready (no markdown, emoji-heavy, concise).
 */

import type { Db } from '../db.js';
import { listGaps, type KnowledgeGap } from './repo.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GapsQueryOptions {
  /** Whether to include understood gaps (default: false) */
  includeUnderstood?: boolean;
  /** Filter by a specific status ('identified' | 'lesson_queued' | 'understood') */
  statusFilter?: string | null;
  /** Max gaps to return (default 8) */
  limit?: number;
}

export interface GapsQueryResult {
  /** Gaps matching the query */
  gaps: KnowledgeGap[];
  /** Total gaps in the DB (all statuses) */
  totalAll: number;
  /** Total active (not understood) */
  totalActive: number;
  /** Total understood */
  totalUnderstood: number;
}

// ─── DB queries ───────────────────────────────────────────────────────────────

interface CountRow {
  n: number;
}

function countByStatus(db: Db, status: string): number {
  const row = db.sqlite
    .prepare('SELECT COUNT(*) as n FROM knowledge_gaps WHERE status = ?')
    .get(status) as CountRow | undefined;
  return row?.n ?? 0;
}

function countAll(db: Db): number {
  const row = db.sqlite.prepare('SELECT COUNT(*) as n FROM knowledge_gaps').get() as CountRow | undefined;
  return row?.n ?? 0;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Query knowledge gaps from the DB.
 */
export function queryGaps(db: Db, options: GapsQueryOptions = {}): GapsQueryResult {
  const { includeUnderstood = false, statusFilter = null, limit = 8 } = options;

  const totalAll = countAll(db);
  const totalUnderstood = countByStatus(db, 'understood');
  const totalActive = totalAll - totalUnderstood;

  let gaps: KnowledgeGap[];

  if (statusFilter) {
    // Specific status requested
    gaps = listGaps(db, { status: statusFilter, limit });
  } else if (includeUnderstood) {
    // All statuses
    gaps = listGaps(db, { limit });
  } else {
    // Active only: identified + lesson_queued
    // listGaps orders by priority DESC, created_at DESC
    const identified = listGaps(db, { status: 'identified' });
    const lessonQueued = listGaps(db, { status: 'lesson_queued' });
    const combined = [...identified, ...lessonQueued]
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return b.createdAt.localeCompare(a.createdAt);
      })
      .slice(0, limit);
    gaps = combined;
  }

  return { gaps, totalAll, totalActive, totalUnderstood };
}
