#!/usr/bin/env tsx
/**
 * send-daily-digest.ts — Standalone daily digest runner.
 *
 * Replaces the multi-step LLM agent cron with a single deterministic script:
 *   1. Run plan-daily-fast inline (no subprocess)
 *   2. If alreadySent: exit cleanly
 *   3. Send header + per-track messages to Telegram
 *   4. Mark sent in DB
 *
 * Exit codes:
 *   0  — success (sent) or already-sent (skipped)
 *   1  — fatal error (Telegram fail, DB issue, etc.)
 *
 * Usage:
 *   npm run send-daily-digest
 *   tsx --env-file=.env src/scripts/send-daily-digest.ts
 *
 * Environment:
 *   TELEGRAM_BOT_TOKEN  — required for sending (or OPENCLAW_TELEGRAM_BOT_TOKEN)
 *   TELEGRAM_CHAT_ID    — Mikey's Telegram ID (default: 8549060322)
 *   DRY_RUN             — set to "1" to skip sending + marking (for testing)
 */

import path from 'node:path';
import fs from 'node:fs';
import https from 'node:https';

import { loadConfig, loadTracks } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';
import { ensureStorageRoot, upsertPaper, upsertTrackMatch } from '../lib/repo.js';
import { selectDailyByTrack } from '../lib/digest/select.js';
import { renderDailyMarkdown, renderHeaderSignalMessage, renderTrackSignalMessage } from '../lib/digest/render.js';
import { ensureDir, dailyDigestPath, paperPaths } from '../lib/storage.js';
import { hasDigestBeenSent, markDigestSent } from '../lib/notify/plan.js';
import { fetchAtom, parseAtom, withinLastDays } from '../lib/arxiv.js';
import { matchTrack } from '../lib/match.js';

// ── Config ─────────────────────────────────────────────────────────────────

const BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN ||
  process.env.OPENCLAW_TELEGRAM_BOT_TOKEN ||
  loadBotTokenFromOpenClaw();

const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8549060322';
const DRY_RUN = process.env.DRY_RUN === '1';
const INTER_MESSAGE_DELAY_MS = 600;

function loadBotTokenFromOpenClaw(): string {
  const configPath = '/root/.openclaw/openclaw.json';
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      channels?: { telegram?: { botToken?: string } };
    };
    return raw.channels?.telegram?.botToken ?? '';
  } catch {
    return '';
  }
}

