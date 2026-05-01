/**
 * help.ts — /help command for arxiv-coach Signal interface.
 *
 * Returns a compact command reference for Signal delivery.
 *
 * Design decisions:
 * - /help (no args): compact one-liner per command, grouped by category.
 * - /help <command>: full detail for one command — syntax, flags, examples.
 * - Signal-friendly: no markdown tables, max ~1400 chars for full reference.
 * - Grouped by purpose: feedback → queries → AI → schedule-aware.
 * - Unknown command: suggests closest match or falls back to full list.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface CommandEntry {
  /** Command name without leading slash */
  name: string;
  /** One-liner for the compact /help view (max 60 chars) */
  summary: string;
  /** Usage syntax (shown in detailed view) */
  usage: string;
  /** Optional flags (shown in detailed view) */
  flags?: string[];
  /** Example invocations (shown in detailed view) */
  examples: string[];
  /** Category for grouping */
  category: 'feedback' | 'reading' | 'discovery' | 'ai' | 'info';
}

// ── Command registry ───────────────────────────────────────────────────────

export const COMMANDS: CommandEntry[] = [
  // ── Feedback ──────────────────────────────────────────────────────────
  {
    name: 'read',
    category: 'feedback',
    summary: 'Mark a paper as read (signal +8)',
    usage: '/read <arxiv-id> [--notes text]',
    flags: ['--notes <text>   Add a note'],
    examples: ['/read 2403.12345', '/read 2403.12345 --notes excellent benchmark design'],
  },
  {
    name: 'love',
    category: 'feedback',
    summary: 'Strong positive signal (+10), bumps reading-list priority',
    usage: '/love <arxiv-id> [--notes text]',
    flags: ['--notes <text>   Add a note'],
    examples: ['/love 2403.12345', '/love 2403.12345 --notes must implement this'],
  },
  {
    name: 'save',
    category: 'feedback',
    summary: 'Save to reading list (signal +5)',
    usage: '/save <arxiv-id> [--priority 1-10] [--notes text]',
    flags: ['--priority <n>   Set priority 1-10', '--notes <text>   Add a note'],
    examples: ['/save 2403.12345', '/save 2403.12345 --priority 8 --notes deep dive later'],
  },
  {
    name: 'skip',
    category: 'feedback',
    summary: 'Deprioritise a paper (signal -5)',
    usage: '/skip <arxiv-id> [--reason text]',
    flags: ['--reason <text>  Why you skipped it'],
    examples: ['/skip 2403.12345', '/skip 2403.12345 --reason too theoretical'],
  },
  {
    name: 'meh',
    category: 'feedback',
    summary: 'Weak negative signal (-2)',
    usage: '/meh <arxiv-id> [--notes text]',
    flags: ['--notes <text>   Add a note'],
    examples: ['/meh 2403.12345'],
  },

  // ── Reading list ──────────────────────────────────────────────────────
  {
    name: 'reading-list',
    category: 'reading',
    summary: 'Show saved papers (default: unread, limit 5)',
    usage: '/reading-list [--status unread|read|all] [--limit N]',
    flags: [
      '--status <s>     unread (default) | read | all',
      '--limit <n>      Max results, 1-20 (default 5)',
    ],
    examples: [
      '/reading-list',
      '/reading-list --status all --limit 10',
      '/reading-list --status read',
    ],
  },

  // ── Discovery & stats ─────────────────────────────────────────────────
  {
    name: 'status',
    category: 'info',
    summary: 'System health: last digest, paper count, feedback total',
    usage: '/status',
    examples: ['/status'],
  },
  {
    name: 'stats',
    category: 'info',
    summary: 'Activity breakdown: feedback types, top tracks (7 days)',
    usage: '/stats [--days N]',
    flags: ['--days <n>       Window in days, 1-90 (default 7)'],
    examples: ['/stats', '/stats --days 30'],
  },
  {
    name: 'streak',
    category: 'info',
    summary: 'Reading streak: current/longest + 14-day sparkline',
    usage: '/streak',
    examples: ['/streak'],
  },
  {
    name: 'progress',
    category: 'info',
    summary: 'Weekly learning velocity: this week vs last week trend',
    usage: '/progress',
    examples: ['/progress'],
  },
  {
    name: 'weekly',
    category: 'info',
    summary: 'Weekly paper summary for current (or any) ISO week',
    usage: '/weekly [--week YYYY-Www] [--track name]',
    flags: [
      '--week <w>       ISO week, e.g. 2026-W07 (default: current)',
      '--track <name>   Filter to one track',
    ],
    examples: ['/weekly', '/weekly --week 2026-W07', '/weekly --track RAG'],
  },
  {
    name: 'hottest',
    category: 'discovery',
    summary: 'Top-scored papers across all tracks this week',
    usage: '/hottest [--limit N]',
    flags: ['--limit <n>      Max results (default 5)'],
    examples: ['/hottest', '/hottest --limit 10'],
  },
  {
    name: 'search',
    category: 'discovery',
    summary: 'Full-text search over paper library',
    usage: '/search <query> [--limit N] [--track name] [--from YYYY]',
    flags: [
      '--limit <n>      Max results, 1-10 (default 5)',
      '--track <name>   Filter to one track',
      '--from <year>    Only papers from this year+',
    ],
    examples: [
      '/search speculative decoding',
      '/search RAG --limit 3',
      '/search attention --track LLM --from 2025',
    ],
  },
  {
    name: 'recommend',
    category: 'discovery',
    summary: 'Recommended papers based on your feedback history',
    usage: '/recommend [--limit N]',
    flags: ['--limit <n>      Max recommendations (default 5)'],
    examples: ['/recommend', '/recommend --limit 3'],
  },
  {
    name: 'trends',
    category: 'discovery',
    summary: 'Trending topics and keyword momentum (last 8 weeks)',
    usage: '/trends [--weeks N] [--track name]',
    flags: [
      '--weeks <n>      Lookback window in weeks (default 8)',
      '--track <name>   Filter to one track',
    ],
    examples: ['/trends', '/trends --weeks 4', '/trends --track Agents'],
  },
  {
    name: 'gaps',
    category: 'discovery',
    summary: 'Knowledge gaps — concepts you\'ve encountered but not yet learned',
    usage: '/gaps [--all] [--limit N] [--status identified|lesson_queued|understood]',
    examples: [
      '/gaps',
      '/gaps --all',
      '/gaps --limit 15',
      '/gaps --status understood',
    ],
  },
  {
    name: 'digest',
    category: 'discovery',
    summary: 'On-demand digest of recent top papers',
    usage: '/digest [--min-score N] [--track name]',
    flags: [
      '--min-score <n>  Minimum LLM score 1-5 (default 3)',
      '--track <name>   Filter to one track',
    ],
    examples: ['/digest', '/digest --min-score 4', '/digest --track Agents'],
  },
  {
    name: 'preview',
    category: 'discovery',
    summary: "Preview tomorrow's digest before it sends",
    usage: '/preview [--track name]',
    flags: ['--track <name>   Filter to one track'],
    examples: ['/preview', '/preview --track RAG'],
  },

  // ── AI commands ───────────────────────────────────────────────────────
  {
    name: 'ask',
    category: 'ai',
    summary: 'Ask a question about a specific paper',
    usage: '/ask <arxiv-id> <question>',
    examples: [
      '/ask 2403.12345 what is the key contribution?',
      '/ask 2403.12345 how does it compare to GPT-4?',
    ],
  },
  {
    name: 'explain',
    category: 'ai',
    summary: 'Plain-English explanation of a paper (adjustable level)',
    usage: '/explain <arxiv-id or title> [--level eli12|undergrad|engineer]',
    flags: [
      '--level eli12       Explain like I\'m 12',
      '--level undergrad   Undergraduate level (default)',
      '--level engineer    Technical, for practitioners',
    ],
    examples: [
      '/explain 2403.12345',
      '/explain attention is all you need',
      '/explain 2403.12345 --level eli12',
      '/explain 2403.12345 --level engineer',
    ],
  },
  {
    name: 'note',
    category: 'feedback',
    summary: 'Append a note to an existing paper feedback',
    usage: '/note <arxiv-id> <note text>',
    examples: [
      '/note 2403.12345 connects to the multi-agent memory work',
      '/note 2403.12345 see also Brown et al. 2020 — same trick',
    ],
  },
  {
    name: 'help',
    category: 'info',
    summary: 'Show this command reference',
    usage: '/help [command]',
    examples: ['/help', '/help search', '/help ask'],
  },
];

