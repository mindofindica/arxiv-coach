import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Reduce politeness sleeps to keep tests fast
vi.mock('../sleep.js', () => ({
  sleep: () => Promise.resolve(),
  jitter: () => 1,
}));
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AppConfig, TracksFile } from '../types.js';
import { openDb, migrate } from '../db.js';
import { ensureStorageRoot, upsertPaper, upsertTrackMatch } from '../repo.js';

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-coach-int-'));
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

async function importRunDailyWithMocks(mocks: {
  fetchAtom?: (cat: string) => Promise<string>;
  hasPdfToText?: () => boolean;
  downloadToFile?: (url: string, outPath: string) => Promise<{ bytes: number; sha256: string }>;
}) {
  vi.resetModules();

  if (mocks.fetchAtom) {
    vi.doMock('../arxiv.js', async (orig) => {
      const actual: any = await orig();
      return { ...actual, fetchAtom: vi.fn(mocks.fetchAtom) };
    });
  }

  if (mocks.hasPdfToText) {
    vi.doMock('../extract.js', async (orig) => {
      const actual: any = await orig();
      return { ...actual, hasPdfToText: mocks.hasPdfToText };
    });
  }

  if (mocks.downloadToFile) {
    vi.doMock('../download.js', async (orig) => {
      const actual: any = await orig();
      return { ...actual, downloadToFile: vi.fn(mocks.downloadToFile) };
    });
  }

  const mod = await import('./daily.js');
  return mod.runDaily as typeof import('./daily.js').runDaily;
}

