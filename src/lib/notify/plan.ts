import type { Db } from '../db.js';

export interface DigestMessagePlan {
  dateIso: string;
  header: string;
  tracks: Array<{ track: string; message: string }>;
  digestPath: string;
  // Optional: list of papers included in this digest for dedup tracking
  papers?: Array<{ arxivId: string; trackName: string }>;
}

export function hasDigestBeenSent(db: Db, dateIso: string): boolean {
  const row = db.sqlite.prepare('SELECT digest_date FROM sent_digests WHERE digest_date=?').get(dateIso) as any;
  return Boolean(row);
}

export function markDigestSent(db: Db, plan: DigestMessagePlan) {
  const sentAt = new Date().toISOString();

  const insertDigest = db.sqlite.prepare(
    `INSERT OR REPLACE INTO sent_digests (digest_date, kind, sent_at, header_text, tracks_json)
     VALUES (?, 'daily', ?, ?, ?)`
  );

  const insertPaper = db.sqlite.prepare(
    `INSERT OR IGNORE INTO digest_papers (arxiv_id, digest_date, track_name, sent_at)
     VALUES (?, ?, ?, ?)`
  );

  const tx = db.sqlite.transaction(() => {
    insertDigest.run(plan.dateIso, sentAt, plan.header, JSON.stringify(plan.tracks));
    if (plan.papers) {
      for (const p of plan.papers) {
        insertPaper.run(p.arxivId, plan.dateIso, p.trackName, sentAt);
      }
    }
  });

  tx();
}
