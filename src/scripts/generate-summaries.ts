import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

export interface PaperRecord {
  arxivId: string;
  title: string;
  abstract: string;
  authors: string[];
  categories: string[];
  publishedAt: string | null;
}

export interface RunSummary {
  ok: boolean;
  papersProcessed: number;
  variantsGenerated: number;
  skipped: number;
}

interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
}

interface RunDeps {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: Pick<typeof console, 'error' | 'warn' | 'log'>;
  getExistingVariants: (arxivId: string) => Promise<Set<string>>;
  upsertPaper: (paper: PaperRecord) => Promise<void>;
  upsertContent: (arxivId: string, variant: string, content: string) => Promise<void>;
  generateVariantContent: (paper: PaperRecord, variant: VariantName) => Promise<string>;
}

const SYSTEM_PROMPT = 'You are a precise research paper summarizer. Be concise and accurate.';

export const VARIANT_PROMPTS = {
  explain_eli12: "Explain this research paper to a curious 12-year-old in 3-4 short paragraphs. Use simple words, analogies, and avoid jargon.",
  explain_undergrad: 'Explain this research paper to a third-year computer science undergraduate. Cover the problem, approach, and key findings in clear technical but accessible language.',
  explain_engineer: 'Explain this research paper to a senior software engineer who works on LLM/AI systems. Be precise, technical, and focus on practical implications and implementation details.',
  tldr: 'Write a TL;DR for this paper in exactly 2-3 sentences. Cover what it does and why it matters.',
  key_ideas: 'List the 3-5 key contributions or ideas of this paper as concise bullet points (one sentence each).',
  how_it_works: 'Describe the technical approach and methodology of this paper in 400-600 words. Be specific about the architecture, algorithms, or methods used.',
  why_it_matters: 'In 2-3 paragraphs, explain why this paper matters for engineers building LLM systems, AI agents, or retrieval-augmented generation systems. Be specific about practical applications.',
  card_summary: 'Write a single short paragraph (60-80 words) that would appear on a paper card in a research feed. Make it engaging and highlight the most interesting aspect.',
} as const;

export type VariantName = keyof typeof VARIANT_PROMPTS;

const DB_PATH_PRIMARY = '/root/.openclaw/state/arxiv-coach/papers.db';
const DB_PATH_FALLBACK = '/root/.openclaw/state/arxiv-coach/db.sqlite';
const WEEKLY_SHORTLIST_PATH = '/root/.openclaw/state/arxiv-coach/weekly-shortlist.json';
const AUTH_PROFILES_PATH = '/root/.openclaw/agents/main/agent/auth-profiles.json';

const SUPABASE_URL_DEFAULT = 'https://otekgfkmkrpwidqjslmo.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY_DEFAULT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im90ZWtnZmtta3Jwd2lkcWpzbG1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDM4OTQxMywiZXBweCI6MjA4NTk2NTQxM30.zC2eYw-blNee95tkrEGlVMzWEYvpofiAyB3StWT2eAY';

function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
  }

  if (typeof raw !== 'string' || !raw.trim()) {
    return [];
  }

  const value = raw.trim();

  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
      }
    } catch {
      // fall through and parse as comma-separated list.
    }
  }

  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function toIsoDate(input: unknown): string | null {
  if (typeof input !== 'string' || !input.trim()) return null;

  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return null;

  return parsed.toISOString().slice(0, 10);
}

function getPaperColumns(db: Database.Database): Set<string> {
  const cols = db.prepare("PRAGMA table_info('papers')").all() as Array<{ name: string }>;
  return new Set(cols.map((c) => c.name));
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(tableName) as
    | { name: string }
    | undefined;
  return Boolean(row?.name);
}

