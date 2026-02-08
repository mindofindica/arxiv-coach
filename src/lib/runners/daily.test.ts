import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AppConfig, TracksFile } from '../types.js';
import { openDb, migrate } from '../db.js';
import { ensureStorageRoot, upsertPaper, upsertTrackMatch } from '../repo.js';

// Mock network discovery (arXiv)
vi.mock('../arxiv.js', async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    fetchAtom: vi.fn(async (category: string) => {
      if (category === 'cs.AI') {
        throw new Error('arXiv fetch failed for cs.AI: 429 Too Many Requests');
      }
      // Return an empty feed for other categories
      return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`;
    }),
  };
});

// Mock artifact download + extraction
vi.mock('../download.js', () => {
  return {
    downloadToFile: vi.fn(async (_url: string, outPath: string) => {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, '%PDF-FAKE\n');
      return { bytes: 10, sha256: 'deadbeef' };
    }),
  };
});

vi.mock('../extract.js', () => {
  return {
    hasPdfToText: () => true,
    extractPdfToText: vi.fn((pdfPath: string, txtPath: string) => {
      const txt = `extracted from ${pdfPath}`;
      fs.writeFileSync(txtPath, txt);
    }),
  };
});

import { runDaily } from './daily.js';

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-coach-test-'));
}

function baseConfig(storageRoot: string): AppConfig {
  return {
    timezone: 'Europe/Amsterdam',
    schedule: { dailyDigestTime: '08:30', weekly: { day: 'Sun', time: '11:00' } },
    discovery: { categories: ['cs.AI', 'cs.CL'] },
    storage: { root: storageRoot, keepPdfsForever: true },
    limits: { maxItemsPerDigest: 5, maxPerTrackPerDay: 2 },
  };
}

const tracksFile: TracksFile = {
  tracks: [
    {
      name: 'Agents / Tool Use',
      enabled: true,
      categories: ['cs.AI', 'cs.CL'],
      phrases: ['tool use'],
      keywords: ['agent'],
      exclude: [],
      threshold: 1,
      maxPerDay: 2,
    },
  ],
};

describe('runDaily integration harness', () => {
  const originalWarn = console.warn;
  const originalError = console.error;

  const originalLog = console.log;

  beforeAll(() => {
    console.warn = () => {};
    console.error = () => {};
    console.log = () => {};
  });

  afterAll(() => {
    console.warn = originalWarn;
    console.error = originalError;
    console.log = originalLog;
  });
  it('continues to artifact step on discovery 429 and marks warn', async () => {
    const storageRoot = mkTmpDir();
    const config = baseConfig(storageRoot);

    // Pre-seed DB with a matched paper so artifact step has work to do.
    ensureStorageRoot(config);
    const dbPath = path.join(storageRoot, 'db.sqlite');
    const db = openDb(dbPath);
    migrate(db);

    const entry = {
      arxivId: '2502.12345',
      version: 'v1',
      title: 'Agent tool use',
      summary: 'We study tool use for an agent.',
      authors: ['Alice'],
      categories: ['cs.AI'],
      publishedAt: '2026-02-08T09:00:00Z',
      updatedAt: '2026-02-08T10:00:00Z',
      pdfUrl: 'http://arxiv.org/pdf/2502.12345v1',
      absUrl: 'http://arxiv.org/abs/2502.12345v1',
      rawIdUrl: 'http://arxiv.org/abs/2502.12345v1',
    };

    upsertPaper(db, config, entry as any);
    upsertTrackMatch(db, entry.arxivId, 'Agents / Tool Use', 4, ['tool use', 'agent']);

    // write meta.json where runner expects it
    const paperDir = path.join(storageRoot, 'papers', '2026', '02', entry.arxivId);
    fs.mkdirSync(paperDir, { recursive: true });
    fs.writeFileSync(path.join(paperDir, 'meta.json'), JSON.stringify(entry));

    const res = await runDaily({
      config,
      tracksFile,
      now: new Date('2026-02-08T12:00:00Z'),
      dbPath,
      politenessJitterMs: { min: 1, max: 1 }, // keep test fast
    });

    expect(res.status).toBe('warn');
    expect(res.stats.discoveryErrors.length).toBeGreaterThan(0);
    expect(res.stats.downloadedPdfs).toBe(1);
    expect(res.stats.extractedTexts).toBe(1);

    expect(fs.existsSync(path.join(paperDir, 'paper.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(paperDir, 'paper.txt'))).toBe(true);
  });
});