// ── Formatters ─────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<CommandEntry['category'], string> = {
  feedback: '📝 Paper Feedback',
  reading: '📚 Reading List',
  discovery: '🔍 Discovery',
  ai: '🤖 AI',
  info: 'ℹ️ Info & Stats',
};

const CATEGORY_ORDER: CommandEntry['category'][] = ['feedback', 'reading', 'discovery', 'ai', 'info'];

/**
 * Format the compact /help overview — one line per command, grouped.
 * Target: ≤1400 chars for Signal.
 */
export function formatHelpOverview(): string {
  const grouped = new Map<CommandEntry['category'], CommandEntry[]>();
  for (const cmd of COMMANDS) {
    if (!grouped.has(cmd.category)) grouped.set(cmd.category, []);
    grouped.get(cmd.category)!.push(cmd);
  }

  const sections: string[] = ['📖 arxiv-coach commands\n'];

  for (const cat of CATEGORY_ORDER) {
    const cmds = grouped.get(cat);
    if (!cmds || cmds.length === 0) continue;

    sections.push(CATEGORY_LABELS[cat]);
    for (const cmd of cmds) {
      sections.push(`  /${cmd.name} — ${cmd.summary}`);
    }
    sections.push('');
  }

  sections.push('💡 /help <command> for details\n   e.g. /help search');

  return sections.join('\n');
}