function normalizePaperRow(row: Record<string, unknown>): PaperRecord | null {
  const arxivId = typeof row.arxiv_id === 'string' ? row.arxiv_id : null;
  const title = typeof row.title === 'string' ? row.title : null;
  const abstract = typeof row.abstract === 'string' ? row.abstract : null;

  if (!arxivId || !title || !abstract) return null;

  return {
    arxivId,
    title,
    abstract,
    authors: parseStringArray(row.authors_raw),
    categories: parseStringArray(row.categories_raw),
    publishedAt: toIsoDate(row.published_at),
  };
}

export function loadScoredPapersFromDb(dbPath: string, now = new Date()): PaperRecord[] {
  if (!fs.existsSync(dbPath)) return [];
  const stat = fs.statSync(dbPath);
  if (stat.size <= 0) return [];

  const db = new Database(dbPath, { readonly: true });

  try {
    if (!tableExists(db, 'papers') || !tableExists(db, 'llm_scores')) return [];

    const paperColumns = getPaperColumns(db);
    const authorsExpr = paperColumns.has('authors_json')
      ? 'p.authors_json'
      : paperColumns.has('authors')
        ? 'p.authors'
        : "'[]'";
    const categoriesExpr = paperColumns.has('categories_json')
      ? 'p.categories_json'
      : paperColumns.has('categories')
        ? 'p.categories'
        : "'[]'";

    const since = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();

    const rows = db
      .prepare(
        `SELECT
          p.arxiv_id,
          p.title,
          p.abstract,
          p.published_at,
          ${authorsExpr} as authors_raw,
          ${categoriesExpr} as categories_raw
        FROM papers p
        JOIN llm_scores ls ON ls.arxiv_id = p.arxiv_id
        WHERE ls.relevance_score >= 3
          AND ls.scored_at >= ?
        ORDER BY ls.scored_at DESC`
      )
      .all(since) as Array<Record<string, unknown>>;

    return rows.map(normalizePaperRow).filter((r): r is PaperRecord => r !== null);
  } finally {
    db.close();
  }
}

function collectArxivIds(value: unknown, sink: Set<string>) {
  if (!value) return;

  if (Array.isArray(value)) {
    for (const item of value) collectArxivIds(item, sink);
    return;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const id = obj.arxivId ?? obj.arxiv_id;
    if (typeof id === 'string' && id.trim()) {
      sink.add(id.trim());
    }

    for (const nested of Object.values(obj)) {
      collectArxivIds(nested, sink);
    }
  }
}

export function loadWeeklyShortlistArxivIds(filePath: string): Set<string> {
  if (!fs.existsSync(filePath)) return new Set();

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    const out = new Set<string>();
    collectArxivIds(raw, out);
    return out;
  } catch {
    return new Set();
  }
}

