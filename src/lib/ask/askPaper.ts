/**
 * askPaper.ts — Core function for /ask command.
 *
 * Given an arxiv ID and a question, looks up the paper in the local DB
 * (with arxiv API fallback), builds a structured prompt, calls OpenRouter,
 * and returns a concise answer formatted for Signal delivery.
 *
 * Design decisions:
 * - Uses paper abstract for Q&A context — always available, concise enough
 *   for most questions (methodology, contribution, comparison). Full-text is v2.
 * - Model: claude-3-haiku for speed + low cost. Fast enough for Signal UX.
 * - Fallback chain: local DB → arxiv API fetch → friendly error message.
 * - Signal length cap: 800 chars for answer + footer (~60 chars).
 *   OpenRouter is instructed to stay concise.
 */

import fs from 'node:fs';
import type { Db } from '../db.js';

// ── Types ─────────────────────────────────────────────────────────────────

export interface PaperContext {
  arxivId: string;
  title: string;
  abstract: string;
  authors: string[];
  year: string | null;
}

export interface AskResult {
  ok: true;
  answer: string;      // Plain text, max ~800 chars
  paperTitle: string;  // For Signal footer
  arxivId: string;
}

export interface AskError {
  ok: false;
  error: 'paper_not_found' | 'question_too_short' | 'api_error' | 'no_api_key';
  message: string;     // Human-readable, safe to send to Signal
}

export type AskOutcome = AskResult | AskError;

// ── Constants ─────────────────────────────────────────────────────────────

const AUTH_PROFILES_PATH = '/root/.openclaw/agents/main/agent/auth-profiles.json';
const ANSWER_MAX_CHARS = 800;
const QUESTION_MIN_CHARS = 5;
const ASK_MODEL = 'anthropic/claude-3-haiku';

// ── API key loading ────────────────────────────────────────────────────────

/**
 * Load OpenRouter API key from auth-profiles.json or OPENROUTER_API_KEY env.
 */
