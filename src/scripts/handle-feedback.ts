#!/usr/bin/env tsx
/**
 * handle-feedback.ts — CLI entry point for Signal feedback command processing.
 *
 * Reads a Signal message from argv or stdin, parses it for arxiv feedback
 * commands, records to SQLite, and outputs a JSON result.
 *
 * Usage:
 *   tsx src/scripts/handle-feedback.ts "/read 2403.12345"
 *   echo "/save 2501.98765 --notes 'Great paper'" | tsx src/scripts/handle-feedback.ts
 *
 * Output (JSON on stdout):
 *   { "shouldReply": true, "wasCommand": true, "reply": "✅ Read: ...", "arxivId": "2403.12345" }
 *   { "shouldReply": false, "wasCommand": false }
 *
 * Exit codes:
 *   0 — success (even if not a command or paper not found)
 *   1 — fatal error (db init failure, missing config, etc.)
 *
 * Integration with OpenClaw cron:
 *   The cron agent calls this script with the incoming Signal message text.
 *   If shouldReply=true, the agent sends `reply` back to Mikey on Signal.
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
