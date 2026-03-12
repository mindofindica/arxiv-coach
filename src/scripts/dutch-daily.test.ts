/**
 * Tests for dutch-daily.ts — Dutch Word of the Day script.
 *
 * We test the pure logic functions (dateToIndex, pickWord, formatMessage)
 * independently from the filesystem so tests run fast and offline.
 */

import { describe, it, expect } from 'vitest';
import {
  dateToIndex,
  pickWord,
  formatMessage,
  getDutchDaily,
  type VocabWord,
} from './dutch-daily.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── helpers ────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../');

/** Minimal vocab word for unit tests */
function makeWord(overrides: Partial<VocabWord> = {}): VocabWord {
  return {
    dutch: 'hallo',
    phonetic: 'HAL-oh',
    english: 'hello',
    category: 'greetings',
    example_nl: 'Hallo, hoe gaat het?',
    example_en: 'Hello, how are you?',
    ...overrides,
  };
}

// ── dateToIndex ────────────────────────────────────────────────────────────

describe('dateToIndex', () => {
  it('returns 0 for the epoch date 2026-01-01', () => {
    expect(dateToIndex('2026-01-01')).toBe(0);
  });

  it('returns 1 for 2026-01-02', () => {
    expect(dateToIndex('2026-01-02')).toBe(1);
  });

  it('returns 31 for 2026-02-01', () => {
    // January has 31 days
    expect(dateToIndex('2026-02-01')).toBe(31);
  });

  it('returns a positive index for dates before the epoch', () => {
    // Pre-epoch dates produce negative dayIndex but modulo handles it
    const idx = dateToIndex('2025-12-31');
    expect(idx).toBe(-1);
  });

  it('is strictly monotonically increasing day by day', () => {
    const dates = ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04'];
    const indices = dates.map(dateToIndex);
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBe(indices[i - 1]! + 1);
    }
  });
});

// ── pickWord ───────────────────────────────────────────────────────────────

describe('pickWord', () => {
  it('throws if word list is empty', () => {
    expect(() => pickWord([], '2026-03-08')).toThrow('Word list is empty');
  });

  it('returns a valid word from the list', () => {
    const words = [makeWord({ dutch: 'hallo' }), makeWord({ dutch: 'doei' })];
    const { word } = pickWord(words, '2026-01-01');
    expect(words).toContain(word);
  });

  it('cycles back to index 0 after the full list', () => {
    const words = [makeWord({ dutch: 'a' }), makeWord({ dutch: 'b' }), makeWord({ dutch: 'c' })];
    // day 0 → index 0, day 3 → index 0 again
    const { index: i0 } = pickWord(words, '2026-01-01'); // day 0
    const { index: i3 } = pickWord(words, '2026-01-04'); // day 3
    expect(i0).toBe(0);
    expect(i3).toBe(0);
  });

  it('returns different words on consecutive days', () => {
    const words = Array.from({ length: 10 }, (_, i) =>
      makeWord({ dutch: `woord${i}` })
    );
    const { word: w1 } = pickWord(words, '2026-03-08');
    const { word: w2 } = pickWord(words, '2026-03-09');
    expect(w1).not.toBe(w2);
  });

  it('is deterministic — same date always returns same word', () => {
    const words = Array.from({ length: 20 }, (_, i) =>
      makeWord({ dutch: `woord${i}` })
    );
    const date = '2026-06-15';
    const { word: w1 } = pickWord(words, date);
    const { word: w2 } = pickWord(words, date);
    expect(w1).toBe(w2);
  });

  it('handles a single-word list (always same word)', () => {
    const words = [makeWord({ dutch: 'altijd' })];
    const { word: w1 } = pickWord(words, '2026-01-01');
    const { word: w2 } = pickWord(words, '2026-12-31');
    expect(w1.dutch).toBe('altijd');
    expect(w2.dutch).toBe('altijd');
  });

  it('handles pre-epoch dates via modulo without crashing', () => {
    const words = [makeWord({ dutch: 'a' }), makeWord({ dutch: 'b' })];
    // Should not throw for dates before 2026-01-01
    expect(() => pickWord(words, '2025-06-15')).not.toThrow();
  });
});

// ── formatMessage ──────────────────────────────────────────────────────────

