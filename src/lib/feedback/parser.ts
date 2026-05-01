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
export type QueryCommand = 'reading-list' | 'status' | 'stats' | 'weekly' | 'search' | 'trends' | 'digest' | 'recommend' | 'preview' | 'streak' | 'progress' | 'gaps';

export interface ParsedNote {
  command: 'note';
  arxivId: string;
  noteText: string;
  raw: string;
}

export interface ParseResultNoteOk {
  ok: true;
  kind: 'note';
  note: ParsedNote;
}

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
  /** Number of weeks to look back for /trends (default 8) */
  weeks: number;
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
  /**
   * Minimum LLM relevance score (1–5) for /digest results.
   * Default: 3.
   */
  minScore: number;
  /**
   * Whether /digest should respect the dedup window (exclude papers sent in last 24h).
   * Default: false (bypass dedup for on-demand use).
   */
  respectDedup: boolean;
  /**
   * For /gaps: whether to include understood gaps in the result.
   * Set by --all flag. Default: false.
   */
  includeUnderstood: boolean;
  /**
   * For /gaps: filter by specific status ('identified' | 'lesson_queued' | 'understood').
   * Set by --status flag.
   */
  gapsStatusFilter: string | null;
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

export interface ParsedPaperQuery {
  command: 'ask';
  arxivId: string;
  question: string;
  raw: string;
}

export interface ParseResultPaperQueryOk {
  ok: true;
  kind: 'paper-query';
  paperQuery: ParsedPaperQuery;
}

export type ExplainLevel = 'eli12' | 'undergrad' | 'engineer';

export interface ParsedExplain {
  command: 'explain';
  /** Query: arxiv ID, title keywords, or digest ref like "#2 from today" */
  query: string;
  level: ExplainLevel;
  raw: string;
}

export interface ParseResultExplainOk {
  ok: true;
  kind: 'explain';
  explain: ParsedExplain;
}

export interface ParsedHelp {
  command: 'help';
  /** Command name to look up detail for, or null for overview */
  commandName: string | null;
  raw: string;
}

export interface ParseResultHelpOk {
  ok: true;
  kind: 'help';
  help: ParsedHelp;
}

export interface ParseResultError {
  ok: false;
  error: 'not_a_command' | 'unknown_command' | 'missing_arxiv_id' | 'invalid_arxiv_id' | 'missing_question' | 'missing_explain_query';
  message: string;
}

export type ParseResult = ParseResultOk | ParseResultQueryOk | ParseResultPaperQueryOk | ParseResultExplainOk | ParseResultHelpOk | ParseResultNoteOk | ParseResultError;

// Arxiv ID regex: 4-digit year-month + 4-5 digits + optional version
const ARXIV_ID_RE = /\b(\d{4}\.\d{4,5})(v\d+)?\b/;

// Full URL pattern
const ARXIV_URL_RE = /https?:\/\/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(v\d+)?/;

// Prefixed pattern: arxiv:2403.12345
const ARXIV_PREFIX_RE = /\barxiv:(\d{4}\.\d{4,5})(v\d+)?\b/i;

