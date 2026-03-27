/**
 * explainPaper.ts
 *
 * Core library for the /explain Signal command.
 *
 * Given a paper query (arxiv ID, fuzzy title, or digest ref like "#2 from today"),
 * looks up the paper, prepares text (full text preferred, abstract fallback),
 * and generates a plain-English explanation via OpenRouter.
 *
 * Three explanation levels:
 *   eli12     — explain like I'm 12: no jargon, concrete analogies, 3–4 sentences
 *   undergrad — explain to a CS undergrad: correct terminology, intuitive descriptions
 *   engineer  — explain to a senior ML engineer: precise, technical, implementation-aware
 *
 * Default level: engineer (suits Mikey's background)
 *
 * Context strategy:
 *   1. Use first 6000 chars of full text (intro + methods) if available
 *   2. Fall back to abstract only (always available)
 *
 * Model: claude-3-haiku-20240307 (same as /ask — fast, cheap, good enough)
 *
 * Signal reply:
 *   - Answer body: max 900 chars, truncated at sentence boundary
 *   - Footer: paper title + year (max 60 chars)
 *   - Level badge in reply: [ELI12] / [UNDERGRAD] / [ENGINEER]
 *
 * Error cases:
 *   - paper_not_found: no match in DB + arxiv API (for title search, no fallback)
 *   - ambiguous: multiple title matches → return list of candidates
 *   - no_api_key: OPENROUTER_API_KEY missing
 *   - api_error: OpenRouter request failed (retries once)
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Db } from '../db.js';
import type { ExplainLevel } from './types.js';
import { lookupPaper } from './lookup.js';
import { loadConfig } from '../config.js';
import type { PaperInfo } from './types.js';

// ── Constants ──────────────────────────────────────────────────────────────

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'anthropic/claude-3-haiku';
const MAX_ANSWER_CHARS = 900;
const FULL_TEXT_CHARS = 6_000;
const API_TIMEOUT_MS = 18_000;
const MIN_QUERY_LENGTH = 2;

// ── Types ──────────────────────────────────────────────────────────────────

export interface ExplainOptions {
  db: Db;
  query: string;
  level: ExplainLevel;
  repoRoot?: string;
}

export type ExplainResult =
  | ExplainSuccess
  | ExplainNotFound
  | ExplainAmbiguous
  | ExplainNoApiKey
  | ExplainApiError;

export interface ExplainSuccess {
  ok: true;
  paper: PaperInfo;
  level: ExplainLevel;
  answer: string;
  contextSource: 'full-text' | 'abstract';
}

export interface ExplainNotFound {
  ok: false;
  error: 'paper_not_found';
  message: string;
  query: string;
}

export interface ExplainAmbiguous {
  ok: false;
  error: 'ambiguous';
  message: string;
  candidates: Array<{ arxivId: string; title: string }>;
}

export interface ExplainNoApiKey {
  ok: false;
  error: 'no_api_key';
  message: string;
}

export interface ExplainApiError {
  ok: false;
  error: 'api_error';
  message: string;
}

// ── API Key ────────────────────────────────────────────────────────────────

function resolveApiKeyPath(repoRoot: string): string {
  return path.join(repoRoot, 'data', 'openrouter.key');
}

export function loadOpenRouterKey(repoRoot: string): string | null {
  // 1. Environment variable
  const envKey = process.env['OPENROUTER_API_KEY'];
  if (envKey?.trim()) return envKey.trim();

  // 2. Key file
  const keyPath = resolveApiKeyPath(repoRoot);
  try {
    const content = fs.readFileSync(keyPath, 'utf8').trim();
    if (content) return content;
  } catch {
    // File not found — fall through
  }

  return null;
}

// ── Context preparation ────────────────────────────────────────────────────

export function prepareContext(paper: PaperInfo): {
  text: string;
  source: 'full-text' | 'abstract';
} {
  // Try full text first
  if (paper.txtPath) {
    try {
      const stats = fs.statSync(paper.txtPath);
      if (stats.size > 100) {
        const raw = fs.readFileSync(paper.txtPath, 'utf8');
        const trimmed = raw.slice(0, FULL_TEXT_CHARS).trim();
        if (trimmed.length > 100) {
          return { text: trimmed, source: 'full-text' };
        }
      }
    } catch {
      // Fall through to abstract
    }
  }

  // Abstract fallback (always available in DB)
  return { text: paper.abstract, source: 'abstract' };
}

// ── Prompts ────────────────────────────────────────────────────────────────

const LEVEL_PROMPTS: Record<ExplainLevel, string> = {
  eli12: `You explain research papers to a 12-year-old. Use concrete everyday analogies, no jargon, no acronyms unexplained. 3–5 sentences max. Keep it engaging and fun.`,

  undergrad: `You explain research papers to a CS undergraduate with basic ML knowledge. Use correct terminology but with intuitive descriptions. Avoid unexplained advanced concepts. 4–6 sentences.`,

  engineer: `You explain research papers to a senior ML/AI engineer. Be precise and technical. Focus on: what problem is solved, the key technical approach, the main results, and what's novel or surprising. Skip intro padding. 5–8 sentences.`,
};

const LEVEL_LABELS: Record<ExplainLevel, string> = {
  eli12: '👶 ELI12',
  undergrad: '🎓 UNDERGRAD',
  engineer: '⚙️ ENGINEER',
};

/**
 * Extract approximate year from arxiv ID (e.g., "2402.01234" → 2024)
 */
