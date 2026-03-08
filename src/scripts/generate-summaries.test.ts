import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  VARIANT_PROMPTS,
  buildUserMessage,
  fetchPapersByArxivIds,
  loadOpenRouterKeyFromProfiles,
  loadScoredPapersFromDb,
  loadWeeklyShortlistArxivIds,
  mergePapers,
  processPaper,
  runGenerateSummaries,
  type PaperRecord,
  type VariantName,
} from './generate-summaries.js';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'generate-summaries-'));
}

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function seedDb(dbPath: string) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE papers (
      arxiv_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      abstract TEXT NOT NULL,
      authors_json TEXT NOT NULL,
      categories_json TEXT NOT NULL,
      published_at TEXT NOT NULL
    );
    CREATE TABLE llm_scores (
      arxiv_id TEXT PRIMARY KEY,
      relevance_score INTEGER NOT NULL,
      scored_at TEXT NOT NULL
    );
  `);
  return db;
}

const samplePaper: PaperRecord = {
  arxivId: '2501.12345',
  title: 'Efficient Agentic Retrieval for LLM Systems',
  abstract: 'We present a method that improves retrieval quality with lower latency.',
  authors: ['Alice Smith', 'Bob Jones'],
  categories: ['cs.AI', 'cs.CL'],
  publishedAt: '2026-03-07',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generate-summaries helpers', () => {
  it('extracts nested arXiv IDs from weekly shortlist JSON', () => {
    const dir = mkTmpDir();
    const shortlistPath = path.join(dir, 'weekly-shortlist.json');

    writeJson(shortlistPath, {
      candidates: [
        { arxivId: '2501.00001' },
        { paper: { arxiv_id: '2501.00002' } },
      ],
      metadata: {
        primary: { arxivId: '2501.00003' },
      },
    });

    const ids = loadWeeklyShortlistArxivIds(shortlistPath);
    expect([...ids].sort()).toEqual(['2501.00001', '2501.00002', '2501.00003']);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty shortlist set when file is missing', () => {
    const ids = loadWeeklyShortlistArxivIds('/tmp/does-not-exist.json');
    expect(ids.size).toBe(0);
  });

  it('loads OpenRouter key from lastGood profile', () => {
    const dir = mkTmpDir();
    const profilesPath = path.join(dir, 'auth-profiles.json');

    writeJson(profilesPath, {
      profiles: {
        'openrouter:default': { provider: 'openrouter', key: 'sk-or-key-123' },
      },
      lastGood: {
        openrouter: 'openrouter:default',
      },
    });

    expect(loadOpenRouterKeyFromProfiles(profilesPath)).toBe('sk-or-key-123');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('builds the required user message format', () => {
    const msg = buildUserMessage(samplePaper);
    expect(msg).toContain('Title: Efficient Agentic Retrieval for LLM Systems');
    expect(msg).toContain('Authors: Alice Smith, Bob Jones');
    expect(msg).toContain('Abstract: We present a method');
  });

  it('deduplicates papers by arxivId when merging', () => {
    const merged = mergePapers(
      [samplePaper],
      [{ ...samplePaper, title: 'Updated title from weekly shortlist' }]
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toBe('Updated title from weekly shortlist');
  });
});

describe('database loading', () => {
  it('loads only papers scored >=3 in the last 2 days', () => {
    const dir = mkTmpDir();
    const dbPath = path.join(dir, 'db.sqlite');
    const db = seedDb(dbPath);

    const now = new Date('2026-03-08T12:00:00.000Z');
    const recent = new Date('2026-03-07T10:00:00.000Z').toISOString();
    const old = new Date('2026-03-01T10:00:00.000Z').toISOString();

    db.prepare(
      'INSERT INTO papers (arxiv_id,title,abstract,authors_json,categories_json,published_at) VALUES (?,?,?,?,?,?)'
    ).run('2501.00001', 'Good Paper', 'A', '["A"]', '["cs.AI"]', now.toISOString());
    db.prepare(
      'INSERT INTO papers (arxiv_id,title,abstract,authors_json,categories_json,published_at) VALUES (?,?,?,?,?,?)'
    ).run('2501.00002', 'Low Score Paper', 'B', '["B"]', '["cs.AI"]', now.toISOString());
    db.prepare(
      'INSERT INTO papers (arxiv_id,title,abstract,authors_json,categories_json,published_at) VALUES (?,?,?,?,?,?)'
    ).run('2501.00003', 'Old Score Paper', 'C', '["C"]', '["cs.AI"]', now.toISOString());

    db.prepare('INSERT INTO llm_scores (arxiv_id,relevance_score,scored_at) VALUES (?,?,?)').run('2501.00001', 4, recent);
    db.prepare('INSERT INTO llm_scores (arxiv_id,relevance_score,scored_at) VALUES (?,?,?)').run('2501.00002', 2, recent);
    db.prepare('INSERT INTO llm_scores (arxiv_id,relevance_score,scored_at) VALUES (?,?,?)').run('2501.00003', 5, old);

    db.close();

    const rows = loadScoredPapersFromDb(dbPath, now);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.arxivId).toBe('2501.00001');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fetches papers by explicit arxiv IDs', () => {
    const dir = mkTmpDir();
    const dbPath = path.join(dir, 'db.sqlite');
    const db = seedDb(dbPath);

    db.prepare(
      'INSERT INTO papers (arxiv_id,title,abstract,authors_json,categories_json,published_at) VALUES (?,?,?,?,?,?)'
    ).run('2501.11111', 'Wanted', 'Wanted abstract', '["A"]', '["cs.AI"]', '2026-03-07');
    db.prepare(
      'INSERT INTO papers (arxiv_id,title,abstract,authors_json,categories_json,published_at) VALUES (?,?,?,?,?,?)'
    ).run('2501.22222', 'Other', 'Other abstract', '["B"]', '["cs.CL"]', '2026-03-07');

    db.close();

    const rows = fetchPapersByArxivIds(dbPath, ['2501.11111']);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Wanted');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('variant generation behavior', () => {
  it('skips already-generated variants', async () => {
    const variants = Object.keys(VARIANT_PROMPTS) as VariantName[];
    const existing = new Set<VariantName>(['tldr', 'card_summary']);

    const generateVariantContent = vi.fn(async (_paper: PaperRecord, variant: VariantName) => `generated-${variant}`);
    const upsertContent = vi.fn(async () => undefined);

    const result = await processPaper(samplePaper, {
      fetchImpl: fetch,
      sleep: async () => undefined,
      log: console,
      getExistingVariants: async () => existing as Set<string>,
      upsertPaper: async () => undefined,
      upsertContent,
      generateVariantContent,
    });

    expect(result.skipped).toBe(2);
    expect(result.generated).toBe(variants.length - 2);
    expect(generateVariantContent).toHaveBeenCalledTimes(variants.length - 2);
    expect(upsertContent).toHaveBeenCalledTimes(variants.length - 2);
  });

  it('generates all 8 variants for a new paper', async () => {
    const variants = Object.keys(VARIANT_PROMPTS) as VariantName[];

    const generateVariantContent = vi.fn(async (_paper: PaperRecord, variant: VariantName) => `generated-${variant}`);
    const upsertContent = vi.fn(async () => undefined);

    const result = await processPaper(samplePaper, {
      fetchImpl: fetch,
      sleep: async () => undefined,
      log: console,
      getExistingVariants: async () => new Set(),
      upsertPaper: async () => undefined,
      upsertContent,
      generateVariantContent,
    });

    expect(result.generated).toBe(8);
    expect(result.skipped).toBe(0);
    expect(generateVariantContent).toHaveBeenCalledTimes(8);
    expect(upsertContent).toHaveBeenCalledTimes(8);
    expect(variants).toHaveLength(8);
  });

  it('continues when one variant generation fails', async () => {
    const generateVariantContent = vi.fn(async (_paper: PaperRecord, variant: VariantName) => {
      if (variant === 'how_it_works') {
        throw new Error('simulated OpenRouter error');
      }
      return `generated-${variant}`;
    });

    const upsertContent = vi.fn(async () => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await processPaper(samplePaper, {
      fetchImpl: fetch,
      sleep: async () => undefined,
      log: console,
      getExistingVariants: async () => new Set(),
      upsertPaper: async () => undefined,
      upsertContent,
      generateVariantContent,
    });

    expect(result.generated).toBe(7);
    expect(result.skipped).toBe(0);
    expect(upsertContent).toHaveBeenCalledTimes(7);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('runGenerateSummaries returns summary and no generation when no API key is available', async () => {
    const dir = mkTmpDir();
    const dbPath = path.join(dir, 'db.sqlite');
    const profilesPath = path.join(dir, 'auth-profiles.json');

    const db = seedDb(dbPath);
    const recent = new Date('2026-03-08T10:00:00.000Z').toISOString();
    db.prepare(
      'INSERT INTO papers (arxiv_id,title,abstract,authors_json,categories_json,published_at) VALUES (?,?,?,?,?,?)'
    ).run('2501.33333', 'Scored paper', 'Abstract', '["A"]', '["cs.AI"]', '2026-03-08');
    db.prepare('INSERT INTO llm_scores (arxiv_id,relevance_score,scored_at) VALUES (?,?,?)').run('2501.33333', 4, recent);
    db.close();

    writeJson(profilesPath, { profiles: {} });

    const summary = await runGenerateSummaries({
      dbPaths: [dbPath],
      authProfilesPath: profilesPath,
      now: new Date('2026-03-08T12:00:00.000Z'),
      deps: {
        getExistingVariants: async () => new Set(),
        upsertPaper: async () => undefined,
        upsertContent: async () => undefined,
        generateVariantContent: async () => 'x',
      },
    });

    expect(summary.ok).toBe(true);
    expect(summary.papersProcessed).toBe(1);
    expect(summary.variantsGenerated).toBe(0);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
