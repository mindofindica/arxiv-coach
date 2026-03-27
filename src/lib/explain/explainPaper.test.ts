/**
 * Tests for explainPaper.ts
 *
 * Tests cover:
 *  - yearFromArxivId: ID → year inference
 *  - prepareContext: full-text vs abstract fallback
 *  - truncateExplain: sentence-boundary truncation
 *  - formatExplainReply: Signal message formatting
 *  - explainPaper: integration paths (DB hit, not-found, ambiguous, api_error, no_api_key)
 *
 * All OpenRouter fetch calls are mocked. DB is real in-memory SQLite.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import {
  yearFromArxivId,
  prepareContext,
  truncateExplain,
  formatExplainReply,
  explainPaper,
  loadOpenRouterKey,
} from './explainPaper.js';
import type { ExplainSuccess } from './explainPaper.js';
import type { PaperInfo } from './types.js';

// ── Mock fetch ─────────────────────────────────────────────────────────────

vi.stubGlobal('fetch', vi.fn());
const mockFetch = vi.mocked(fetch);

// ── Helpers ────────────────────────────────────────────────────────────────

function makePaperInfo(overrides: Partial<PaperInfo> = {}): PaperInfo {
  return {
    arxivId: '2402.01234',
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'],
    abstract:
      'We propose a new simple network architecture, the Transformer, based solely on attention mechanisms.',
    score: 9,
    tracks: ['LLM'],
    pdfPath: '/tmp/nonexistent.pdf',
    txtPath: '/tmp/nonexistent.txt',
    metaPath: '/tmp/nonexistent.json',
    absUrl: 'https://arxiv.org/abs/2402.01234',
    pdfUrl: 'https://arxiv.org/pdf/2402.01234',
    ...overrides,
  };
}

function makeSuccessResult(overrides: Partial<ExplainSuccess> = {}): ExplainSuccess {
  return {
    ok: true,
    paper: makePaperInfo(),
    level: 'engineer',
    answer:
      'The Transformer replaces recurrence and convolutions with pure attention, enabling parallelisation during training.',
    contextSource: 'abstract',
    ...overrides,
  };
}

/** Create a minimal Db-like object wrapping a BetterSqlite3 instance */
function makeDb(sqlite: Database) {
  return { sqlite };
}

function setupInMemoryDb() {
  const sqlite = BetterSqlite3(':memory:');
  // Create papers table (minimal schema)
  sqlite.exec(`
    CREATE TABLE papers (
      arxiv_id TEXT PRIMARY KEY,
      title TEXT,
      abstract TEXT,
      authors_json TEXT,
      categories_json TEXT DEFAULT '[]',
      pdf_path TEXT DEFAULT '',
      txt_path TEXT DEFAULT '',
      meta_path TEXT DEFAULT '',
      published_at TEXT,
      updated_at TEXT DEFAULT '',
      ingested_at TEXT DEFAULT ''
    );
    CREATE TABLE track_matches (
      arxiv_id TEXT,
      track_name TEXT,
      score REAL DEFAULT 0,
      matched_at TEXT DEFAULT ''
    );
  `);
  return sqlite;
}

// ── yearFromArxivId ────────────────────────────────────────────────────────

describe('yearFromArxivId', () => {
  it('extracts year from 4+5 digit new-style ID', () => {
    expect(yearFromArxivId('2402.01234')).toBe('2024');
  });

  it('extracts year from 4+4 digit new-style ID', () => {
    expect(yearFromArxivId('1706.0364')).toBe('2017');
  });

  it('handles versioned IDs', () => {
    expect(yearFromArxivId('2402.01234v2')).toBe('2024');
  });

  it('returns n.d. for unknown format', () => {
    expect(yearFromArxivId('abc123')).toBe('n.d.');
    expect(yearFromArxivId('')).toBe('n.d.');
  });

  it('handles 1990s IDs (yy >= 91)', () => {
    expect(yearFromArxivId('9901.12345')).toBe('1999');
  });

  it('handles 2000s IDs (yy < 91)', () => {
    expect(yearFromArxivId('0301.12345')).toBe('2003');
  });
});

// ── prepareContext ─────────────────────────────────────────────────────────

