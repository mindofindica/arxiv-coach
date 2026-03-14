/**
 * supabase-reading-list.ts
 *
 * Syncs arxiv-coach reading list actions to the PaperBrief Supabase
 * `reading_list` table so saved papers appear on paperbrief.ai.
 *
 * Failures are logged to SYNC_ERROR_LOG_PATH (JSONL) — same pattern
 * as supabase-sync.ts for paper ingestion.
 *
 * Env vars (optional — sync skipped silently if missing):
 *   SUPABASE_URL              e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY      service role key
 *   SUPABASE_PAPERBRIEF_USER  UUID of the PaperBrief user to sync to
 *   SYNC_ERROR_LOG_PATH       path for JSONL failure log
 */

import path from 'node:path';
import { appendSyncError } from './supabase-sync.js';

export type ReadingListAction = 'save' | 'read' | 'love' | 'skip';

export interface ReadingListSyncResult {
  ok: boolean;
  arxivId: string;
  action: ReadingListAction;
  skipped?: boolean;
  status?: number;
  error?: string;
}

const DEFAULT_SUPABASE_URL = 'https://otekgfkmkrpwidqjslmo.supabase.co';

function getConfig() {
  return {
    url:    process.env.SUPABASE_URL     || DEFAULT_SUPABASE_URL,
    key:    process.env.SUPABASE_SERVICE_KEY   ?? '',
    userId: process.env.SUPABASE_PAPERBRIEF_USER ?? '',
    logPath: process.env.SYNC_ERROR_LOG_PATH ||
      path.join(
        process.env.ARXIV_COACH_STATE_DIR || '/root/.openclaw/state/arxiv-coach',
        'supabase-sync-errors.jsonl',
      ),
  };
}

export interface ReadingListSyncDeps {
  url?: string;
  key?: string;
  userId?: string;
  logPath?: string;
  fetch?: typeof globalThis.fetch;
}

async function request(
  method: string,
  url: string,
  key: string,
  body?: object,
  fetcher = globalThis.fetch,
): Promise<Response> {
  return fetcher(url, {
    method,
    headers: {
      'apikey':        key,
      'Authorization': `Bearer ${key}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function isSuccess(status: number) {
  return status >= 200 && status < 300;
}

async function handleResponse(
  res: Response,
  arxivId: string,
  action: ReadingListAction,
  logPath: string,
): Promise<ReadingListSyncResult> {
  if (isSuccess(res.status)) {
    return { ok: true, arxivId, action, status: res.status };
  }
  let body = '';
  try { body = await res.text(); } catch { /* ignore */ }
  const error = `HTTP ${res.status}: ${body.slice(0, 200)}`;
  appendSyncError(logPath, {
    timestamp: new Date().toISOString(),
    arxivId,
    status: res.status,
    error: `[reading-list:${action}] ${error}`,
  });
  return { ok: false, arxivId, action, status: res.status, error };
}

/**
 * Called when user runs /save — upserts the paper into reading_list.
 */
export async function syncSaveToSupabase(
  arxivId: string,
  opts?: ReadingListSyncDeps & { priority?: number; note?: string },
): Promise<ReadingListSyncResult> {
  const cfg = getConfig();
  const url     = opts?.url     ?? cfg.url;
  const key     = opts?.key     ?? cfg.key;
  const userId  = opts?.userId  ?? cfg.userId;
  const logPath = opts?.logPath ?? cfg.logPath;
  const fetcher = opts?.fetch   ?? globalThis.fetch;

  if (!key || !userId) {
    return { ok: true, arxivId, action: 'save', skipped: true };
  }

  try {
    const res = await request('POST', `${url}/rest/v1/reading_list`, key, {
      user_id:  userId,
      arxiv_id: arxivId,
      status:   'unread',
      priority: opts?.priority ?? 5,
      note:     opts?.note ?? null,
      saved_at: new Date().toISOString(),
    }, fetcher);
    return handleResponse(res, arxivId, 'save', logPath);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    appendSyncError(logPath, { timestamp: new Date().toISOString(), arxivId, error: `[reading-list:save] ${error}` });
    return { ok: false, arxivId, action: 'save', error };
  }
}

/**
 * Called when user runs /read — marks the paper as read.
 */
export async function syncReadToSupabase(
  arxivId: string,
  opts?: ReadingListSyncDeps,
): Promise<ReadingListSyncResult> {
  const cfg = getConfig();
  const url     = opts?.url     ?? cfg.url;
  const key     = opts?.key     ?? cfg.key;
  const userId  = opts?.userId  ?? cfg.userId;
  const logPath = opts?.logPath ?? cfg.logPath;
  const fetcher = opts?.fetch   ?? globalThis.fetch;

  if (!key || !userId) {
    return { ok: true, arxivId, action: 'read', skipped: true };
  }

  try {
    const res = await request(
      'PATCH',
      `${url}/rest/v1/reading_list?user_id=eq.${userId}&arxiv_id=eq.${arxivId}`,
      key,
      { status: 'read' },
      fetcher,
    );
    return handleResponse(res, arxivId, 'read', logPath);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    appendSyncError(logPath, { timestamp: new Date().toISOString(), arxivId, error: `[reading-list:read] ${error}` });
    return { ok: false, arxivId, action: 'read', error };
  }
}

/**
 * Called when user runs /love — bumps priority to 8.
 */
export async function syncLoveToSupabase(
  arxivId: string,
  opts?: ReadingListSyncDeps,
): Promise<ReadingListSyncResult> {
  const cfg = getConfig();
  const url     = opts?.url     ?? cfg.url;
  const key     = opts?.key     ?? cfg.key;
  const userId  = opts?.userId  ?? cfg.userId;
  const logPath = opts?.logPath ?? cfg.logPath;
  const fetcher = opts?.fetch   ?? globalThis.fetch;

  if (!key || !userId) {
    return { ok: true, arxivId, action: 'love', skipped: true };
  }

  try {
    const res = await request(
      'PATCH',
      `${url}/rest/v1/reading_list?user_id=eq.${userId}&arxiv_id=eq.${arxivId}`,
      key,
      { priority: 8 },
      fetcher,
    );
    return handleResponse(res, arxivId, 'love', logPath);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    appendSyncError(logPath, { timestamp: new Date().toISOString(), arxivId, error: `[reading-list:love] ${error}` });
    return { ok: false, arxivId, action: 'love', error };
  }
}
