/**
 * supabase-sync.ts
 *
 * Keeps the PaperBrief Supabase `papers` table in sync with newly ingested
 * arxiv-coach papers. Called fire-and-forget from repo.upsertPaper().
 *
 * Env vars (optional — sync is skipped silently if missing):
 *   SUPABASE_URL           e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY   service role key (write access)
 */

import type { ArxivEntry } from './arxiv.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://otekgfkmkrpwidqjslmo.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY ?? '';

export async function syncPaperToSupabase(entry: ArxivEntry): Promise<void> {
  if (!SUPABASE_KEY) return; // silently skip if not configured

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

  await fetch(`${SUPABASE_URL}/rest/v1/papers`, {
    method: 'POST',
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates',
    },
    body,
  });
}
