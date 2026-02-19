/**
 * Signal Feedback Parser
 *
 * Parses incoming Signal messages from Mikey for arxiv-coach feedback commands.
 *
 * Supported patterns:
 *   /read 2403.12345         — mark as read (signal +8)
 *   /skip 2403.12345         — skip/deprioritise (signal -5)
 *   /save 2403.12345         — add to reading list (signal +5)
 *   /love 2403.12345         — strong positive (signal +10)
 *   /meh 2403.12345          — weak negative (signal -2)
 *   /read 2403.12345 --notes "Interesting approach to..."
 *   /skip 2403.12345 --reason "Too theoretical"
 *
 * ArXiv ID formats accepted:
 *   2403.12345       — bare (new style, 4+5 digits)
 *   2403.1234        — bare (new style, 4+4 digits)
 *   2403.12345v2     — versioned
 *   arxiv:2403.12345 — prefixed
 *   https://arxiv.org/abs/2403.12345  — full URL
 */

export type FeedbackType = 'read' | 'skip' | 'save' | 'love' | 'meh';

export interface ParsedFeedback {
  feedbackType: FeedbackType;
  arxivId: string;     // normalised, no version suffix, no prefix
  notes: string | null;
  reason: string | null;
  priority: number | null;  // for /save only
  raw: string;              // original message text
}

export interface ParseResultOk {
  ok: true;
  feedback: ParsedFeedback;
}

export interface ParseResultError {
  ok: false;
  error: 'not_a_command' | 'unknown_command' | 'missing_arxiv_id' | 'invalid_arxiv_id';
  message: string;
}

export type ParseResult = ParseResultOk | ParseResultError;

// Arxiv ID regex: 4-digit year-month + 4-5 digits + optional version
const ARXIV_ID_RE = /\b(\d{4}\.\d{4,5})(v\d+)?\b/;

// Full URL pattern
const ARXIV_URL_RE = /https?:\/\/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(v\d+)?/;

// Prefixed pattern: arxiv:2403.12345
const ARXIV_PREFIX_RE = /\barxiv:(\d{4}\.\d{4,5})(v\d+)?\b/i;

const FEEDBACK_COMMANDS: Set<string> = new Set(['read', 'skip', 'save', 'love', 'meh']);

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
 * e.g. "--notes 'This is great' --priority 8"
 */
function parseFlags(flagStr: string): { notes: string | null; reason: string | null; priority: number | null } {
  let notes: string | null = null;
  let reason: string | null = null;
  let priority: number | null = null;

  // Match --key "value" or --key 'value' or --key value-until-next-flag
  const flagRe = /--(\w+)\s+(?:"([^"]*?)"|'([^']*?)'|(\S+))/g;
  let m: RegExpExecArray | null;

  while ((m = flagRe.exec(flagStr)) !== null) {
    const key = m[1]!;
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    if (key === 'notes') notes = val;
    else if (key === 'reason') reason = val;
    else if (key === 'priority') {
      const n = parseInt(val, 10);
      if (!isNaN(n) && n >= 1 && n <= 10) priority = n;
    }
  }

  return { notes, reason, priority };
}

/**
 * Parse a Signal message and return structured feedback, or an error.
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

  if (!FEEDBACK_COMMANDS.has(command)) {
    return {
      ok: false,
      error: 'unknown_command',
      message: `Unknown command: /${command}. Supported: /read /skip /save /love /meh`,
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
