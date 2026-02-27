/**
 * Signal Feedback Parser
 *
 * Parses incoming Signal messages from Mikey for arxiv-coach feedback commands.
 *
 * Paper feedback commands (require arxiv ID):
 *   /read 2403.12345         — mark as read (signal +8)
 *   /skip 2403.12345         — skip/deprioritise (signal -5)
 *   /save 2403.12345         — add to reading list (signal +5)
 *   /love 2403.12345         — strong positive (signal +10)
 *   /meh 2403.12345          — weak negative (signal -2)
 *   /read 2403.12345 --notes interesting ML approach
 *   /skip 2403.12345 --reason too theoretical
 *
 * Query commands (no arxiv ID needed):
 *   /reading-list            — show saved/unread papers (default: unread, limit 5)
 *   /reading-list --status all --limit 10
 *   /reading-list --status read
 *   /status                  — system health snapshot (last digest, papers, reading list)
 *   /stats                   — 7-day activity breakdown (feedback counts, top tracks)
 *   /stats --days 30         — longer window
 *   /weekly                  — weekly paper summary (current week)
 *   /weekly --week 2026-W07  — specific ISO week
 *   /weekly --track LLM      — filter to one track
 *
 * ArXiv ID formats accepted:
 *   2403.12345       — bare (new style, 4+5 digits)
 *   2403.1234        — bare (new style, 4+4 digits)
 *   2403.12345v2     — versioned
 *   arxiv:2403.12345 — prefixed
 *   https://arxiv.org/abs/2403.12345  — full URL
 *
 * Flag parsing:
 *   --notes "quoted value"   — double or single quotes
 *   --notes unquoted multi word text  — everything until the next --flag
 */

export type FeedbackType = 'read' | 'skip' | 'save' | 'love' | 'meh';
export type QueryCommand = 'reading-list' | 'status' | 'stats' | 'weekly' | 'search' | 'recommend' | 'preview';

export interface ParsedFeedback {
  feedbackType: FeedbackType;
  arxivId: string;     // normalised, no version suffix, no prefix
  notes: string | null;
  reason: string | null;
  priority: number | null;  // for /save only
  raw: string;              // original message text
}

export interface ParsedQuery {
  command: QueryCommand;
  status: 'unread' | 'read' | 'all';  // filter for reading-list
  limit: number;                        // max papers to return (1-20)
  days: number;                         // window for /stats (default 7)
  /** ISO week override for /weekly, e.g. "2026-W07" (default: current week) */
  week: string | null;
  /** Track filter for /weekly or /search, e.g. "LLM" (default: all tracks) */
  track: string | null;
  /**
   * Free-text search query for /search, e.g. "speculative decoding".
   * Everything before the first --flag is the query.
   */
  searchQuery: string | null;
  /**
   * ISO date prefix to filter /search results, e.g. "2026" or "2025-10".
   * Only papers published on or after this prefix are included.
   */
  from: string | null;
  raw: string;
}

export interface ParseResultOk {
  ok: true;
  kind: 'feedback';
  feedback: ParsedFeedback;
}

export interface ParseResultQueryOk {
  ok: true;
  kind: 'query';
  query: ParsedQuery;
}

export interface ParseResultError {
  ok: false;
  error: 'not_a_command' | 'unknown_command' | 'missing_arxiv_id' | 'invalid_arxiv_id';
  message: string;
}

export type ParseResult = ParseResultOk | ParseResultQueryOk | ParseResultError;

// Arxiv ID regex: 4-digit year-month + 4-5 digits + optional version
const ARXIV_ID_RE = /\b(\d{4}\.\d{4,5})(v\d+)?\b/;

// Full URL pattern
const ARXIV_URL_RE = /https?:\/\/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(v\d+)?/;

// Prefixed pattern: arxiv:2403.12345
const ARXIV_PREFIX_RE = /\barxiv:(\d{4}\.\d{4,5})(v\d+)?\b/i;

const FEEDBACK_COMMANDS: Set<string> = new Set(['read', 'skip', 'save', 'love', 'meh']);
const QUERY_COMMANDS: Set<string> = new Set(['reading-list', 'status', 'stats', 'weekly', 'search', 'recommend', 'preview']);

/**
 * Extract and normalise an arxiv ID from a string fragment.
 * Returns the bare ID (e.g. "2403.12345") or null.
 */
export function extractArxivId(fragment: string): string | null {
  // Try URL form first (most specific)
  const urlMatch = fragment.match(ARXIV_URL_RE);
  if (urlMatch?.[1]) return urlMatch[1];

  // Try prefixed form
  const prefixMatch = fragment.match(ARXIV_PREFIX_RE);
  if (prefixMatch?.[1]) return prefixMatch[1];

  // Try bare ID
  const bareMatch = fragment.match(ARXIV_ID_RE);
  if (bareMatch?.[1]) return bareMatch[1];

  return null;
}

/**
 * Parse optional flags from the remaining part of a command.
 *
 * Supports three value forms:
 *   --key "quoted value"          — double-quoted (may contain spaces)
 *   --key 'quoted value'          — single-quoted (may contain spaces)
 *   --key unquoted multi word     — unquoted: captures until the next --flag or end of string
 *
 * Signal strips surrounding quotes, so the unquoted multi-word form is the
 * most common real-world input (e.g. /save 2403.12345 --notes interesting ML paper).
 */
