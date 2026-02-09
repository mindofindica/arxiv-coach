import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import { hasWeeklyBeenSent, markWeeklySent, getWeeklySentRecord, WEEKLY_SECTIONS } from './plan.js';
import type { Db } from '../db.js';

describe('weekly plan tracking', () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-plan-test-'));

    const sqlite = new Database(':memory:');
    db = { sqlite };

    // Create the sent_weekly_digests table (v3 migration)
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS sent_weekly_digests (
        week_iso TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        arxiv_id TEXT NOT NULL,
        sections_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sent_weekly_sent_at ON sent_weekly_digests(sent_at);
    `);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('hasWeeklyBeenSent', () => {
    it('returns false when week has not been sent', () => {
      expect(hasWeeklyBeenSent(db, '2026-W07')).toBe(false);
    });

    it('returns true when week has been sent', () => {
      db.sqlite.prepare(
        `INSERT INTO sent_weekly_digests (week_iso, kind, sent_at, arxiv_id, sections_json)
         VALUES (?, 'weekly', ?, ?, ?)`
      ).run('2026-W07', '2026-02-15T10:00:00Z', '2602.01234', '["header","tldr"]');

      expect(hasWeeklyBeenSent(db, '2026-W07')).toBe(true);
    });

    it('distinguishes between different weeks', () => {
      markWeeklySent(db, '2026-W06', '2602.01234', '[]');
      
      expect(hasWeeklyBeenSent(db, '2026-W06')).toBe(true);
      expect(hasWeeklyBeenSent(db, '2026-W07')).toBe(false);
    });
  });

  describe('markWeeklySent', () => {
    it('inserts a new record', () => {
      markWeeklySent(db, '2026-W07', '2602.01234', '["header"]');
      
      expect(hasWeeklyBeenSent(db, '2026-W07')).toBe(true);
    });

    it('updates existing record (idempotent)', () => {
      markWeeklySent(db, '2026-W07', '2602.01234', '["header"]');
      markWeeklySent(db, '2026-W07', '2602.05678', '["header","tldr"]');

      const record = getWeeklySentRecord(db, '2026-W07');
      expect(record?.arxivId).toBe('2602.05678');
      expect(record?.sectionsJson).toBe('["header","tldr"]');
    });

    it('stores correct timestamp', () => {
      const before = new Date();
      markWeeklySent(db, '2026-W07', '2602.01234', '[]');
      const after = new Date();

      const record = getWeeklySentRecord(db, '2026-W07');
      const sentAt = new Date(record!.sentAt);
      
      expect(sentAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(sentAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('getWeeklySentRecord', () => {
    it('returns null when no record exists', () => {
      expect(getWeeklySentRecord(db, '2026-W07')).toBeNull();
    });

    it('returns the full record when exists', () => {
      markWeeklySent(db, '2026-W07', '2602.01234', '["header","tldr","key_ideas"]');

      const record = getWeeklySentRecord(db, '2026-W07');
      expect(record).not.toBeNull();
      expect(record?.weekIso).toBe('2026-W07');
      expect(record?.arxivId).toBe('2602.01234');
      expect(record?.sectionsJson).toBe('["header","tldr","key_ideas"]');
    });
  });

  describe('WEEKLY_SECTIONS', () => {
    it('contains expected sections', () => {
      expect(WEEKLY_SECTIONS).toContain('header');
      expect(WEEKLY_SECTIONS).toContain('tldr');
      expect(WEEKLY_SECTIONS).toContain('key_ideas');
      expect(WEEKLY_SECTIONS).toContain('how_it_works');
      expect(WEEKLY_SECTIONS).toContain('why_it_matters');
      expect(WEEKLY_SECTIONS).toContain('related');
      expect(WEEKLY_SECTIONS).toHaveLength(6);
    });
  });
});
