/**
 * dutch-daily.ts
 *
 * Picks today's Dutch word-of-the-day (deterministically by date, cycling
 * through the full wordlist so no word repeats until the whole list is seen).
 *
 * Usage:
 *   npm run dutch-daily                  → prints Signal message to stdout
 *   npm run dutch-daily -- --json        → prints JSON envelope to stdout
 *   npm run dutch-daily -- --date 2026-04-01  → override date (YYYY-MM-DD)
 *
 * The output is consumed by the OpenClaw daily cron which forwards the
 * message to Mikey's Signal.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── types ──────────────────────────────────────────────────────────────────

export interface VocabWord {
  dutch: string;
  phonetic: string;
  english: string;
  category: string;
  example_nl: string;
  example_en: string;
}

export interface VocabFile {
  meta: { version: number; level: string; description: string; totalWords: number };
  words: VocabWord[];
}

export interface DutchDailyResult {
  dateIso: string;
  index: number;
  word: VocabWord;
  message: string;
}

// ── category emoji map ─────────────────────────────────────────────────────

const CATEGORY_EMOJI: Record<string, string> = {
  greetings: '👋',
  numbers: '🔢',
  transport: '🚲',
  food: '🍽️',
  work: '💼',
  daily_life: '🏙️',
  time: '⏰',
  adjectives: '✨',
  pronouns: '🗣️',
  verbs: '⚡',
  places: '📍',
  people: '👥',
  health: '💪',
  hobbies: '🎯',
  home: '🏠',
  phrases: '💬',
  nature: '🌿',
  language: '📚',
};

// ── core logic ─────────────────────────────────────────────────────────────

/**
 * Parse a YYYY-MM-DD string into a stable integer day-index.
 * The epoch (2026-01-01) → 0. Each subsequent day → +1.
 */
export function dateToIndex(dateIso: string): number {
  const epoch = new Date('2026-01-01T00:00:00Z');
  const date = new Date(`${dateIso}T00:00:00Z`);
  const diffMs = date.getTime() - epoch.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Pick the word for a given date. Cycles deterministically through the list.
 */
export function pickWord(words: VocabWord[], dateIso: string): { word: VocabWord; index: number } {
  if (words.length === 0) throw new Error('Word list is empty');
  const dayIndex = dateToIndex(dateIso);
  // Use modulo so we cycle through the full list before repeating.
  const index = ((dayIndex % words.length) + words.length) % words.length;
  return { word: words[index]!, index };
}

/**
 * Format the Signal message for a word-of-the-day.
 */
export function formatMessage(word: VocabWord, dateIso: string): string {
  const emoji = CATEGORY_EMOJI[word.category] ?? '🇳🇱';
  const categoryLabel = word.category.replace(/_/g, ' ');

  // Date label: "Sunday, 8 March 2026"
  const dateObj = new Date(`${dateIso}T12:00:00Z`);
  const dateFmt = dateObj.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return [
    `🇳🇱 *Dutch Word of the Day* — ${dateFmt}`,
    ``,
    `${emoji} *${word.dutch}*`,
    `📢 /${word.phonetic}/`,
    `🇬🇧 ${word.english}`,
    ``,
    `📝 *Example:*`,
    `_${word.example_nl}_`,
    `_${word.example_en}_`,
    ``,
    `🏷️ Category: ${categoryLabel}`,
    ``,
    `_Goeie oefening! 💪_`,
  ].join('\n');
}

/**
 * Load the vocab file relative to the repo root.
 */
export function loadVocab(repoRoot: string): VocabFile {
  const vocabPath = path.join(repoRoot, 'src', 'vocab', 'dutch-vocab.json');
  if (!fs.existsSync(vocabPath)) {
    throw new Error(`Vocab file not found: ${vocabPath}`);
  }
  const raw = fs.readFileSync(vocabPath, 'utf8');
  return JSON.parse(raw) as VocabFile;
}

/**
 * Main function: picks today's word, returns the full result.
 */
export function getDutchDaily(repoRoot: string, dateIso?: string): DutchDailyResult {
  const today = dateIso ?? new Date().toISOString().slice(0, 10);
  const vocab = loadVocab(repoRoot);
  const { word, index } = pickWord(vocab.words, today);
  const message = formatMessage(word, today);
  return { dateIso: today, index, word, message };
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────

// Only run when executed directly (not imported in tests).
const isMain = process.argv[1] === fileURLToPath(import.meta.url)
  || process.argv[1]?.endsWith('dutch-daily.ts')
  || process.argv[1]?.endsWith('dutch-daily.js');

if (isMain) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');

  // Parse optional --date YYYY-MM-DD override
  const dateIdx = args.indexOf('--date');
  const dateOverride = dateIdx !== -1 ? args[dateIdx + 1] : undefined;

  const repoRoot = path.resolve(process.cwd());
  const result = getDutchDaily(repoRoot, dateOverride);

  if (jsonMode) {
    console.log(JSON.stringify({
      kind: 'dutchDaily',
      dateIso: result.dateIso,
      index: result.index,
      word: result.word,
      message: result.message,
    }, null, 2));
  } else {
    // Plain text mode — just print the Signal message.
    console.log(result.message);
  }
}