// ── Telegram sending ───────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendTelegram(text: string): Promise<void> {
  if (DRY_RUN) {
    console.log('[DRY_RUN] Would send:', text.slice(0, 80), '...');
    return;
  }

  if (!BOT_TOKEN) throw new Error('No Telegram bot token found');

  const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'Markdown' });

  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const parsed = JSON.parse(data) as { ok: boolean; description?: string };
          if (parsed.ok) {
            resolve();
          } else {
            reject(new Error(`Telegram API error: ${parsed.description}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Main pipeline ──────────────────────────────────────────────────────────

async function main() {
  const repoRoot = path.resolve(process.cwd());
  const config = loadConfig(repoRoot);
  const tracksFile = loadTracks(repoRoot);

  ensureStorageRoot(config);

  const dbPath = path.join(config.storage.root, 'db.sqlite');
  const db = openDb(dbPath);
  migrate(db);

  const now = new Date();
  const daysWindow = 3;
  const fetchMaxResults = 100;

  function isoDate(d: Date): string {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  const dateIso = isoDate(now);

  // Early exit if already sent today
  if (hasDigestBeenSent(db, dateIso) && !DRY_RUN) {
    console.log(JSON.stringify({ status: 'skipped', reason: 'already_sent', dateIso }));
    process.exit(0);
  }

  // Fast-path fetch options — tight budget to stay within 60s per fetch
  const fastFetchOpts = {
    maxAttempts: 2,
    fetchTimeoutMs: 10_000,
    maxBackoffMs: 5_000,
  };

  const enabledTracks = tracksFile.tracks.filter((t) => t.enabled);
  const discoveryErrors: Array<{ category: string; error: string }> = [];

  // Step 1+2: Fetch arxiv + match tracks
  // Fetch ALL categories in parallel — reduces worst-case from N×25s to ~25s.
  // DB writes remain serial (SQLite sync) after all fetches complete.
  console.log(`[send-daily-digest] Fetching ${config.discovery.categories.length} categories (parallel)...`);

  const fetchResults = await Promise.allSettled(
    config.discovery.categories.map(async (cat) => {
      const xml = await fetchAtom(cat, fetchMaxResults, fastFetchOpts);
      return { cat, xml };
    })
  );

  for (let i = 0; i < config.discovery.categories.length; i++) {
    const cat = config.discovery.categories[i]!;
    const result = fetchResults[i]!;

    if (result.status === 'rejected') {
      const reason = result.reason as { message?: string } | string | undefined;
      const msg = String(typeof reason === 'object' && reason !== null ? reason.message ?? reason : reason);
      console.warn(`Discovery fetch failed for ${cat}: ${msg}`);
      discoveryErrors.push({ category: cat, error: msg });
      continue;
    }

    const { xml } = result.value;
    const entries = parseAtom(xml);
    const recent = entries.filter((e) => withinLastDays(e.updatedAt || e.publishedAt, daysWindow, now));

    for (const entry of recent) {
      upsertPaper(db, config, entry);

      for (const track of enabledTracks) {
        if (track.categories?.length) {
          const ok = entry.categories.some((c) => track.categories.includes(c));
          if (!ok) continue;
        }

        const m = matchTrack(track, entry.title, entry.summary);
        if (m.score >= track.threshold) {
          upsertTrackMatch(db, entry.arxivId, track.name, m.score, m.matchedTerms);
        }
      }

      // Write minimal meta.json
      try {
        const { metaPath, paperDir } = paperPaths(config.storage.root, entry.arxivId, new Date(entry.updatedAt));
        fs.mkdirSync(paperDir, { recursive: true });
        fs.writeFileSync(metaPath, JSON.stringify(entry, null, 2));
      } catch {
        // ignore
      }
    }
  }

  // Step 3: Select + render
  const selection = selectDailyByTrack(db, {
    maxItemsPerDigest: config.limits.maxItemsPerDigest,
    maxPerTrack: config.limits.maxPerTrackPerDay,
    dedupDays: 21,
  });

  const md = renderDailyMarkdown(dateIso, selection.byTrack);
  const digestPath = dailyDigestPath(config.storage.root, now);
  ensureDir(path.dirname(digestPath));
  fs.writeFileSync(digestPath, md);

  if (selection.totals.items === 0) {
    console.log(JSON.stringify({ status: 'empty', reason: 'no_papers_today', dateIso }));
    process.exit(0);
  }

  const header = renderHeaderSignalMessage(dateIso, selection.byTrack);
  const perTrack = Array.from(selection.byTrack.entries()).map(([track, papers]) => ({
    track,
    ...renderTrackSignalMessage(track, papers),
  }));

  // Build digest plan (same format as mark-sent.ts expects)
  const digestPapers: Array<{ arxivId: string; trackName: string }> = [];
  for (const [trackName, papers] of selection.byTrack.entries()) {
    for (const p of papers) {
      digestPapers.push({ arxivId: p.arxivId, trackName });
    }
  }

  // Step 4: Send to Telegram
  console.log(`[send-daily-digest] Sending ${selection.totals.items} papers across ${selection.totals.tracksWithItems} tracks...`);

  try {
    // Send header
    await sendTelegram(header.text);
    await sleep(INTER_MESSAGE_DELAY_MS);

    // Send per-track messages
    for (const { track, text } of perTrack) {
      await sendTelegram(text);
      await sleep(INTER_MESSAGE_DELAY_MS);
      console.log(`[send-daily-digest] Sent track: ${track}`);
    }
  } catch (err) {
    console.error('[send-daily-digest] Telegram send failed:', err);
    console.log(JSON.stringify({ status: 'error', error: String(err), dateIso }));
    process.exit(1);
  }

  // Step 5: Mark sent
  if (!DRY_RUN) {
    markDigestSent(db, {
      dateIso,
      header: header.text,
      tracks: perTrack.map((m) => ({ track: m.track, message: m.text })),
      digestPath,
      papers: digestPapers,
    });
    console.log(`[send-daily-digest] Marked sent for ${dateIso}`);
  }

  console.log(JSON.stringify({
    status: 'sent',
    dateIso,
    items: selection.totals.items,
    tracksWithItems: selection.totals.tracksWithItems,
    discoveryErrors: discoveryErrors.length,
    dryRun: DRY_RUN,
  }));
}

main().catch((err) => {
  console.error('[send-daily-digest] Fatal error:', err);
  process.exit(1);
});