function parseFlags(flagStr: string): { notes: string | null; reason: string | null; priority: number | null } {
  let notes: string | null = null;
  let reason: string | null = null;
  let priority: number | null = null;

  // Split into segments at each --key boundary, keeping the delimiter
  // e.g. "--notes hello world --priority 5" →
  //   ["", "--notes hello world ", "--priority 5"]
  const segments = flagStr.split(/(--\w+)/);
  // Reassemble into key→value pairs: [key, rawValue, key, rawValue, ...]
  for (let i = 1; i < segments.length; i += 2) {
    const key = segments[i]!.slice(2); // strip leading --
    const rawVal = (segments[i + 1] ?? '').trim();

    let val: string;
    // Strip surrounding quotes if present
    if (
      (rawVal.startsWith('"') && rawVal.endsWith('"')) ||
      (rawVal.startsWith("'") && rawVal.endsWith("'"))
    ) {
      val = rawVal.slice(1, -1);
    } else {
      val = rawVal;
    }

    if (key === 'notes') notes = val || null;
    else if (key === 'reason') reason = val || null;
    else if (key === 'priority') {
      const n = parseInt(val, 10);
      if (!isNaN(n) && n >= 1 && n <= 10) priority = n;
    }
  }

  return { notes, reason, priority };
}

// Validate ISO week format: YYYY-Www
const ISO_WEEK_RE = /^\d{4}-W\d{2}$/;

/**
 * Parse query flags for commands like /reading-list, /stats, /weekly, /search.
 */
function parseQueryFlags(flagStr: string): {
  status: 'unread' | 'read' | 'all';
  limit: number;
  days: number;
  week: string | null;
  track: string | null;
  from: string | null;
} {
  let status: 'unread' | 'read' | 'all' = 'unread';
  let limit = 5;
  let days = 7;
  let week: string | null = null;
  let track: string | null = null;
  let from: string | null = null;

  const segments = flagStr.split(/(--[\w-]+)/);
  for (let i = 1; i < segments.length; i += 2) {
    const key = segments[i]!.slice(2);
    const rawVal = (segments[i + 1] ?? '').trim();
    const val =
      (rawVal.startsWith('"') && rawVal.endsWith('"')) ||
      (rawVal.startsWith("'") && rawVal.endsWith("'"))
        ? rawVal.slice(1, -1)
        : rawVal;

    if (key === 'status' && (val === 'unread' || val === 'read' || val === 'all')) {
      status = val;
    } else if (key === 'limit') {
      const n = parseInt(val, 10);
      if (!isNaN(n) && n >= 1 && n <= 20) limit = n;
    } else if (key === 'days') {
      const n = parseInt(val, 10);
      if (!isNaN(n) && n >= 1 && n <= 90) days = n;
    } else if (key === 'week') {
      if (ISO_WEEK_RE.test(val)) week = val;
    } else if (key === 'track') {
      if (val.length > 0) track = val;
    } else if (key === 'from') {
      // Accept YYYY, YYYY-MM, or YYYY-MM-DD
      if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(val)) from = val;
    }
  }

  return { status, limit, days, week, track, from };
}

/**
 * Parse a Signal message and return structured feedback/query, or an error.
 */
export function parseFeedbackMessage(text: string): ParseResult {
  const trimmed = text.trim();

  // Must start with /
  if (!trimmed.startsWith('/')) {
    return {
      ok: false,
      error: 'not_a_command',
      message: 'Not a command (no leading /)',
    };
  }

  // Split off the command word
  const withoutSlash = trimmed.slice(1);
  const spaceIdx = withoutSlash.indexOf(' ');
  const command = spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? '' : withoutSlash.slice(spaceIdx + 1).trim();

  // ── Query commands (no arxiv ID required) ────────────────────────────
  if (QUERY_COMMANDS.has(command)) {
    // For /search, split the query text from the --flags.
    // Everything before the first "--flag" is the search query.
    let searchQuery: string | null = null;
    let flagInput = rest;

    if (command === 'search') {
      const flagIdx = rest.search(/--[\w-]+/);
      if (flagIdx === -1) {
        // No flags — all of rest is the query
        searchQuery = rest.trim() || null;
        flagInput = '';
      } else {
        searchQuery = rest.slice(0, flagIdx).trim() || null;
        flagInput = rest.slice(flagIdx);
      }
    }

    const { status, limit, days, week, track, from } = parseQueryFlags(flagInput);
    return {
      ok: true,
      kind: 'query' as const,
      query: {
        command: command as QueryCommand,
        status,
        limit,
        days,
        week,
        track,
        searchQuery,
        from,
        raw: trimmed,
      },
    };
  }

  if (!FEEDBACK_COMMANDS.has(command)) {
    return {
      ok: false,
      error: 'unknown_command',
      message: `Unknown command: /${command}. Supported: /read /skip /save /love /meh /reading-list /status /stats /weekly /search /recommend /preview`,
    };
  }

  // Extract arxiv ID from the rest
  if (!rest) {
    return {
      ok: false,
      error: 'missing_arxiv_id',
      message: `Missing arxiv ID. Usage: /${command} <arxiv-id>`,
    };
  }

  // The arxiv ID is the first token; flags come after
  const tokens = rest.split(/\s+/);
  const idToken = tokens[0]!;
  const flagStr = tokens.slice(1).join(' ');

  const arxivId = extractArxivId(idToken) ?? extractArxivId(rest);

  if (!arxivId) {
    return {
      ok: false,
      error: 'invalid_arxiv_id',
      message: `Could not find a valid arxiv ID in: "${idToken}". Expected format: YYMM.NNNNN`,
    };
  }

  const { notes, reason, priority } = parseFlags(flagStr);

  return {
    ok: true,
    kind: 'feedback' as const,
    feedback: {
      feedbackType: command as FeedbackType,
      arxivId,
      notes,
      reason,
      priority,
      raw: trimmed,
    },
  };
}