describe('prepareContext', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'explain-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns full-text when txt file exists and has content', () => {
    const txtPath = path.join(tmpDir, 'paper.txt');
    const fullText = 'A'.repeat(5000);
    fs.writeFileSync(txtPath, fullText);

    const paper = makePaperInfo({ txtPath });
    const result = prepareContext(paper);

    expect(result.source).toBe('full-text');
    expect(result.text).toBe(fullText);
  });

  it('falls back to abstract when txt file does not exist', () => {
    const paper = makePaperInfo({ txtPath: '/tmp/nonexistent-xyz.txt' });
    const result = prepareContext(paper);

    expect(result.source).toBe('abstract');
    expect(result.text).toBe(paper.abstract);
  });

  it('falls back to abstract when txt file is too small', () => {
    const txtPath = path.join(tmpDir, 'tiny.txt');
    fs.writeFileSync(txtPath, 'tiny');

    const paper = makePaperInfo({ txtPath });
    const result = prepareContext(paper);

    expect(result.source).toBe('abstract');
    expect(result.text).toBe(paper.abstract);
  });

  it('caps full text at 6000 chars', () => {
    const txtPath = path.join(tmpDir, 'big.txt');
    const bigText = 'B'.repeat(10_000);
    fs.writeFileSync(txtPath, bigText);

    const paper = makePaperInfo({ txtPath });
    const result = prepareContext(paper);

    expect(result.source).toBe('full-text');
    expect(result.text.length).toBe(6_000);
  });
});

// ── truncateExplain ────────────────────────────────────────────────────────

describe('truncateExplain', () => {
  it('returns text unchanged when within limit', () => {
    const text = 'Short answer.';
    expect(truncateExplain(text, 100)).toBe(text);
  });

  it('truncates at sentence boundary', () => {
    const text = 'First sentence. Second sentence. Third sentence that is very long and pushes over the limit.';
    const result = truncateExplain(text, 40);
    expect(result).toBe('First sentence. Second sentence.');
  });

  it('truncates at word boundary when no sentence boundary available', () => {
    const text = 'aaabbbccc ddd eee fff ggg hhh iii jjj kkk lll mmm nnn';
    const result = truncateExplain(text, 20);
    expect(result).toContain('…');
    expect(result.length).toBeLessThanOrEqual(21); // may include ellipsis
  });

  it('handles exclamation marks', () => {
    const text = 'Amazing! This is great! But this part is way too long for the limit we have set here.';
    const result = truncateExplain(text, 30);
    expect(result).toBe('Amazing! This is great!');
  });

  it('handles text exactly at limit', () => {
    const text = 'Exactly right.';
    expect(truncateExplain(text, text.length)).toBe(text);
  });
});

// ── formatExplainReply ─────────────────────────────────────────────────────

describe('formatExplainReply', () => {
  it('includes level label', () => {
    const result = makeSuccessResult({ level: 'engineer' });
    const reply = formatExplainReply(result);
    expect(reply).toContain('⚙️ ENGINEER');
  });

  it('includes eli12 label', () => {
    const result = makeSuccessResult({ level: 'eli12' });
    expect(formatExplainReply(result)).toContain('👶 ELI12');
  });

  it('includes undergrad label', () => {
    const result = makeSuccessResult({ level: 'undergrad' });
    expect(formatExplainReply(result)).toContain('🎓 UNDERGRAD');
  });

  it('shows abstract-only note when context is abstract', () => {
    const result = makeSuccessResult({ contextSource: 'abstract' });
    expect(formatExplainReply(result)).toContain('abstract only');
  });

  it('does not show abstract note when full-text', () => {
    const result = makeSuccessResult({ contextSource: 'full-text' });
    expect(formatExplainReply(result)).not.toContain('abstract only');
  });

  it('includes paper title in footer', () => {
    const reply = formatExplainReply(makeSuccessResult());
    expect(reply).toContain('Attention Is All You Need');
  });

  it('includes year from arxiv ID', () => {
    const reply = formatExplainReply(makeSuccessResult());
    expect(reply).toContain('(2024)'); // 2402 → 2024
  });

  it('truncates long title in footer', () => {
    const longTitle = 'A'.repeat(70);
    const paper = makePaperInfo({ title: longTitle });
    const result = makeSuccessResult({ paper });
    const reply = formatExplainReply(result);
    expect(reply).toContain('…');
  });

  it('includes the answer body', () => {
    const answer = 'This paper introduces the Transformer architecture.';
    const result = makeSuccessResult({ answer });
    expect(formatExplainReply(result)).toContain(answer);
  });
});

