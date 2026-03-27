#!/usr/bin/env tsx
/**
 * ask.ts — CLI entry point for the /ask command.
 *
 * Usage:
 *   npm run ask -- 2402.01234 "what is the key contribution?"
 *   npm run ask -- arxiv:2501.99999 how does speculative decoding work here
 *
 * The arxiv ID is the first positional argument.
 * Everything after it is the question (no quotes needed).
 *
 * Output:
 *   Prints the formatted Signal reply to stdout.
 *   Exits 0 on success, 1 on error.
 */

import path from 'node:path';
import { openDb, migrate } from '../lib/db.js';
import { ensureFeedbackTables } from '../lib/feedback/migrate.js';
import { extractArxivId } from '../lib/feedback/parser.js';
import { askPaper, formatAskReply } from '../lib/ask/askPaper.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    process.stderr.write(
      'Usage: tsx src/cli/ask.ts <arxiv-id> <question>\n\n' +
        'Examples:\n' +
        '  tsx src/cli/ask.ts 2402.01234 "what is the key contribution?"\n' +
        '  tsx src/cli/ask.ts arxiv:2501.99999 how does speculative decoding work\n',
    );
    process.exit(1);
  }

  const [idArg, ...questionParts] = args;
  const question = questionParts.join(' ').trim();

  const arxivId = extractArxivId(idArg ?? '');
  if (!arxivId) {
    process.stderr.write(`Error: could not parse arxiv ID from: "${idArg}"\n`);
    process.exit(1);
  }

  const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);
  const dbPath = path.join(repoRoot, 'data', 'db.sqlite');

  const db = openDb(dbPath);
  migrate(db);
  ensureFeedbackTables(db);

  try {
    const result = await askPaper({ db, arxivId, question });

    if (!result.ok) {
      process.stderr.write(result.message + '\n');
      process.exit(1);
    }

    const reply = formatAskReply(result);
    process.stdout.write(reply + '\n');
    process.exit(0);
  } finally {
    db.sqlite.close();
  }
}

main().catch((err) => {
  process.stderr.write(`Unhandled error: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
