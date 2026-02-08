import fs from 'node:fs';
import path from 'node:path';

import type { Db } from '../db.js';
import { hasDigestBeenSent, markDigestSent, type DigestMessagePlan } from './plan.js';
import { sleep } from '../sleep.js';

export interface SendFn {
  (message: string): Promise<void>;
}

export interface DeliverOptions {
  db: Db;
  plan: DigestMessagePlan;
  alreadySent: boolean;
  discoveryErrors?: Array<{ category: string; error: string }>;
  delayMsBetweenMessages?: number;
}

export interface DeliverResult {
  sent: boolean;
  skippedAlreadySent: boolean;
  sentCount: number;
}

function formatDiscoveryNote(discoveryErrors: Array<{ category: string; error: string }>): string {
  const cats = discoveryErrors.map((e) => e.category).join(', ');
  return `\n\nNote: arXiv discovery had issues today (rate limiting or transient errors). Categories affected: ${cats}. We'll retry next run.`;
}

export async function deliverDailyDigest(send: SendFn, opts: DeliverOptions): Promise<DeliverResult> {
  const {
    db,
    plan,
    alreadySent,
    discoveryErrors = [],
    delayMsBetweenMessages = 600,
  } = opts;

  // Double-check idempotency at delivery time.
  if (alreadySent || hasDigestBeenSent(db, plan.dateIso)) {
    return { sent: false, skippedAlreadySent: true, sentCount: 0 };
  }

  let header = plan.header;
  if (discoveryErrors.length > 0) {
    header += formatDiscoveryNote(discoveryErrors);
  }

  // Send header + track messages
  let sentCount = 0;
  await send(header);
  sentCount += 1;

  for (const t of plan.tracks) {
    await sleep(delayMsBetweenMessages);
    await send(t.message);
    sentCount += 1;
  }

  // Mark sent only after all messages succeeded.
  markDigestSent(db, { ...plan, header });

  return { sent: true, skippedAlreadySent: false, sentCount };
}

export function writePlanJson(outPath: string, data: unknown) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
}