export function loadOpenRouterKey(profilesPath = AUTH_PROFILES_PATH): string | null {
  // Env var takes priority
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();

  if (!fs.existsSync(profilesPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as {
      profiles?: Record<string, { provider?: string; key?: string; apiKey?: string; token?: string }>;
      lastGood?: Record<string, string>;
    };

    const profiles = raw.profiles ?? {};
    const preferredName = raw.lastGood?.openrouter;
    if (preferredName && profiles[preferredName]) {
      const p = profiles[preferredName]!;
      if (typeof p.apiKey === 'string' && p.apiKey.trim()) return p.apiKey.trim();
      if (typeof p.key === 'string' && p.key.trim()) return p.key.trim();
      if (typeof p.token === 'string' && p.token.trim()) return p.token.trim();
    }

    for (const profile of Object.values(profiles)) {
      if (profile.provider !== 'openrouter') continue;
      if (typeof profile.apiKey === 'string' && profile.apiKey.trim()) return profile.apiKey.trim();
      if (typeof profile.key === 'string' && profile.key.trim()) return profile.key.trim();
      if (typeof profile.token === 'string' && profile.token.trim()) return profile.token.trim();
    }
  } catch {
    return null;
  }

  return null;
}

// ── Paper lookup ───────────────────────────────────────────────────────────

interface PaperRow {
  arxiv_id: string;
  title: string;
  abstract: string;
  authors_json: string;
  published_at: string | null;
}

/**
 * Look up a paper in the local SQLite DB.
 */
export function lookupPaperInDb(db: Db, arxivId: string): PaperContext | null {
  const row = db.sqlite
    .prepare(
      `SELECT arxiv_id, title, abstract, authors_json, published_at
       FROM papers WHERE arxiv_id = ?`,
    )
    .get(arxivId) as PaperRow | undefined;

  if (!row) return null;

  let authors: string[] = [];
  try {
    const parsed = JSON.parse(row.authors_json) as unknown;
    if (Array.isArray(parsed)) {
      authors = parsed.filter((a): a is string => typeof a === 'string');
    }
  } catch {
    // ignore malformed JSON
  }

  const year = row.published_at ? row.published_at.slice(0, 4) : null;

  return {
    arxivId: row.arxiv_id,
    title: row.title,
    abstract: row.abstract,
    authors,
    year,
  };
}

// ── arxiv API fallback ────────────────────────────────────────────────────

interface ArxivApiEntry {
  title?: string;
  summary?: string;
  author?: { name?: string } | Array<{ name?: string }>;
  published?: string;
}

interface ArxivApiResponse {
  feed?: {
    entry?: ArxivApiEntry | ArxivApiEntry[];
  };
}

/**
 * Fetch a paper from the arxiv API (fallback when not in local DB).
 * Uses the public query API — no key needed.
 */
export async function fetchPaperFromArxiv(
  arxivId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PaperContext | null> {
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}&max_results=1`;

  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'arxiv-coach (+https://github.com/mindofindica/arxiv-coach)' },
    });

    if (!res.ok) return null;

    const xml = await res.text();

    // Lightweight XML parsing — we only need a handful of fields
    const titleMatch = xml.match(/<title[^>]*>([\s\S]*?)<\/title>/g);
    const summaryMatch = xml.match(/<summary[^>]*>([\s\S]*?)<\/summary>/);
    const authorMatches = [...xml.matchAll(/<name>([\s\S]*?)<\/name>/g)];
    const publishedMatch = xml.match(/<published>([\s\S]*?)<\/published>/);
    const entryMatch = xml.match(/<entry>/);

    if (!entryMatch) return null;  // No results

    // First <title> is the feed title; second is the paper title
    const paperTitle = titleMatch?.[1]
      ? titleMatch[1]
          .replace(/<[^>]*>/g, '')
          .replace(/\s+/g, ' ')
          .trim()
      : null;

    const abstract = summaryMatch?.[1]
      ? summaryMatch[1]
          .replace(/<[^>]*>/g, '')
          .replace(/\s+/g, ' ')
          .trim()
      : null;

    if (!paperTitle || !abstract) return null;

    const authors = authorMatches
      .filter((m) => typeof m[1] === 'string')
      .map((m) => (m[1] as string).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());

    const year = publishedMatch?.[1]?.slice(0, 4) ?? null;

    return { arxivId, title: paperTitle, abstract, authors, year };
  } catch {
    return null;
  }
}

// ── OpenRouter call ───────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  'You are a research paper Q&A assistant. Answer questions about papers using ' +
  'the provided title, authors, and abstract. Be precise and concise. ' +
  'Keep answers under 150 words unless the question genuinely requires more detail.';

export function buildAskPrompt(paper: PaperContext, question: string): string {
  const authorLine =
    paper.authors.length > 0
      ? `Authors: ${paper.authors.slice(0, 3).join(', ')}${paper.authors.length > 3 ? ' et al.' : ''}`
      : '';
  const yearLine = paper.year ? `Year: ${paper.year}` : '';

  return [
    `Title: ${paper.title}`,
    authorLine,
    yearLine,
    '',
    `Abstract: ${paper.abstract}`,
    '',
    `Question: ${question}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function callOpenRouterAsk(opts: {
  apiKey: string;
  paper: PaperContext;
  question: string;
  fetchImpl: typeof fetch;
}): Promise<string> {
  const { apiKey, paper, question, fetchImpl } = opts;

  const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ASK_MODEL,
      temperature: 0.3,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildAskPrompt(paper, question) },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 200)}`);
  }

  interface OpenRouterResponse {
    choices?: Array<{ message?: { content?: string } }>;
  }
  const data = (await res.json()) as OpenRouterResponse;
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('OpenRouter returned empty content');
  }

  return content.trim();
}

// ── Format for Signal ─────────────────────────────────────────────────────

/**
 * Truncate an answer to fit within Signal's practical message length,
 * leaving room for the footer.
 */
export function truncateAnswer(answer: string, maxChars = ANSWER_MAX_CHARS): string {
  if (answer.length <= maxChars) return answer;

  // Truncate at the last sentence boundary before the limit
  const truncated = answer.slice(0, maxChars);
  const lastPeriod = truncated.lastIndexOf('.');
  if (lastPeriod > maxChars * 0.6) {
    return truncated.slice(0, lastPeriod + 1) + ' [...]';
  }
  return truncated.trimEnd() + ' [...]';
}

/**
 * Format the final Signal reply for /ask.
 * answer + paper footer in italics-safe format.
 */
export function formatAskReply(result: AskResult): string {
  const answer = truncateAnswer(result.answer);
  const footer = `\n\n> Re: ${result.paperTitle}`;
  return answer + footer;
}

// ── Main entry point ──────────────────────────────────────────────────────

export interface AskPaperOptions {
  db: Db;
  arxivId: string;
  question: string;
  fetchImpl?: typeof fetch;
  profilesPath?: string;
}

/**
 * Main function: look up paper, call OpenRouter, return formatted result.
 * This is the function used by the Signal handler and CLI.
 */
export async function askPaper(opts: AskPaperOptions): Promise<AskOutcome> {
  const { db, arxivId, question, fetchImpl = fetch, profilesPath = AUTH_PROFILES_PATH } = opts;

  // 1. Validate question
  if (!question || question.trim().length < QUESTION_MIN_CHARS) {
    return {
      ok: false,
      error: 'question_too_short',
      message:
        `⚠️ Question too short. Try:\n` +
        `  /ask ${arxivId} what is the key contribution?\n` +
        `  /ask ${arxivId} how does it compare to previous work?`,
    };
  }

  // 2. Load API key
  const apiKey = loadOpenRouterKey(profilesPath);
  if (!apiKey) {
    return {
      ok: false,
      error: 'no_api_key',
      message: '❌ No OpenRouter API key found. Set OPENROUTER_API_KEY or configure auth-profiles.json.',
    };
  }

  // 3. Look up paper (DB first, then arxiv API fallback)
  let paper = lookupPaperInDb(db, arxivId);

  if (!paper) {
    paper = await fetchPaperFromArxiv(arxivId, fetchImpl);
  }

  if (!paper) {
    return {
      ok: false,
      error: 'paper_not_found',
      message:
        `❓ Paper not found: ${arxivId}\n\n` +
        `Not in local DB and arXiv lookup failed. ` +
        `Try /search first to check if it's been ingested, or verify the ID at:\n` +
        `https://arxiv.org/abs/${arxivId}`,
    };
  }

  // 4. Call OpenRouter (retry once on transient error)
  let answer: string;
  try {
    answer = await callOpenRouterAsk({ apiKey, paper, question: question.trim(), fetchImpl });
  } catch (firstErr) {
    // Retry once after 2s
    await new Promise((r) => setTimeout(r, 2000));
    try {
      answer = await callOpenRouterAsk({ apiKey, paper, question: question.trim(), fetchImpl });
    } catch (secondErr) {
      const msg = secondErr instanceof Error ? secondErr.message : String(secondErr);
      return {
        ok: false,
        error: 'api_error',
        message: `❌ Couldn't reach OpenRouter: ${msg.slice(0, 100)}\nTry again in a moment.`,
      };
    }
  }

  return {
    ok: true,
    answer,
    paperTitle: paper.title,
    arxivId: paper.arxivId,
  };
}
