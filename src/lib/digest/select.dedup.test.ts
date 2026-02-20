/**
 * Tests for the digest deduplication feature (digest_papers table / selectDailyByTrack filter).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type Db } from '../db.js';
import { selectDailyByTrack } from './select.js';
import { markDigestSent } from '../notify/plan.js';

describe('selectDailyByTrack — dedup filter', () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-coach-dedup-'));
    db = openDb(path.join(tmpDir, 'test.sqlite'));
    migrate(db);
  });

  afterEach(() => {
    db.sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedPaper(arxivId: string, title = 'Paper') {
    const metaPath = path.join(tmpDir, `${arxivId}.json`);
    fs.writeFileSync(metaPath, JSON.stringify({
      absUrl: `http://arxiv.org/abs/${arxivId}`,
      pdfUrl: `http://arxiv.org/pdf/${arxivId}.pdf`,
    }));
    const now = new Date().toISOString();
    db.sqlite.prepare(
      `INSERT INTO papers (arxiv_id, title, abstract, authors_json, categories_json, published_at, updated_at, pdf_path, txt_path, meta_path, ingested_at)
       VALUES (?, ?, 'Abstract', '[]', '[]', ?, ?, '', '', ?, ?)`
    ).run(arxivId, title, now, now, metaPath, now);
  }

  function seedTrackMatch(arxivId: string, trackName = 'Track1', score = 5) {
    db.sqlite.prepare(
      `INSERT INTO track_matches (arxiv_id, track_name, score, matched_terms_json, matched_at)
       VALUES (?, ?, ?, '["term"]', ?)`
    ).run(arxivId, trackName, score, new Date().toISOString());
  }

  function seedDigestPaper(arxivId: string, digestDate: string, trackName = 'Track1') {
    db.sqlite.prepare(
      `INSERT OR IGNORE INTO digest_papers (arxiv_id, digest_date, track_name, sent_at)
       VALUES (?, ?, ?, ?)`
    ).run(arxivId, digestDate, trackName, new Date().toISOString());
  }

  function isoToday(): string {
    return new Date().toISOString().slice(0, 10);
  }

  function isoAgo(days: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  }

  // ---

  it('returns all papers when digest_papers is empty', () => {
    seedPaper('2501.001');
    seedPaper('2501.002');
    seedTrackMatch('2501.001');
    seedTrackMatch('2501.002');

    const result = selectDailyByTrack(db, { maxItemsPerDigest: 10, maxPerTrack: 5 });
    const papers = result.byTrack.get('Track1') ?? [];
    expect(papers.map(p => p.arxivId).sort()).toEqual(['2501.001', '2501.002']);
  });

  it('excludes papers sent today', () => {
    seedPaper('2501.001', 'Already sent today');
    seedPaper('2501.002', 'Fresh paper');
    seedTrackMatch('2501.001');
    seedTrackMatch('2501.002');
    seedDigestPaper('2501.001', isoToday());

    const result = selectDailyByTrack(db, { maxItemsPerDigest: 10, maxPerTrack: 5 });
    const papers = result.byTrack.get('Track1') ?? [];
    expect(papers).toHaveLength(1);
    expect(papers[0]!.arxivId).toBe('2501.002');
  });

  it('excludes papers sent within dedupDays window', () => {
    seedPaper('2501.001', 'Sent 3 days ago');
    seedPaper('2501.002', 'Fresh paper');
    seedTrackMatch('2501.001');
    seedTrackMatch('2501.002');
    seedDigestPaper('2501.001', isoAgo(3));

    const result = selectDailyByTrack(db, { maxItemsPerDigest: 10, maxPerTrack: 5, dedupDays: 7 });
    const papers = result.byTrack.get('Track1') ?? [];
    expect(papers).toHaveLength(1);
    expect(papers[0]!.arxivId).toBe('2501.002');
  });

  it('includes papers sent outside dedupDays window', () => {
    seedPaper('2501.001', 'Old sent paper');
    seedPaper('2501.002', 'Fresh paper');
    seedTrackMatch('2501.001');
    seedTrackMatch('2501.002');
    seedDigestPaper('2501.001', isoAgo(10)); // 10 days ago

    // With dedupDays=7, 10 days ago is outside window — should be included again
    const result = selectDailyByTrack(db, { maxItemsPerDigest: 10, maxPerTrack: 5, dedupDays: 7 });
    const papers = result.byTrack.get('Track1') ?? [];
    expect(papers.map(p => p.arxivId).sort()).toEqual(['2501.001', '2501.002']);
  });

  it('respects custom dedupDays parameter', () => {
    seedPaper('2501.001', 'Sent 2 days ago');
    seedPaper('2501.002', 'Fresh paper');
    seedTrackMatch('2501.001');
    seedTrackMatch('2501.002');
    seedDigestPaper('2501.001', isoAgo(2));

    // dedupDays=1: 2 days ago is outside window → included
    const resultShort = selectDailyByTrack(db, { maxItemsPerDigest: 10, maxPerTrack: 5, dedupDays: 1 });
    const papersShort = resultShort.byTrack.get('Track1') ?? [];
    expect(papersShort.map(p => p.arxivId).sort()).toEqual(['2501.001', '2501.002']);

    // dedupDays=7: 2 days ago is within window → excluded
    const resultLong = selectDailyByTrack(db, { maxItemsPerDigest: 10, maxPerTrack: 5, dedupDays: 7 });
    const papersLong = resultLong.byTrack.get('Track1') ?? [];
    expect(papersLong).toHaveLength(1);
    expect(papersLong[0]!.arxivId).toBe('2501.002');
  });

  it('dedup is per-arxiv-id, not per-track', () => {
    // Paper sent on Track1 should also be excluded from Track2
    seedPaper('2501.001', 'Multi-track paper');
    seedTrackMatch('2501.001', 'Track1');
    seedTrackMatch('2501.001', 'Track2');
    seedDigestPaper('2501.001', isoToday(), 'Track1');

    const result = selectDailyByTrack(db, { maxItemsPerDigest: 10, maxPerTrack: 5 });
    expect(result.byTrack.get('Track1')).toBeUndefined();
    expect(result.byTrack.get('Track2')).toBeUndefined();
  });

  it('markDigestSent writes to digest_papers when papers are provided', () => {
    seedPaper('2501.001');
    seedPaper('2501.002');

    markDigestSent(db, {
      dateIso: isoToday(),
      header: 'Header',
      tracks: [{ track: 'Track1', message: 'msg' }],
      digestPath: '/tmp/test.md',
      papers: [
        { arxivId: '2501.001', trackName: 'Track1' },
        { arxivId: '2501.002', trackName: 'Track1' },
      ],
    });

    const rows = db.sqlite.prepare('SELECT arxiv_id FROM digest_papers WHERE digest_date=?').all(isoToday()) as Array<{ arxiv_id: string }>;
    expect(rows.map(r => r.arxiv_id).sort()).toEqual(['2501.001', '2501.002']);
  });

  it('markDigestSent without papers does not write to digest_papers', () => {
    seedPaper('2501.001');

    markDigestSent(db, {
      dateIso: isoToday(),
      header: 'Header',
      tracks: [{ track: 'Track1', message: 'msg' }],
      digestPath: '/tmp/test.md',
      // no papers field
    });

    const rows = db.sqlite.prepare('SELECT arxiv_id FROM digest_papers WHERE digest_date=?').all(isoToday()) as Array<{ arxiv_id: string }>;
    expect(rows).toHaveLength(0);
  });

  it('markDigestSent is idempotent — no error on duplicate paper insert', () => {
    seedPaper('2501.001');
    const plan = {
      dateIso: isoToday(),
      header: 'Header',
      tracks: [{ track: 'Track1', message: 'msg' }],
      digestPath: '/tmp/test.md',
      papers: [{ arxivId: '2501.001', trackName: 'Track1' }],
    };

    expect(() => {
      markDigestSent(db, plan);
      // Calling again should not throw (INSERT OR IGNORE + INSERT OR REPLACE)
      markDigestSent(db, plan);
    }).not.toThrow();
  });
});
