import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';
import { updateGapStatus, createLearningSession, getGap } from '../lib/gaps/index.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const gapId = args[0];

  if (!gapId) {
    console.error('Usage: npm run mark-gap-lesson-sent -- <gapId> [--lesson-content "..."] [--model "sonnet"]');
    process.exit(1);
  }

  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg?.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      }
    }
  }

  return { gapId, flags };
}

const { gapId, flags } = parseArgs();

const repoRoot = path.resolve(process.cwd());
const config = loadConfig(repoRoot);
const dbPath = path.join(config.storage.root, 'db.sqlite');
const db = openDb(dbPath);
migrate(db);

// Verify gap exists
const gap = getGap(db, gapId);
if (!gap) {
  console.error(JSON.stringify({ kind: 'error', message: 'Gap not found', gapId }));
  process.exit(1);
}

const now = new Date().toISOString();

// Update gap status
updateGapStatus(db, gapId, 'lesson_sent', {
  lessonSentAt: now,
  lessonGeneratedAt: now,
});

// Create learning session if lesson content provided
if (flags['lesson-content']) {
  createLearningSession(db, {
    gapId,
    lessonType: 'micro',
    lessonContent: flags['lesson-content'],
    deliveredVia: 'signal',
    generationModel: flags.model ?? 'sonnet',
  });
}

console.log(
  JSON.stringify({
    kind: 'gapLessonSent',
    gapId,
    concept: gap.concept,
    status: 'lesson_sent',
    sentAt: now,
  })
);