const FEEDBACK_COMMANDS: Set<string> = new Set(['read', 'skip', 'save', 'love', 'meh']);
const QUERY_COMMANDS: Set<string> = new Set(['reading-list', 'status', 'stats', 'weekly', 'search', 'trends', 'digest', 'recommend', 'preview', 'streak', 'progress', 'gaps']);
const NOTE_COMMAND = 'note';

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
  weeks: number;
  week: string | null;
  track: string | null;
  from: string | null;
  minScore: number;
  respectDedup: boolean;
  includeUnderstood: boolean;
  gapsStatusFilter: string | null;
} {
  let status: 'unread' | 'read' | 'all' = 'unread';
  let limit = 5;
  let days = 7;
  let weeks = 8;
  let week: string | null = null;
  let track: string | null = null;
  let from: string | null = null;
  let minScore = 3;
  let respectDedup = false;
  let includeUnderstood = false;
  let gapsStatusFilter: string | null = null;

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
    } else if (key === 'weeks') {
      const n = parseInt(val, 10);
      if (!isNaN(n) && n >= 1 && n <= 52) weeks = n;
    } else if (key === 'week') {
      if (ISO_WEEK_RE.test(val)) week = val;
    } else if (key === 'track') {
      if (val.length > 0) track = val;
    } else if (key === 'from') {
      // Accept YYYY, YYYY-MM, or YYYY-MM-DD
      if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(val)) from = val;
    } else if (key === 'min-score' || key === 'minScore') {
      const n = parseInt(val, 10);
      if (!isNaN(n) && n >= 1 && n <= 5) minScore = n;
    } else if (key === 'dedup') {
      respectDedup = val !== 'false' && val !== '0';
    } else if (key === 'all') {
      // /gaps --all: include understood gaps
      includeUnderstood = val !== 'false' && val !== '0';
      if (val === '' || val === 'true' || val === '1') includeUnderstood = true;
    } else if (key === 'status' && (val === 'identified' || val === 'lesson_queued' || val === 'understood')) {
      // /gaps --status understood overrides the reading-list status
      gapsStatusFilter = val;
    }
  }

  return { status, limit, days, weeks, week, track, from, minScore, respectDedup, includeUnderstood, gapsStatusFilter };
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

    // For /digest, the optional positional arg is a track name (everything before first --)
    let digestTrackArg: string | null = null;
    if (command === 'digest') {
      const flagIdx = rest.search(/--[\w-]+/);
      if (flagIdx === -1) {
        digestTrackArg = rest.trim() || null;
        flagInput = '';
      } else {
        digestTrackArg = rest.slice(0, flagIdx).trim() || null;
        flagInput = rest.slice(flagIdx);
      }
    }

    const { status, limit, days, weeks, week, track: flagTrack, from, minScore, respectDedup, includeUnderstood, gapsStatusFilter } = parseQueryFlags(flagInput);
    // /digest: positional track arg wins over --track flag
    const resolvedTrack = command === 'digest' ? (digestTrackArg ?? flagTrack) : flagTrack;

    return {
      ok: true,
      kind: 'query' as const,
      query: {
        command: command as QueryCommand,
        status,
        limit,
        days,
        weeks,
        week,
        track: resolvedTrack,
        searchQuery,
        from,
        minScore,
        respectDedup,
        includeUnderstood,
        gapsStatusFilter,
        raw: trimmed,
      },
    };
  }

  // ── /ask — paper Q&A (arxiv ID + question) ──────────────────────────
  if (command === 'ask') {
    // First token = arxiv ID, rest = question
    const tokens = rest.split(/\s+/);
    const idToken = tokens[0] ?? '';
    const question = tokens.slice(1).join(' ').trim();

    const arxivId = extractArxivId(idToken) ?? extractArxivId(rest);

    if (!arxivId) {
      return {
        ok: false,
        error: 'missing_arxiv_id',
        message:
          'Missing arxiv ID. Usage: /ask <arxiv-id> <question>\n\n' +
          'Example: /ask 2402.01234 what is the key contribution?',
      };
    }

    if (!question) {
      return {
        ok: false,
        error: 'missing_question',
        message:
          `Missing question. Usage: /ask <arxiv-id> <question>\n\n` +
          `Example: /ask ${arxivId} what is the key contribution?`,
      };
    }

    return {
      ok: true,
      kind: 'paper-query' as const,
      paperQuery: {
        command: 'ask',
        arxivId,
        question,
        raw: trimmed,
      },
    };
  }

  // ── /explain — plain-English paper explanation ───────────────────────
  if (command === 'explain') {
    // Syntax: /explain <query> [--level eli12|undergrad|engineer]
    // Query = everything before the first --flag (arxiv ID, title, or digest ref)
    const flagIdx = rest.search(/--[\w-]+/);
    const rawQuery = flagIdx === -1 ? rest.trim() : rest.slice(0, flagIdx).trim();
    const flagPart = flagIdx === -1 ? '' : rest.slice(flagIdx);

    if (!rawQuery) {
      return {
        ok: false,
        error: 'missing_explain_query',
        message:
          'Missing query. Usage: /explain <arxiv-id or title or #N from today>\n\n' +
          'Examples:\n' +
          '  /explain 2402.01234\n' +
          '  /explain attention is all you need\n' +
          '  /explain #2 from today\n' +
          '  /explain 2402.01234 --level eli12',
      };
    }

    // Parse --level flag
    const levelMatch = /--level\s+(eli12|undergrad|engineer)/i.exec(flagPart);
    const level: ExplainLevel = levelMatch
      ? (levelMatch[1]!.toLowerCase() as ExplainLevel)
      : 'engineer';

    return {
      ok: true,
      kind: 'explain' as const,
      explain: {
        command: 'explain',
        query: rawQuery,
        level,
        raw: trimmed,
      },
    };
  }

  // ── /note — append a note to an existing feedback ───────────────────
  if (command === NOTE_COMMAND) {
    // Syntax: /note <arxiv-id> <note text>
    const tokens = rest.split(/\s+/);
    const idToken = tokens[0] ?? '';
    const arxivId = extractArxivId(idToken) ?? extractArxivId(rest);

    if (!arxivId) {
      return {
        ok: false,
        error: 'missing_arxiv_id',
        message:
          'Missing arxiv ID. Usage: /note <arxiv-id> <note text>\n\n' +
          'Example: /note 2402.01234 connects to the agent memory work',
      };
    }

    // Note text = everything after the arxiv ID token
    const noteText = tokens.slice(1).join(' ').trim();

    if (!noteText) {
      return {
        ok: false,
        error: 'missing_question',
        message:
          `Missing note text. Usage: /note <arxiv-id> <note text>\n\n` +
          `Example: /note ${arxivId} great coverage of sparse attention`,
      };
    }

    return {
      ok: true,
      kind: 'note' as const,
      note: {
        command: 'note',
        arxivId,
        noteText,
        raw: trimmed,
      },
    };
  }

  // ── /help — command reference ────────────────────────────────────────
  if (command === 'help') {
    const commandName = rest.trim() || null;
    return {
      ok: true,
      kind: 'help' as const,
      help: {
        command: 'help',
        commandName,
        raw: trimmed,
      },
    };
  }

  if (!FEEDBACK_COMMANDS.has(command)) {
    return {
      ok: false,
      error: 'unknown_command',
      message: `Unknown command: /${command}. Supported: /read /skip /save /love /meh /reading-list /status /stats /weekly /search /trends /digest /recommend /preview /streak /progress /ask /explain /help`,
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
