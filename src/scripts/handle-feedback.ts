#!/usr/bin/env tsx
/**
 * handle-feedback.ts — CLI entry point for Signal feedback command processing.
 *
 * Reads a Signal message from argv or stdin, parses it for arxiv feedback
 * commands, records to SQLite, and outputs a JSON result.
 *
 * Supported commands:
 *   /read 2403.12345           — mark as read (signal +8)
 *   /skip 2403.12345           — deprioritise (signal -5)
 *   /save 2403.12345           — add to reading list (signal +5)
 *   /love 2403.12345           — strong positive (signal +10); bumps reading-list priority
 *   /meh 2403.12345            — weak signal (-2)
 *   /reading-list              — show unread saved papers (default: 5)
 *   /reading-list --status all --limit 10
 *   /status                    — system health snapshot (digest, papers, reading list, feedback)
 *   /stats                     — 7-day activity breakdown (feedback counts, top tracks)
 *   /stats --days 30           — longer window (1-90 days)
 *   /weekly                    — weekly paper summary (current week)
 *   /weekly --week 2026-W07    — specific ISO week
 *   /weekly --track LLM        — filter to one track
 *   /search speculative decoding — full-text search over paper library
 *   /search RAG --limit 3      — limit to 3 results
 *   /search inference --track "LLM Efficiency" — filter by track
 *
 * All feedback commands support optional flags (Signal-safe unquoted form):
 *   --notes interesting ML approach    (captured as full multi-word string)
 *   --reason too theoretical for now   (same)
 *   --priority 7                       (for /save, 1-10)
 *
 * Usage:
 *   tsx src/scripts/handle-feedback.ts "/read 2403.12345"
 *   tsx src/scripts/handle-feedback.ts "/reading-list --status all --limit 10"
 *   tsx src/scripts/handle-feedback.ts "/status"
 *   tsx src/scripts/handle-feedback.ts "/stats --days 14"
 *   tsx src/scripts/handle-feedback.ts "/weekly"
 *   tsx src/scripts/handle-feedback.ts "/weekly --week 2026-W07"
 *   tsx src/scripts/handle-feedback.ts "/weekly --track LLM"
 *   tsx src/scripts/handle-feedback.ts "/search speculative decoding"
 *   tsx src/scripts/handle-feedback.ts "/search RAG --limit 3"
 *   echo "/save 2501.98765 --notes great dataset" | tsx src/scripts/handle-feedback.ts
 *
 * Output (JSON on stdout):
 *   { "shouldReply": true, "wasCommand": true, "reply": "✅ Read: ...", "arxivId": "2403.12345" }
 *   { "shouldReply": true, "wasCommand": true, "reply": "📚 Reading list..." }
 *   { "shouldReply": false, "wasCommand": false }
 *
 * Exit codes:
 *   0 — success (even if not a command or paper not found)
 *   1 — fatal error (db init failure, missing config, etc.)
 *
 * Integration with OpenClaw HEARTBEAT:
 *   The main session handles incoming Signal messages matching:
 *   /read /skip /save /love /meh /reading-list /status /stats /weekly
 *   If shouldReply=true, Indica sends `reply` back to Mikey on Signal.
 *   Full reference: docs/signal-commands.md
 */

import path from 'node:path';
import { createFeedbackHandler } from '../lib/feedback/handler.js';

async function main(): Promise<void> {
  let messageText: string;

  // Try argv first
  const argText = process.argv[2];
  if (argText !== undefined && argText.trim() !== '') {
    messageText = argText;
  } else {
    // Fall back to stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    messageText = Buffer.concat(chunks).toString('utf8').trim();
  }

  if (!messageText) {
    process.stdout.write(
      JSON.stringify({ shouldReply: false, wasCommand: false, error: 'no_input' }) + '\n',
    );
    process.exit(0);
  }

  const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);

  let handler: ReturnType<typeof createFeedbackHandler>;
  try {
    handler = createFeedbackHandler({ repoRoot });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Fatal: could not initialise feedback handler: ${msg}\n`);
    process.exit(1);
  }

  try {
    const result = handler.handle(messageText);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  } finally {
    handler.close();
  }
}

main().catch((err) => {
  process.stderr.write(`Unhandled error: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