export function yearFromArxivId(arxivId: string): string {
  const match = /^(\d{2})(\d{2})\./.exec(arxivId);
  if (match) {
    const yy = parseInt(match[1]!, 10);
    const year = yy >= 91 ? 1900 + yy : 2000 + yy;
    return String(year);
  }
  return 'n.d.';
}

function buildExplainPrompt(paper: PaperInfo, level: ExplainLevel, context: string): string {
  const authors = (() => {
    if (!paper.authors || paper.authors.length === 0) return 'Unknown authors';
    if (paper.authors.length <= 2) return paper.authors.join(' & ');
    return `${paper.authors[0]} et al.`;
  })();
  const year = yearFromArxivId(paper.arxivId);
  const rolePrompt = LEVEL_PROMPTS[level];

  return `${rolePrompt}

Paper: "${paper.title}" by ${authors} (${year})

Paper text:
${context}

Task: Explain what this paper is about and why it matters. Keep your answer concise and focused — this will be read on a phone.`;
}

// ── OpenRouter call ────────────────────────────────────────────────────────

interface OpenRouterResponse {
  choices: Array<{
    message: { content: string | null };
    finish_reason: string;
  }>;
}

async function callOpenRouter(
  prompt: string,
  apiKey: string,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const makeRequest = async (): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const res = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://github.com/mindofindica/arxiv-coach',
          'X-Title': 'arxiv-coach /explain',
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 400,
          temperature: 0.4,
        }),
        signal: controller.signal,
      });
      return res;
    } finally {
      clearTimeout(timeout);
    }
  };

  // First attempt
  let res: Response;
  try {
    res = await makeRequest();
  } catch (err) {
    // Retry once on network error
    try {
      res = await makeRequest();
    } catch {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Network error: ${msg}` };
    }
  }

  if (!res.ok) {
    // Retry once on 5xx
    if (res.status >= 500) {
      try {
        res = await makeRequest();
      } catch {
        return { ok: false, message: `OpenRouter server error (${res.status})` };
      }
      if (!res.ok) {
        return { ok: false, message: `OpenRouter error: ${res.status} ${res.statusText}` };
      }
    } else {
      return { ok: false, message: `OpenRouter error: ${res.status} ${res.statusText}` };
    }
  }

  let json: OpenRouterResponse;
  try {
    json = (await res.json()) as OpenRouterResponse;
  } catch {
    return { ok: false, message: 'Failed to parse OpenRouter response as JSON' };
  }

  const text = json.choices?.[0]?.message?.content?.trim() ?? '';
  if (!text) {
    return { ok: false, message: 'OpenRouter returned an empty response' };
  }

  return { ok: true, text };
}

// ── Answer formatting ──────────────────────────────────────────────────────

/**
 * Truncate at sentence boundary, max `maxChars` chars.
 */
export function truncateExplain(text: string, maxChars: number = MAX_ANSWER_CHARS): string {
  if (text.length <= maxChars) return text;

  // Find last sentence boundary before maxChars
  const sub = text.slice(0, maxChars);
  const lastDot = Math.max(sub.lastIndexOf('. '), sub.lastIndexOf('.\n'));
  const lastBang = Math.max(sub.lastIndexOf('! '), sub.lastIndexOf('!\n'));
  const lastQ = Math.max(sub.lastIndexOf('? '), sub.lastIndexOf('?\n'));

  const boundary = Math.max(lastDot, lastBang, lastQ);
  if (boundary > maxChars * 0.5) {
    return sub.slice(0, boundary + 1).trim();
  }

  // No good sentence boundary — hard cut at word boundary
  const lastSpace = sub.lastIndexOf(' ');
  return (lastSpace > 0 ? sub.slice(0, lastSpace) : sub) + '…';
}

/**
 * Format the full Signal reply for a successful explain.
 */
export function formatExplainReply(result: ExplainSuccess): string {
  const { paper, level, answer, contextSource } = result;

  const levelLabel = LEVEL_LABELS[level];
  const sourceNote = contextSource === 'full-text' ? '' : ' (abstract only)';

  // Footer: title truncated to 55 chars
  const title = paper.title ?? 'Unknown Title';
  const year = yearFromArxivId(paper.arxivId);
  const shortTitle = title.length > 55 ? title.slice(0, 52) + '…' : title;

  return `${levelLabel}${sourceNote}\n\n${answer}\n\n> ${shortTitle} (${year})`;
}

// ── Main function ──────────────────────────────────────────────────────────

export async function explainPaper(opts: ExplainOptions): Promise<ExplainResult> {
  const { db, query, level, repoRoot = process.cwd() } = opts;

  // Validate query
  if (!query || query.trim().length < MIN_QUERY_LENGTH) {
    return {
      ok: false,
      error: 'paper_not_found',
      message:
        '⚠️ Query too short. Usage:\n\n' +
        '/explain <arxiv-id>\n' +
        '/explain <title keywords>\n' +
        '/explain #2 from today\n\n' +
        'Add --level eli12 / undergrad / engineer for different explanation levels.',
      query,
    };
  }

  // Load API key
  const apiKey = loadOpenRouterKey(repoRoot);
  if (!apiKey) {
    return {
      ok: false,
      error: 'no_api_key',
      message:
        '❌ OPENROUTER_API_KEY not set.\n\n' +
        'Add it to data/openrouter.key or set the OPENROUTER_API_KEY env var.',
    };
  }

  // Look up paper
  const lookupResult = lookupPaper(db, query.trim());

  if (lookupResult.status === 'not-found') {
    const methodHint =
      lookupResult.method === 'arxiv-id'
        ? `Paper ${query} not found in local DB. It may not have been ingested yet.\n\nTry: /search <keywords>`
        : `No paper found matching "${query}".\n\nTry: /search ${query}`;

    return {
      ok: false,
      error: 'paper_not_found',
      message: `❓ ${methodHint}`,
      query,
    };
  }

  if (lookupResult.status === 'ambiguous') {
    const candidates = (lookupResult.candidates ?? []).slice(0, 5);
    const lines = candidates.map((c, i) => `${i + 1}. ${c.title.slice(0, 60)}…\n   arxiv:${c.arxivId}`);
    return {
      ok: false,
      error: 'ambiguous',
      message:
        `🤔 Multiple papers match "${query}". Be more specific:\n\n` +
        lines.join('\n') +
        '\n\nOr use the arxiv ID directly: /explain <arxiv-id>',
      candidates: candidates.map(c => ({ arxivId: c.arxivId, title: c.title })),
    };
  }

  const paper = lookupResult.paper!;

  // Prepare context (full text or abstract)
  const { text: contextText, source: contextSource } = prepareContext(paper);

  // Build prompt
  const prompt = buildExplainPrompt(paper, level, contextText);

  // Call OpenRouter
  const apiResult = await callOpenRouter(prompt, apiKey);
  if (!apiResult.ok) {
    return {
      ok: false,
      error: 'api_error',
      message: `❌ Could not generate explanation: ${apiResult.message}\n\nTry again in a moment.`,
    };
  }

  const answer = truncateExplain(apiResult.text);

  return {
    ok: true,
    paper,
    level,
    answer,
    contextSource,
  };
}
