import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, migrate } from '../db.js';
import { deliverDailyDigest } from './orchestrator.js';

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-coach-deliver-'));
}

describe('deliverDailyDigest', () => {
  it('sends header + tracks, then marks sent', async () => {
    const dir = mkTmpDir();
    const db = openDb(path.join(dir, 'db.sqlite'));
    migrate(db);

    const sent: string[] = [];
    const send = async (m: string) => { sent.push(m); };

    const plan = {
      dateIso: '2026-02-08',
      header: 'H',
      tracks: [
        { track: 'T1', message: 'M1' },
        { track: 'T2', message: 'M2' },
      ],
      digestPath: '/tmp/x.md',
    };

    const res = await deliverDailyDigest(send, {
      db,
      plan,
      alreadySent: false,
      delayMsBetweenMessages: 0,
    });

    expect(res.sent).toBe(true);
    expect(sent).toEqual(['H', 'M1', 'M2']);

    const row = db.sqlite.prepare('SELECT digest_date FROM sent_digests WHERE digest_date=?').get('2026-02-08');
    expect(row).toBeTruthy();
  });

  it('does not mark sent if send throws', async () => {
    const dir = mkTmpDir();
    const db = openDb(path.join(dir, 'db.sqlite'));
    migrate(db);

    let calls = 0;
    const send = async (_m: string) => {
      calls += 1;
      if (calls === 2) throw new Error('fail');
    };

    const plan = {
      dateIso: '2026-02-09',
      header: 'H',
      tracks: [
        { track: 'T1', message: 'M1' },
      ],
      digestPath: '/tmp/x.md',
    };

    await expect(deliverDailyDigest(send, {
      db,
      plan,
      alreadySent: false,
      delayMsBetweenMessages: 0,
    })).rejects.toThrow('fail');

    const row = db.sqlite.prepare('SELECT digest_date FROM sent_digests WHERE digest_date=?').get('2026-02-09');
    expect(row).toBeFalsy();
  });

  it('skips if already sent', async () => {
    const dir = mkTmpDir();
    const db = openDb(path.join(dir, 'db.sqlite'));
    migrate(db);

    db.sqlite.prepare(
      `INSERT INTO sent_digests (digest_date, kind, sent_at, header_text, tracks_json)
       VALUES ('2026-02-10', 'daily', ?, 'H', '[]')`
    ).run(new Date().toISOString());

    const sent: string[] = [];
    const send = async (m: string) => { sent.push(m); };

    const plan = {
      dateIso: '2026-02-10',
      header: 'H',
      tracks: [],
      digestPath: '/tmp/x.md',
    };

    const res = await deliverDailyDigest(send, {
      db,
      plan,
      alreadySent: true,
      delayMsBetweenMessages: 0,
    });

    expect(res.skippedAlreadySent).toBe(true);
    expect(sent.length).toBe(0);
  });
});