describe('Integration: steps 1–3', () => {
  // Many tests intentionally trigger warnings (e.g. disabled pdftotext, discovery failures).
  // Silence console noise so CI output stays clean.
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
  it('Step1: DB migration smoke creates expected tables', () => {
    const storageRoot = mkTmpDir();
    const dbPath = path.join(storageRoot, 'db.sqlite');
    const db = openDb(dbPath);
    migrate(db);

    const tables = db.sqlite
      .prepare("select name from sqlite_master where type='table' order by name")
      .all()
      .map((r: any) => r.name);

    for (const t of ['papers', 'paper_versions', 'track_matches', 'runs', 'schema_meta']) {
      expect(tables).toContain(t);
    }
  });

  it('Step2: end-to-end discovery → match inserts papers + matches (no artifacts)', async () => {
    const storageRoot = mkTmpDir();
    const config = baseConfig(storageRoot);

    const feed = `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>http://arxiv.org/abs/2502.00001v1</id>
          <updated>2026-02-08T10:00:00Z</updated>
          <published>2026-02-08T09:00:00Z</published>
          <title>Agent tool use</title>
          <summary>We study tool use for an agent.</summary>
          <author><name>Alice</name></author>
          <category term="cs.AI"/>
          <link rel="alternate" type="text/html" href="http://arxiv.org/abs/2502.00001v1"/>
          <link title="pdf" rel="related" type="application/pdf" href="http://arxiv.org/pdf/2502.00001v1"/>
        </entry>
        <entry>
          <id>http://arxiv.org/abs/2502.00002v1</id>
          <updated>2026-02-08T10:00:00Z</updated>
          <published>2026-02-08T09:00:00Z</published>
          <title>Unrelated topic</title>
          <summary>Nothing about tools.</summary>
          <author><name>Bob</name></author>
          <category term="cs.AI"/>
          <link rel="alternate" type="text/html" href="http://arxiv.org/abs/2502.00002v1"/>
          <link title="pdf" rel="related" type="application/pdf" href="http://arxiv.org/pdf/2502.00002v1"/>
        </entry>
      </feed>`;

    const runDaily = await importRunDailyWithMocks({
      fetchAtom: async (_cat) => feed,
      // Skip extraction for this test; we still mock download so we don't hit the network.
      hasPdfToText: () => false,
      downloadToFile: async (_url, outPath) => {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, '%PDF-FAKE\n');
        return { bytes: 10, sha256: 'deadbeef' };
      },
    });

    const res = await runDaily({
      config,
      tracksFile,
      now: new Date('2026-02-08T12:00:00Z'),
      politenessJitterMs: { min: 1, max: 1 },
    });

    expect(res.status).toBe('ok');

    const db = openDb(path.join(storageRoot, 'db.sqlite'));
    const papers = db.sqlite.prepare('select count(*) as n from papers').get() as any;
    const matches = db.sqlite.prepare('select count(*) as n from track_matches').get() as any;

    expect(papers.n).toBe(2);
    expect(matches.n).toBe(1);

    const meta1 = path.join(storageRoot, 'papers', '2026', '02', '2502.00001', 'meta.json');
    expect(fs.existsSync(meta1)).toBe(true);
  });

  it('Step3: artifact success updates sha + writes pdf/txt', async () => {
    const storageRoot = mkTmpDir();
    const config = baseConfig(storageRoot);
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

    const paperDir = path.join(storageRoot, 'papers', '2026', '02', entry.arxivId);
    fs.mkdirSync(paperDir, { recursive: true });
    fs.writeFileSync(path.join(paperDir, 'meta.json'), JSON.stringify(entry));

    // Mock discovery empty, but keep artifacts real via mocks.
    vi.resetModules();
    vi.doMock('../arxiv.js', async (orig) => {
      const actual: any = await orig();
      return {
        ...actual,
        fetchAtom: vi.fn(async () => `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`),
      };
    });

    // Mock download + extract
    vi.doMock('../download.js', () => {
      return {
        downloadToFile: vi.fn(async (_url: string, outPath: string) => {
          fs.mkdirSync(path.dirname(outPath), { recursive: true });
          fs.writeFileSync(outPath, '%PDF-FAKE\n');
          return { bytes: 10, sha256: 'deadbeef' };
        }),
      };
    });

    vi.doMock('../extract.js', () => {
      return {
        hasPdfToText: () => true,
        extractPdfToText: vi.fn((pdfPath: string, txtPath: string) => {
          fs.writeFileSync(txtPath, `extracted from ${pdfPath}`);
        }),
      };
    });

    const { runDaily } = await import('./daily.js');

    const res = await runDaily({
      config,
      tracksFile,
      now: new Date('2026-02-08T12:00:00Z'),
      dbPath,
      politenessJitterMs: { min: 1, max: 1 },
    });

    expect(res.stats.downloadedPdfs).toBe(1);
    expect(res.stats.extractedTexts).toBe(1);

    expect(fs.existsSync(path.join(paperDir, 'paper.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(paperDir, 'paper.txt'))).toBe(true);

    const shaRow = db.sqlite.prepare('select sha256_pdf from papers where arxiv_id=?').get(entry.arxivId) as any;
    expect(shaRow.sha256_pdf).toBe('deadbeef');
  });

  it('Step3: corrupt pdf triggers redownload in artifacts runner', async () => {
    const storageRoot = mkTmpDir();
    const config = baseConfig(storageRoot);
    ensureStorageRoot(config);

    const dbPath = path.join(storageRoot, 'db.sqlite');
    const db = openDb(dbPath);
    migrate(db);

    const entry = {
      arxivId: '2502.99999',
      version: 'v1',
      title: 'Agent tool use',
      summary: 'We study tool use for an agent.',
      authors: ['Alice'],
      categories: ['cs.AI'],
      publishedAt: '2026-02-08T09:00:00Z',
      updatedAt: '2026-02-08T10:00:00Z',
      pdfUrl: 'http://arxiv.org/pdf/2502.99999v1',
      absUrl: 'http://arxiv.org/abs/2502.99999v1',
      rawIdUrl: 'http://arxiv.org/abs/2502.99999v1',
    };

    upsertPaper(db, config, entry as any);
    upsertTrackMatch(db, entry.arxivId, 'Agents / Tool Use', 4, ['tool use', 'agent']);

    const paperDir = path.join(storageRoot, 'papers', '2026', '02', entry.arxivId);
    fs.mkdirSync(paperDir, { recursive: true });
    fs.writeFileSync(path.join(paperDir, 'meta.json'), JSON.stringify(entry));

    // Create a corrupt/non-pdf "paper.pdf"
    fs.writeFileSync(path.join(paperDir, 'paper.pdf'), '<!doctype html>rate limited');

    vi.resetModules();
    vi.doMock('../download.js', () => {
      return {
        downloadToFile: vi.fn(async (_url: string, outPath: string) => {
          fs.mkdirSync(path.dirname(outPath), { recursive: true });
          fs.writeFileSync(outPath, '%PDF-REPAIRED\n');
          return { bytes: 12, sha256: 'beadfeed' };
        }),
      };
    });

    vi.doMock('../extract.js', () => {
      return {
        hasPdfToText: () => true,
        extractPdfToText: vi.fn((_pdfPath: string, txtPath: string) => {
          fs.writeFileSync(txtPath, 'ok');
        }),
      };
    });

    const { runArtifacts } = await import('./artifacts.js');
    const out = await runArtifacts({ config, db, jitterMs: { min: 1, max: 1 } });

    expect(out.corruptRedownloads).toBe(1);
    expect(out.downloadedPdfs).toBe(1);
    expect(out.extractedTexts).toBe(1);

    const head = fs.readFileSync(path.join(paperDir, 'paper.pdf'), 'utf8').slice(0, 5);
    expect(head).toBe('%PDF-');
  });
});
