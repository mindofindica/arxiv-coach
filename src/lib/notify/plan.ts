import type { Db } from '../db.js';

export interface DigestMessagePlan {
  dateIso: string;
  header: string;
  tracks: Array<{ track: string; message: string }>;
  digestPath: string;
}

export function hasDigestBeenSent(db: Db, dateIso: string): boolean {
  const row = db.sqlite.prepare('SELECT digest_date FROM sent_digests WHERE digest_date=?').get(dateIso) as any;
  return Boolean(row);
}

export function markDigestSent(db: Db, plan: DigestMessagePlan) {
  db.sqlite.prepare(
    `INSERT OR REPLACE INTO sent_digests (digest_date, kind, sent_at, header_text, tracks_json)
     VALUES (?, 'daily', ?, ?, ?)`
  ).run(plan.dateIso, new Date().toISOString(), plan.header, JSON.stringify(plan.tracks));
}
