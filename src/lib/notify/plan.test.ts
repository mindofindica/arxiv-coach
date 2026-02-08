import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, migrate } from '../db.js';
import { hasDigestBeenSent, markDigestSent } from './plan.js';

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-coach-plan-'));
}

describe('sent digest tracking', () => {
  it('marks digest sent and prevents resend', () => {
    const dir = mkTmpDir();
    const db = openDb(path.join(dir, 'db.sqlite'));
    migrate(db);

    expect(hasDigestBeenSent(db, '2026-02-08')).toBe(false);

    markDigestSent(db, {
      dateIso: '2026-02-08',
      header: 'h',
      tracks: [{ track: 't', message: 'm' }],
      digestPath: '/tmp/x.md',
    });

    expect(hasDigestBeenSent(db, '2026-02-08')).toBe(true);
  });
});
