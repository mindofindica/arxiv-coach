/**
 * Tests for askPaper.ts — the /ask command core library.
 *
 * Uses in-memory SQLite + mocked fetch to avoid any real I/O.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db.js';
import { ensureFeedbackTables } from '../feedback/migrate.js';
import type { Db } from '../db.js';
import {
  lookupPaperInDb,
  fetchPaperFromArxiv,
  buildAskPrompt,
  truncateAnswer,
  formatAskReply,
  loadOpenRouterKey,
  askPaper,
  type PaperContext,
  type AskResult,
} from './askPaper.js';

// ── Test helpers ──────────────────────────────────────────────────────────

function makeTestDb(): Db {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db: Db = { sqlite };
  migrate(db);
  ensureFeedbackTables(db);
  return db;
}

function seedPaper(
  db: Db,
  arxivId: string,
  opts: { title?: string; abstract?: string; authors?: string[]; publishedAt?: string } = {},
): void {
  const {
    title = 'Test Paper',
    abstract = 'This is a test abstract about machine learning.',
    authors = ['Alice', 'Bob'],
    publishedAt = '2024-01-15T00:00:00Z',
  } = opts;
  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO papers
         (arxiv_id, latest_version, title, abstract, authors_json, categories_json,
          published_at, updated_at, pdf_path, txt_path, meta_path, ingested_at)
       VALUES (?, 'v1', ?, ?, ?, '[]', ?, datetime('now'),
               '/tmp/x.pdf', '/tmp/x.txt', '/tmp/x.json', datetime('now'))`,
    )
    .run(arxivId, title, abstract, JSON.stringify(authors), publishedAt);
}

const SAMPLE_PAPER: PaperContext = {
  arxivId: '2402.01234',
  title: 'Attention Is All You Need (Revisited)',
  abstract:
    'We revisit the transformer architecture and demonstrate that attention mechanisms alone suffice for strong language modelling performance.',
  authors: ['Alice Smith', 'Bob Jones', 'Carol Lee'],
  year: '2024',
};

// ── lookupPaperInDb ───────────────────────────────────────────────────────

describe('lookupPaperInDb', () => {
  let db: Db;
  beforeEach(() => { db = makeTestDb(); });

  it('returns paper context when found', () => {
    seedPaper(db, '2402.01234', {
      title: 'My Paper',
      abstract: 'Abstract here.',
      authors: ['Alice', 'Bob'],
      publishedAt: '2024-03-01T00:00:00Z',
    });
    const paper = lookupPaperInDb(db, '2402.01234');
    expect(paper).not.toBeNull();
    expect(paper!.arxivId).toBe('2402.01234');
    expect(paper!.title).toBe('My Paper');
    expect(paper!.abstract).toBe('Abstract here.');
    expect(paper!.authors).toEqual(['Alice', 'Bob']);
    expect(paper!.year).toBe('2024');
  });

  it('returns null for unknown arxiv ID', () => {
    expect(lookupPaperInDb(db, '9999.99999')).toBeNull();
  });

  it('handles malformed authors_json gracefully', () => {
    db.sqlite.prepare(
      `INSERT INTO papers (arxiv_id, latest_version, title, abstract, authors_json, categories_json,
        published_at, updated_at, pdf_path, txt_path, meta_path, ingested_at)
       VALUES ('2402.11111', 'v1', 'Title', 'Abstract', 'NOT_JSON', '[]',
               datetime('now'), datetime('now'), '/tmp/x.pdf', '/tmp/x.txt', '/tmp/x.json', datetime('now'))`,
    ).run();
    const paper = lookupPaperInDb(db, '2402.11111');
    expect(paper).not.toBeNull();
    expect(paper!.authors).toEqual([]);
  });

  it('returns year from published_at prefix', () => {
    // published_at is NOT NULL in schema; year is extracted from the date prefix
    seedPaper(db, '2402.22222', { publishedAt: '2022-11-30T00:00:00Z' });
    const paper = lookupPaperInDb(db, '2402.22222');
    expect(paper!.year).toBe('2022');
  });

  it('strips version suffix from year', () => {
    seedPaper(db, '2402.33333', { publishedAt: '2023-07-01T00:00:00Z' });
    const paper = lookupPaperInDb(db, '2402.33333');
    expect(paper!.year).toBe('2023');
  });
});

// ── fetchPaperFromArxiv ───────────────────────────────────────────────────

describe('fetchPaperFromArxiv', () => {
  it('parses a valid arxiv API XML response', async () => {
    // Two <title> tags: feed title + entry title. Parser uses index 1.
    const mockXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query Results</title>
  <entry>
    <title>Speculative Decoding for Fast LLMs</title>
    <summary>This paper introduces speculative decoding, a technique to speed up LLM inference significantly.</summary>
    <name>John Doe</name>
    <name>Jane Smith</name>
    <published>2024-02-01T00:00:00Z</published>
    <id>http://arxiv.org/abs/2402.09999v1</id>
  </entry>
</feed>`;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => mockXml,
    } as unknown as Response);

    const paper = await fetchPaperFromArxiv('2402.09999', mockFetch);
    expect(paper).not.toBeNull();
    expect(paper!.title).toBe('Speculative Decoding for Fast LLMs');
    expect(paper!.abstract).toContain('speculative decoding');
    expect(paper!.authors).toContain('John Doe');
    expect(paper!.year).toBe('2024');
    expect(paper!.arxivId).toBe('2402.09999');
  });

  it('returns null when API returns no entry', async () => {
    const mockXml = `<feed><title>Empty</title></feed>`;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => mockXml,
    } as unknown as Response);

    const paper = await fetchPaperFromArxiv('9999.00000', mockFetch);
    expect(paper).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    const paper = await fetchPaperFromArxiv('2402.09999', mockFetch);
    expect(paper).toBeNull();
  });

  it('returns null when API returns non-ok status', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'Rate limited',
    } as unknown as Response);

    const paper = await fetchPaperFromArxiv('2402.09999', mockFetch);
    expect(paper).toBeNull();
  });
});

// ── buildAskPrompt ────────────────────────────────────────────────────────

describe('buildAskPrompt', () => {
  it('includes title, authors, year, abstract, and question', () => {
    const prompt = buildAskPrompt(SAMPLE_PAPER, 'what is the key contribution?');
    expect(prompt).toContain('Attention Is All You Need (Revisited)');
    expect(prompt).toContain('Alice Smith');
    expect(prompt).toContain('2024');
    expect(prompt).toContain(SAMPLE_PAPER.abstract);
    expect(prompt).toContain('what is the key contribution?');
  });

  it('truncates long author lists to first 3 + et al.', () => {
    const paper: PaperContext = {
      ...SAMPLE_PAPER,
      authors: ['A', 'B', 'C', 'D', 'E'],
    };
    const prompt = buildAskPrompt(paper, 'what method?');
    expect(prompt).toContain('et al.');
    expect(prompt).not.toContain('D,');
  });

  it('handles empty author list gracefully', () => {
    const paper: PaperContext = { ...SAMPLE_PAPER, authors: [] };
    const prompt = buildAskPrompt(paper, 'question?');
    expect(prompt).not.toContain('Authors:');
  });

  it('omits year line when year is null', () => {
    const paper: PaperContext = { ...SAMPLE_PAPER, year: null };
    const prompt = buildAskPrompt(paper, 'question?');
    expect(prompt).not.toContain('Year:');
  });
});

// ── truncateAnswer ────────────────────────────────────────────────────────

describe('truncateAnswer', () => {
  it('returns answer unchanged when within limit', () => {
    const short = 'Short answer.';
    expect(truncateAnswer(short, 800)).toBe(short);
  });

  it('truncates at sentence boundary', () => {
    const answer = 'First sentence. ' + 'X'.repeat(800) + '. More text.';
    const result = truncateAnswer(answer, 800);
    expect(result.length).toBeLessThanOrEqual(810);  // +6 for ' [...]'
    expect(result.endsWith('[...]')).toBe(true);
  });

  it('falls back to hard truncate when no sentence boundary is near', () => {
    const answer = 'A'.repeat(1000);
    const result = truncateAnswer(answer, 800);
    expect(result.endsWith('[...]')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(810);
  });

  it('returns exact text when length equals limit', () => {
    const answer = 'A'.repeat(800);
    expect(truncateAnswer(answer, 800)).toBe(answer);
  });
});

// ── formatAskReply ────────────────────────────────────────────────────────

describe('formatAskReply', () => {
  it('appends paper title in footer', () => {
    const result: AskResult = {
      ok: true,
      answer: 'The key contribution is novel attention.',
      paperTitle: 'Attention Is All You Need',
      arxivId: '1706.03762',
    };
    const reply = formatAskReply(result);
    expect(reply).toContain('The key contribution is novel attention.');
    expect(reply).toContain('> Re: Attention Is All You Need');
  });

  it('truncates long answers in the reply', () => {
    const result: AskResult = {
      ok: true,
      answer: 'Word. '.repeat(300),
      paperTitle: 'Long Paper',
      arxivId: '2402.01234',
    };
    const reply = formatAskReply(result);
    expect(reply.length).toBeLessThan(900);
    expect(reply).toContain('> Re: Long Paper');
  });
});

// ── loadOpenRouterKey ─────────────────────────────────────────────────────

describe('loadOpenRouterKey', () => {
  it('returns null when file does not exist', () => {
    expect(loadOpenRouterKey('/nonexistent/path/profiles.json')).toBeNull();
  });

  it('returns key from OPENROUTER_API_KEY env var', () => {
    const original = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-test-from-env';
    try {
      expect(loadOpenRouterKey('/nonexistent')).toBe('sk-test-from-env');
    } finally {
      if (original === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = original;
    }
  });
});

// ── askPaper — integration ────────────────────────────────────────────────

describe('askPaper', () => {
  let db: Db;
  beforeEach(() => { db = makeTestDb(); });

  it('returns question_too_short error for very short question', async () => {
    seedPaper(db, '2402.01234');
    const result = await askPaper({
      db,
      arxivId: '2402.01234',
      question: 'hi',
      profilesPath: '/nonexistent',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('question_too_short');
      expect(result.message).toContain('/ask');
    }
  });

  it('returns no_api_key error when no key available', async () => {
    seedPaper(db, '2402.01234');
    const original = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const result = await askPaper({
        db,
        arxivId: '2402.01234',
        question: 'what is the key contribution?',
        profilesPath: '/nonexistent',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('no_api_key');
    } finally {
      if (original !== undefined) process.env.OPENROUTER_API_KEY = original;
    }
  });

  it('returns paper_not_found when not in DB and arxiv fallback returns null', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '<feed><title>Empty</title></feed>',
    } as unknown as Response);

    const original = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-test-key';
    try {
      const result = await askPaper({
        db,
        arxivId: '9999.00000',
        question: 'what does this paper propose?',
        fetchImpl: mockFetch,
        profilesPath: '/nonexistent',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('paper_not_found');
        expect(result.message).toContain('9999.00000');
      }
    } finally {
      if (original === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = original;
    }
  });

  it('returns ok result from DB paper + mocked OpenRouter', async () => {
    seedPaper(db, '2402.01234', {
      title: 'Flash Attention',
      abstract: 'We introduce Flash Attention, a fast and memory-efficient attention algorithm.',
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Flash Attention speeds up transformers by reducing memory reads.' } }],
      }),
    } as unknown as Response);

    const original = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-test-key';
    try {
      const result = await askPaper({
        db,
        arxivId: '2402.01234',
        question: 'what is the key contribution?',
        fetchImpl: mockFetch,
        profilesPath: '/nonexistent',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.answer).toContain('Flash Attention');
        expect(result.paperTitle).toBe('Flash Attention');
        expect(result.arxivId).toBe('2402.01234');
      }
    } finally {
      if (original === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = original;
    }
  });

  it('uses arxiv API fallback when paper not in DB', async () => {
    // Note: feed has two <title> tags — feed title first, then entry title.
    // Our parser uses titleMatch[1] (index 1 = second match).
    const arxivXml = `<feed>
      <title>ArXiv Query</title>
      <entry>
        <title>RAG Paper</title>
        <summary>Retrieval augmented generation combines retrieval with generation.</summary>
        <name>Eve</name>
        <published>2024-06-01T00:00:00Z</published>
      </entry>
    </feed>`;

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => arxivXml,
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'RAG combines retrieval with generation for better answers.' } }],
        }),
      } as unknown as Response);

    const original = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-test-key';
    try {
      const result = await askPaper({
        db,
        arxivId: '2402.55555',
        question: 'how does RAG work?',
        fetchImpl: mockFetch,
        profilesPath: '/nonexistent',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.paperTitle).toBe('RAG Paper');
      }
    } finally {
      if (original === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = original;
    }
  });

  it('retries once on OpenRouter failure then returns api_error', async () => {
    seedPaper(db, '2402.01234');

    const mockFetch = vi.fn().mockRejectedValue(new Error('OpenRouter timeout'));

    const original = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-test-key';
    try {
      const result = await askPaper({
        db,
        arxivId: '2402.01234',
        question: 'what is this paper about?',
        fetchImpl: mockFetch,
        profilesPath: '/nonexistent',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('api_error');
        expect(result.message).toContain('OpenRouter');
      }
      // Should have been called twice (initial + 1 retry)
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      if (original === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = original;
    }
  });
});
