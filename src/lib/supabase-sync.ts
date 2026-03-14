/**
 * supabase-sync.ts
 *
 * Keeps the PaperBrief Supabase `papers` table in sync with newly ingested
 * arxiv-coach papers. Called from repo.upsertPaper() after each SQLite write.
 *
 * Results are verified — failures are logged to SYNC_ERROR_LOG_PATH as JSONL.
 *
 * Env vars (optional — sync is skipped silently if missing):
 *   SUPABASE_URL           e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY   service role key (write access)
 *   SYNC_ERROR_LOG_PATH    path for the JSONL failure log
 *                          (default: <storage_root>/supabase-sync-errors.jsonl)
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ArxivEntry } from './arxiv.js';

export interface SyncResult {
  ok: boolean;
  arxivId: string;
  skipped?: boolean;   // true when no key configured — not a failure
  status?: number;     // HTTP status from Supabase
  error?: string;      // error message on failure
}

export interface SyncErrorLogEntry {
  timestamp: string;
  arxivId: string;
  status?: number;
  error: string;
}

const DEFAULT_SUPABASE_URL = 'https://otekgfkmkrpwidqjslmo.supabase.co';

function getConfig() {
  return {
    url: process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_KEY ?? '',
    logPath: process.env.SYNC_ERROR_LOG_PATH ||
      path.join(
        process.env.ARXIV_COACH_STATE_DIR || '/root/.openclaw/state/arxiv-coach',
        'supabase-sync-errors.jsonl'
      ),
  };
}

export function appendSyncError(logPath: string, entry: SyncErrorLogEntry): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // log write failure is non-fatal
  }
}

export function readSyncErrors(logPath: string): SyncErrorLogEntry[] {
  try {
    const raw = fs.readFileSync(logPath, 'utf8');
    return raw
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l) as SyncErrorLogEntry);
  } catch {
    return [];
  }
}

export async function syncPaperToSupabase(
  entry: ArxivEntry,
  overrides?: { url?: string; key?: string; logPath?: string; fetch?: typeof globalThis.fetch }
): Promise<SyncResult> {
  const cfg = getConfig();
  const url      = overrides?.url     ?? cfg.url;
  const key      = overrides?.key     ?? cfg.key;
  const logPath  = overrides?.logPath ?? cfg.logPath;
  const fetcher  = overrides?.fetch   ?? globalThis.fetch;

  if (!key) {
    return { ok: true, arxivId: entry.arxivId, skipped: true };
  }

  const body = JSON.stringify([{
    arxiv_id:    entry.arxivId,
    version:     entry.version,
    title:       entry.title,
    abstract:    entry.summary,
    authors:     entry.authors,
    categories:  entry.categories,
    published_at: entry.publishedAt,
    updated_at:  entry.updatedAt,
    fetched_at:  new Date().toISOString(),
  }]);

  let res: Response;
  try {
    res = await fetcher(`${url}/rest/v1/papers`, {
      method: 'POST',
      headers: {
        'apikey':        key,
        'Authorization': `Bearer ${key}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates',
      },
      body,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    appendSyncError(logPath, { timestamp: new Date().toISOString(), arxivId: entry.arxivId, error });
    return { ok: false, arxivId: entry.arxivId, error };
  }

  // 201 Created or 200 OK are both success for upsert
  if (res.status === 200 || res.status === 201) {
    return { ok: true, arxivId: entry.arxivId, status: res.status };
  }

  let errorBody = '';
  try { errorBody = await res.text(); } catch { /* ignore */ }
  const error = `HTTP ${res.status}: ${errorBody.slice(0, 200)}`;
  appendSyncError(logPath, {
    timestamp: new Date().toISOString(),
    arxivId: entry.arxivId,
    status: res.status,
    error,
  });
  return { ok: false, arxivId: entry.arxivId, status: res.status, error };
}