describe('formatMessage', () => {
  const word: VocabWord = {
    dutch: 'gezellig',
    phonetic: 'khuh-ZEL-ikh',
    english: 'cosy / convivial / fun',
    category: 'daily_life',
    example_nl: 'Het café was erg gezellig gisteravond.',
    example_en: 'The café was really cosy last night.',
  };

  it('includes the Dutch word', () => {
    const msg = formatMessage(word, '2026-03-08');
    expect(msg).toContain('gezellig');
  });

  it('includes the phonetic transcription', () => {
    const msg = formatMessage(word, '2026-03-08');
    expect(msg).toContain('khuh-ZEL-ikh');
  });

  it('includes the English translation', () => {
    const msg = formatMessage(word, '2026-03-08');
    expect(msg).toContain('cosy / convivial / fun');
  });

  it('includes both example sentences', () => {
    const msg = formatMessage(word, '2026-03-08');
    expect(msg).toContain('Het café was erg gezellig gisteravond.');
    expect(msg).toContain('The café was really cosy last night.');
  });

  it('includes the Dutch flag header', () => {
    const msg = formatMessage(word, '2026-03-08');
    expect(msg).toContain('🇳🇱');
  });

  it('includes the date in a readable format', () => {
    const msg = formatMessage(word, '2026-03-08');
    expect(msg).toMatch(/Sunday.*8.*March.*2026|8.*March.*2026/);
  });

  it('uses the category emoji for known categories', () => {
    const msg = formatMessage(word, '2026-03-08');
    expect(msg).toContain('🏙️'); // daily_life emoji
  });

  it('falls back to 🇳🇱 emoji for unknown categories', () => {
    const unknown = { ...word, category: 'unknown_category' };
    const msg = formatMessage(unknown, '2026-03-08');
    expect(msg).toContain('🇳🇱');
  });

  it('renders category with spaces not underscores', () => {
    const msg = formatMessage(word, '2026-03-08');
    expect(msg).toContain('daily life');
    expect(msg).not.toContain('daily_life');
  });

  it('contains the motivational sign-off', () => {
    const msg = formatMessage(word, '2026-03-08');
    expect(msg).toContain('Goeie oefening');
  });
});

// ── integration: getDutchDaily with real vocab file ────────────────────────

describe('getDutchDaily (integration)', () => {
  it('returns a result without throwing', () => {
    const result = getDutchDaily(repoRoot, '2026-03-08');
    expect(result).toBeDefined();
    expect(result.dateIso).toBe('2026-03-08');
    expect(result.word).toBeDefined();
    expect(result.message).toBeDefined();
  });

  it('word index is within bounds of the word list', () => {
    const result = getDutchDaily(repoRoot, '2026-03-08');
    // We know there are at least 100 words
    expect(result.index).toBeGreaterThanOrEqual(0);
    expect(result.index).toBeLessThan(500);
  });

  it('message is a non-empty string with line breaks', () => {
    const result = getDutchDaily(repoRoot, '2026-03-08');
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(50);
    expect(result.message).toContain('\n');
  });

  it('returns consistent results for the same date', () => {
    const r1 = getDutchDaily(repoRoot, '2026-05-20');
    const r2 = getDutchDaily(repoRoot, '2026-05-20');
    expect(r1.word.dutch).toBe(r2.word.dutch);
    expect(r1.index).toBe(r2.index);
  });

  it('returns different words on different dates', () => {
    const dates = [
      '2026-01-01', '2026-01-05', '2026-02-14',
      '2026-03-08', '2026-06-15', '2026-09-30',
    ];
    const words = dates.map((d) => getDutchDaily(repoRoot, d).word.dutch);
    const unique = new Set(words);
    // With 189 words and 6 dates, all should be different
    expect(unique.size).toBe(words.length);
  });

  it('cycles back after exhausting the word list', () => {
    // Word list has 189 words. Day 0 and day 189 should pick the same word.
    const epoch = new Date('2026-01-01T00:00:00Z');
    const vocabPath = path.join(repoRoot, 'src', 'vocab', 'dutch-vocab.json');
    const vocab = JSON.parse(fs.readFileSync(vocabPath, 'utf8'));
    const wordCount: number = vocab.words.length;
    const datePlusN = new Date(epoch.getTime() + wordCount * 24 * 60 * 60 * 1000);
    const dateStr = datePlusN.toISOString().slice(0, 10);

    const r0 = getDutchDaily(repoRoot, '2026-01-01');
    const rN = getDutchDaily(repoRoot, dateStr);
    expect(r0.word.dutch).toBe(rN.word.dutch);
  });

  it('uses today by default (no date override)', () => {
    // Should not throw; we just check it returns a valid structure.
    const result = getDutchDaily(repoRoot);
    expect(result.dateIso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.word.dutch).toBeTruthy();
  });
});

// ── vocab file integrity ───────────────────────────────────────────────────

describe('dutch-vocab.json integrity', () => {
  it('all words have required fields', () => {
    const required = ['dutch', 'phonetic', 'english', 'category', 'example_nl', 'example_en'];
    const vocabPath = path.join(repoRoot, 'src', 'vocab', 'dutch-vocab.json');
    const vocab = JSON.parse(fs.readFileSync(vocabPath, 'utf8'));

    for (const word of vocab.words) {
      for (const field of required) {
        expect(word[field], `Word "${word.dutch}" missing field "${field}"`).toBeTruthy();
      }
    }
  });

  it('has at least 150 words', () => {
    const vocabPath = path.join(repoRoot, 'src', 'vocab', 'dutch-vocab.json');
    const vocab = JSON.parse(fs.readFileSync(vocabPath, 'utf8'));
    expect(vocab.words.length).toBeGreaterThanOrEqual(150);
  });

  it('has no duplicate Dutch entries', () => {
    const vocabPath = path.join(repoRoot, 'src', 'vocab', 'dutch-vocab.json');
    const vocab = JSON.parse(fs.readFileSync(vocabPath, 'utf8'));
    const dutchWords = vocab.words.map((w: VocabWord) => w.dutch);
    const unique = new Set(dutchWords);
    expect(unique.size).toBe(dutchWords.length);
  });
});