/**
 * Format detailed help for a single command.
 */
export function formatCommandDetail(cmd: CommandEntry): string {
  const lines: string[] = [
    `/${cmd.name}`,
    cmd.summary,
    '',
    `Usage: ${cmd.usage}`,
  ];

  if (cmd.flags && cmd.flags.length > 0) {
    lines.push('');
    lines.push('Flags:');
    for (const flag of cmd.flags) {
      lines.push(`  ${flag}`);
    }
  }

  if (cmd.examples.length > 0) {
    lines.push('');
    lines.push('Examples:');
    for (const ex of cmd.examples) {
      lines.push(`  ${ex}`);
    }
  }

  return lines.join('\n');
}

/**
 * Look up a command by name (case-insensitive, strips leading slash).
 */
export function findCommand(name: string): CommandEntry | null {
  const normalised = name.toLowerCase().replace(/^\//, '');
  return COMMANDS.find((c) => c.name === normalised) ?? null;
}

/**
 * Find the closest command name for a typo/partial match.
 * Returns null if nothing plausible found.
 */
export function findClosestCommand(input: string): CommandEntry | null {
  const normalised = input.toLowerCase().replace(/^\//, '');

  // Prefix match first
  const prefixMatch = COMMANDS.find((c) => c.name.startsWith(normalised));
  if (prefixMatch) return prefixMatch;

  // Substring match
  const subMatch = COMMANDS.find((c) => c.name.includes(normalised) || normalised.includes(c.name));
  return subMatch ?? null;
}

// ── Main entry point ───────────────────────────────────────────────────────

export interface HelpOptions {
  /** Optional command name to look up detail for */
  commandName?: string | null;
}

export interface HelpResult {
  ok: true;
  message: string;
}

/**
 * Main function: return the help text for Signal.
 * - No args → compact overview of all commands
 * - With command name → full detail for that command
 */
export function getHelp(opts: HelpOptions = {}): HelpResult {
  const { commandName } = opts;

  if (!commandName) {
    return { ok: true, message: formatHelpOverview() };
  }

  const cmd = findCommand(commandName);
  if (cmd) {
    return { ok: true, message: formatCommandDetail(cmd) };
  }

  // Not found — suggest closest or fall back to overview
  const closest = findClosestCommand(commandName);
  if (closest) {
    return {
      ok: true,
      message:
        `❓ Unknown command: /${commandName}\n\n` +
        `Did you mean /${closest.name}?\n\n` +
        formatCommandDetail(closest),
    };
  }

  return {
    ok: true,
    message: `❓ Unknown command: /${commandName}\n\n` + formatHelpOverview(),
  };
}