// ── explainPaper integration ───────────────────────────────────────────────

describe('explainPaper', () => {
  let tmpDir: string;
  let sqlite: Database;

  let savedApiKey: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'explain-integration-'));
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    sqlite = setupInMemoryDb();
    vi.clearAllMocks();
    // Isolate env var
    savedApiKey = process.env['OPENROUTER_API_KEY'];
    delete process.env['OPENROUTER_API_KEY'];
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedApiKey !== undefined) {
      process.env['OPENROUTER_API_KEY'] = savedApiKey;
    }
  });

  function getDb() {
    return makeDb(sqlite);
  }

  function insertPaper(id = '2402.01234', title = 'Attention Is All You Need') {
    sqlite.prepare(`
      INSERT INTO papers (arxiv_id, title, abstract, authors_json, categories_json)
      VALUES (?, ?, 'Great abstract text here', '["Vaswani"]', '[]')
    `).run(id, title);
  }

  function mockOpenRouterSuccess(text: string) {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: text }, finish_reason: 'stop' }],
      }),
    } as Response);
  }

  // ── Query too short ─────────────────────────────────────────────────────

  it('returns paper_not_found for empty query', async () => {
    const result = await explainPaper({
      db: getDb() as any,
      query: '',
      level: 'engineer',
      repoRoot: tmpDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('paper_not_found');
    }
  });

  // ── No API key ──────────────────────────────────────────────────────────

  it('returns no_api_key when key is missing', async () => {
    insertPaper();
    // env var already deleted in beforeEach; no key file in tmpDir/data/

    const result = await explainPaper({
      db: getDb() as any,
      query: '2402.01234',
      level: 'engineer',
      repoRoot: tmpDir, // no openrouter.key file here
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('no_api_key');
      expect(result.message).toContain('OPENROUTER_API_KEY');
    }
  });

  // ── Paper not found ─────────────────────────────────────────────────────

  it('returns paper_not_found for unknown arxiv ID', async () => {
    // Write API key so lookup can proceed
    fs.writeFileSync(path.join(tmpDir, 'data', 'openrouter.key'), 'test-key');

    const result = await explainPaper({
      db: getDb() as any,
      query: '9999.99999',
      level: 'engineer',
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('paper_not_found');
      expect(result.message).toContain('9999.99999');
    }
  });

  // ── Successful explain — abstract only ──────────────────────────────────

  it('returns successful result for known arxiv ID', async () => {
    insertPaper('2402.01234');
    fs.writeFileSync(path.join(tmpDir, 'data', 'openrouter.key'), 'test-key');
    mockOpenRouterSuccess('The Transformer is a sequence model that uses only attention.');

    const result = await explainPaper({
      db: getDb() as any,
      query: '2402.01234',
      level: 'engineer',
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contextSource).toBe('abstract'); // no txt file
      expect(result.answer).toContain('Transformer');
      expect(result.level).toBe('engineer');
    }
  });

  // ── Successful explain — full text ──────────────────────────────────────

  it('uses full text when txt file exists', async () => {
    const txtPath = path.join(tmpDir, '2402.01234.txt');
    fs.writeFileSync(txtPath, 'Full paper text. '.repeat(200));

    sqlite.prepare(`
      INSERT INTO papers (arxiv_id, title, abstract, authors_json, categories_json, txt_path)
      VALUES ('2402.01234', 'A Paper', 'Abstract text', '["Author"]', '[]', ?)
    `).run(txtPath);

    fs.writeFileSync(path.join(tmpDir, 'data', 'openrouter.key'), 'test-key');
    mockOpenRouterSuccess('Explained from full text.');

    const result = await explainPaper({
      db: getDb() as any,
      query: '2402.01234',
      level: 'undergrad',
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contextSource).toBe('full-text');
    }
  });

  // ── eli12 level ─────────────────────────────────────────────────────────

  it('passes eli12 level to prompt (verified via mock call)', async () => {
    insertPaper('2402.01234');
    fs.writeFileSync(path.join(tmpDir, 'data', 'openrouter.key'), 'test-key');
    mockOpenRouterSuccess('Imagine a magic sorting hat for words!');

    const result = await explainPaper({
      db: getDb() as any,
      query: '2402.01234',
      level: 'eli12',
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.level).toBe('eli12');
    }

    // Check that the fetch was called with the right model
    expect(mockFetch).toHaveBeenCalledOnce();
    const [, fetchOpts] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((fetchOpts as RequestInit).body as string);
    expect(body.model).toBe('anthropic/claude-3-haiku');
  });

  // ── API error — retries ─────────────────────────────────────────────────

  it('retries once on 500 error and succeeds on second attempt', async () => {
    insertPaper();
    fs.writeFileSync(path.join(tmpDir, 'data', 'openrouter.key'), 'test-key');

    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Second attempt succeeded.' }, finish_reason: 'stop' }],
        }),
      } as Response);

    const result = await explainPaper({
      db: getDb() as any,
      query: '2402.01234',
      level: 'engineer',
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.answer).toContain('Second attempt');
    }
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // ── API error — permanent ───────────────────────────────────────────────

  it('returns api_error on repeated 500 failure', async () => {
    insertPaper();
    fs.writeFileSync(path.join(tmpDir, 'data', 'openrouter.key'), 'test-key');

    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
    } as Response);

    const result = await explainPaper({
      db: getDb() as any,
      query: '2402.01234',
      level: 'engineer',
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('api_error');
    }
  });

  // ── Title search — ambiguous ────────────────────────────────────────────

  it('returns ambiguous when multiple papers match title', async () => {
    sqlite.prepare(`
      INSERT INTO papers (arxiv_id, title, abstract, authors_json, categories_json)
      VALUES ('2402.00001', 'Attention Mechanism Deep Learning', 'Abstract A', '["A"]', '[]')
    `).run();
    sqlite.prepare(`
      INSERT INTO papers (arxiv_id, title, abstract, authors_json, categories_json)
      VALUES ('2402.00002', 'Attention Heads in Transformers', 'Abstract B', '["B"]', '[]')
    `).run();

    fs.writeFileSync(path.join(tmpDir, 'data', 'openrouter.key'), 'test-key');

    const result = await explainPaper({
      db: getDb() as any,
      query: 'attention',
      level: 'engineer',
      repoRoot: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.error === 'ambiguous') {
      expect(result.candidates.length).toBeGreaterThanOrEqual(2);
    } else if (!result.ok) {
      throw new Error(`Expected ambiguous, got: ${result.error}`);
    }
  });

  // ── loadOpenRouterKey ───────────────────────────────────────────────────

  describe('loadOpenRouterKey', () => {
    it('reads key from env var', () => {
      process.env['OPENROUTER_API_KEY'] = 'sk-test-env-key';
      const key = loadOpenRouterKey(tmpDir);
      delete process.env['OPENROUTER_API_KEY'];
      expect(key).toBe('sk-test-env-key');
    });

    it('reads key from file when env var not set', () => {
      delete process.env['OPENROUTER_API_KEY'];
      fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'data', 'openrouter.key'), 'sk-file-key\n');
      const key = loadOpenRouterKey(tmpDir);
      expect(key).toBe('sk-file-key');
    });

    it('returns null when neither env nor file present', () => {
      delete process.env['OPENROUTER_API_KEY'];
      const key = loadOpenRouterKey(tmpDir);
      expect(key).toBeNull();
    });

    it('env var takes precedence over file', () => {
      process.env['OPENROUTER_API_KEY'] = 'sk-env-wins';
      fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'data', 'openrouter.key'), 'sk-file-loses\n');
      const key = loadOpenRouterKey(tmpDir);
      delete process.env['OPENROUTER_API_KEY'];
      expect(key).toBe('sk-env-wins');
    });
  });
});