export function fetchPapersByArxivIds(dbPath: string, arxivIds: string[]): PaperRecord[] {
  if (!fs.existsSync(dbPath) || arxivIds.length === 0) return [];
  const stat = fs.statSync(dbPath);
  if (stat.size <= 0) return [];

  const db = new Database(dbPath, { readonly: true });

  try {
    if (!tableExists(db, 'papers')) return [];

    const paperColumns = getPaperColumns(db);
    const authorsExpr = paperColumns.has('authors_json')
      ? 'authors_json'
      : paperColumns.has('authors')
        ? 'authors'
        : "'[]'";
    const categoriesExpr = paperColumns.has('categories_json')
      ? 'categories_json'
      : paperColumns.has('categories')
        ? 'categories'
        : "'[]'";

    const placeholders = arxivIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT
          arxiv_id,
          title,
          abstract,
          published_at,
          ${authorsExpr} as authors_raw,
          ${categoriesExpr} as categories_raw
        FROM papers
        WHERE arxiv_id IN (${placeholders})`
      )
      .all(...arxivIds) as Array<Record<string, unknown>>;

    return rows.map(normalizePaperRow).filter((r): r is PaperRecord => r !== null);
  } finally {
    db.close();
  }
}

export function loadOpenRouterKeyFromProfiles(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      profiles?: Record<string, { provider?: string; key?: string; apiKey?: string; token?: string }>;
      lastGood?: Record<string, string>;
    };

    const profiles = raw.profiles ?? {};

    const preferredProfileName = raw.lastGood?.openrouter;
    if (preferredProfileName && profiles[preferredProfileName]) {
      const preferred = profiles[preferredProfileName]!;
      if (typeof preferred.apiKey === 'string' && preferred.apiKey.trim()) return preferred.apiKey.trim();
      if (typeof preferred.key === 'string' && preferred.key.trim()) return preferred.key.trim();
      if (typeof preferred.token === 'string' && preferred.token.trim()) return preferred.token.trim();
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

export function buildUserMessage(paper: PaperRecord): string {
  return [
    `Title: ${paper.title}`,
    `Authors: ${paper.authors.join(', ')}`,
    `Abstract: ${paper.abstract}`,
  ].join('\n');
}

export async function callOpenRouter(opts: {
  apiKey: string;
  variant: VariantName;
  paper: PaperRecord;
  fetchImpl: typeof fetch;
}): Promise<string> {
  const res = await opts.fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-4-5',
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `${VARIANT_PROMPTS[opts.variant]}\n\n${buildUserMessage(opts.paper)}` },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter error: ${res.status} ${res.statusText} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  };

  const content = data.choices?.[0]?.message?.content;

  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed) return trimmed;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
    if (text) return text;
  }

  throw new Error('OpenRouter response had no content');
}

async function fetchSupabase<T>(opts: {
  cfg: SupabaseConfig;
  path: string;
  fetchImpl: typeof fetch;
  method?: 'GET' | 'POST';
  body?: unknown;
}): Promise<T> {
  const res = await opts.fetchImpl(`${opts.cfg.url}/rest/v1/${opts.path}`, {
    method: opts.method ?? 'GET',
    headers: {
      apikey: opts.cfg.serviceRoleKey,
      Authorization: `Bearer ${opts.cfg.serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  if (!res.ok) {
    throw new Error(`Supabase request failed (${opts.path}): ${res.status} ${res.statusText} ${await res.text()}`);
  }

  if ((opts.method ?? 'GET') === 'GET') {
    return (await res.json()) as T;
  }

  return undefined as T;
}

export function mergePapers(scoredPapers: PaperRecord[], weeklyPapers: PaperRecord[]): PaperRecord[] {
  const map = new Map<string, PaperRecord>();
  for (const paper of [...scoredPapers, ...weeklyPapers]) {
    map.set(paper.arxivId, paper);
  }
  return [...map.values()];
}

export async function processPaper(paper: PaperRecord, deps: RunDeps): Promise<{ generated: number; skipped: number }> {
  await deps.upsertPaper(paper);

  const existingVariants = await deps.getExistingVariants(paper.arxivId);
  let generated = 0;
  let skipped = 0;

  for (const variant of Object.keys(VARIANT_PROMPTS) as VariantName[]) {
    if (existingVariants.has(variant)) {
      skipped += 1;
      continue;
    }

    try {
      const content = await deps.generateVariantContent(paper, variant);
      await deps.upsertContent(paper.arxivId, variant, content);
      generated += 1;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      deps.log.error(`Failed variant ${variant} for ${paper.arxivId}: ${msg}`);
    } finally {
      await deps.sleep(500);
    }
  }

  return { generated, skipped };
}

export async function runGenerateSummaries(opts?: {
  dbPaths?: string[];
  weeklyShortlistPath?: string;
  authProfilesPath?: string;
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  now?: Date;
  deps?: Partial<RunDeps>;
}): Promise<RunSummary> {
  const dbPaths = opts?.dbPaths ?? [DB_PATH_PRIMARY, DB_PATH_FALLBACK];
  const weeklyShortlistPath = opts?.weeklyShortlistPath ?? WEEKLY_SHORTLIST_PATH;
  const authProfilesPath = opts?.authProfilesPath ?? AUTH_PROFILES_PATH;

  const supabaseCfg: SupabaseConfig = {
    url: opts?.supabaseUrl ?? process.env.SUPABASE_URL ?? SUPABASE_URL_DEFAULT,
    serviceRoleKey:
      opts?.supabaseServiceRoleKey ??
      process.env.SUPABASE_SERVICE_ROLE_KEY ??
      process.env.SUPABASE_KEY ??
      SUPABASE_SERVICE_ROLE_KEY_DEFAULT,
  };

  const fetchImpl = opts?.deps?.fetchImpl ?? fetch;
  const sleep = opts?.deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = opts?.deps?.log ?? console;

  const apiKey =
    process.env.OPENROUTER_API_KEY ??
    loadOpenRouterKeyFromProfiles(authProfilesPath) ??
    process.env.ANTHROPIC_API_KEY ??
    '';

  let scoredPapers: PaperRecord[] = [];
  let chosenDbPath: string | null = null;

  for (const dbPath of dbPaths) {
    const rows = loadScoredPapersFromDb(dbPath, opts?.now);
    if (rows.length > 0) {
      scoredPapers = rows;
      chosenDbPath = dbPath;
      break;
    }

    if (!chosenDbPath && fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
      chosenDbPath = dbPath;
    }
  }

  const weeklyIds = [...loadWeeklyShortlistArxivIds(weeklyShortlistPath)];
  const weeklyPapers = chosenDbPath ? fetchPapersByArxivIds(chosenDbPath, weeklyIds) : [];

  const papers = mergePapers(scoredPapers, weeklyPapers);

  if (!apiKey) {
    log.warn('No OpenRouter/Anthropic key found; skipping generation.');
    return {
      ok: true,
      papersProcessed: papers.length,
      variantsGenerated: 0,
      skipped: 0,
    };
  }

  const deps: RunDeps = {
    fetchImpl,
    sleep,
    log,
    getExistingVariants: opts?.deps?.getExistingVariants ?? (async (arxivId: string) => {
      const rows = await fetchSupabase<Array<{ variant: string }>>({
        cfg: supabaseCfg,
        fetchImpl,
        path: `paper_content?select=variant&arxiv_id=eq.${encodeURIComponent(arxivId)}`,
      });
      return new Set(rows.map((row) => row.variant));
    }),
    upsertPaper: opts?.deps?.upsertPaper ?? (async (paper: PaperRecord) => {
      await fetchSupabase<void>({
        cfg: supabaseCfg,
        fetchImpl,
        method: 'POST',
        path: 'papers?on_conflict=arxiv_id',
        body: [
          {
            arxiv_id: paper.arxivId,
            title: paper.title,
            abstract: paper.abstract,
            authors: paper.authors,
            categories: paper.categories,
            published_at: paper.publishedAt,
          },
        ],
      });
    }),
    upsertContent: opts?.deps?.upsertContent ?? (async (arxivId: string, variant: string, content: string) => {
      await fetchSupabase<void>({
        cfg: supabaseCfg,
        fetchImpl,
        method: 'POST',
        path: 'paper_content?on_conflict=arxiv_id,variant',
        body: [
          {
            arxiv_id: arxivId,
            variant,
            content,
            model: 'sonnet',
          },
        ],
      });
    }),
    generateVariantContent: opts?.deps?.generateVariantContent ?? (async (paper: PaperRecord, variant: VariantName) => {
      return callOpenRouter({
        apiKey,
        variant,
        paper,
        fetchImpl,
      });
    }),
  };

  let variantsGenerated = 0;
  let skipped = 0;

  for (const paper of papers) {
    try {
      const result = await processPaper(paper, deps);
      variantsGenerated += result.generated;
      skipped += result.skipped;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Failed processing ${paper.arxivId}: ${msg}`);
    }
  }

  return {
    ok: true,
    papersProcessed: papers.length,
    variantsGenerated,
    skipped,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const summary = await runGenerateSummaries();
  console.log(JSON.stringify(summary));
}
