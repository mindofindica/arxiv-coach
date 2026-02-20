/**
 * Tests for Signal feedback command parser.
 */

import { describe, it, expect } from 'vitest';
import { parseFeedbackMessage, extractArxivId } from './parser.js';

// ── extractArxivId ─────────────────────────────────────────────────────────

describe('extractArxivId', () => {
  it('extracts bare new-style ID (4+5)', () => {
    expect(extractArxivId('2403.12345')).toBe('2403.12345');
  });

  it('extracts bare new-style ID (4+4)', () => {
    expect(extractArxivId('2403.1234')).toBe('2403.1234');
  });

  it('strips version suffix', () => {
    expect(extractArxivId('2403.12345v2')).toBe('2403.12345');
  });

  it('extracts from arxiv: prefix', () => {
    expect(extractArxivId('arxiv:2403.12345')).toBe('2403.12345');
  });

  it('extracts from arxiv: prefix (case-insensitive)', () => {
    expect(extractArxivId('ArXiv:2403.12345')).toBe('2403.12345');
  });

  it('extracts from abs URL', () => {
    expect(extractArxivId('https://arxiv.org/abs/2403.12345')).toBe('2403.12345');
  });

  it('extracts from pdf URL', () => {
    expect(extractArxivId('https://arxiv.org/pdf/2403.12345')).toBe('2403.12345');
  });

  it('extracts from versioned abs URL', () => {
    expect(extractArxivId('https://arxiv.org/abs/2403.12345v3')).toBe('2403.12345');
  });

  it('returns null for random text', () => {
    expect(extractArxivId('hello world')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractArxivId('')).toBeNull();
  });
});

// ── parseFeedbackMessage ────────────────────────────────────────────────────

describe('parseFeedbackMessage', () => {
  // ── Not a command ──────────────────────────────────────────────────────

  it('returns not_a_command for plain text', () => {
    const r = parseFeedbackMessage('Hey, what do you think?');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('not_a_command');
  });

  it('returns not_a_command for empty string', () => {
    const r = parseFeedbackMessage('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('not_a_command');
  });

  // ── Unknown command ────────────────────────────────────────────────────

  it('returns unknown_command for /bookmark', () => {
    const r = parseFeedbackMessage('/bookmark 2403.12345');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('unknown_command');
  });

  it('returns unknown_command for /start (telegram-style)', () => {
    const r = parseFeedbackMessage('/start');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('unknown_command');
  });

  // ── Missing arxiv ID ───────────────────────────────────────────────────

  it('returns missing_arxiv_id for bare /read', () => {
    const r = parseFeedbackMessage('/read');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('missing_arxiv_id');
  });

  it('returns missing_arxiv_id for /skip with only spaces', () => {
    const r = parseFeedbackMessage('/skip   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('missing_arxiv_id');
  });

  // ── Invalid arxiv ID ───────────────────────────────────────────────────

  it('returns invalid_arxiv_id for /read with gibberish ID', () => {
    const r = parseFeedbackMessage('/read notanid');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_arxiv_id');
  });

  // ── Valid commands ─────────────────────────────────────────────────────

  it('parses /read with bare ID', () => {
    const r = parseFeedbackMessage('/read 2403.12345');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'feedback') {
      expect(r.feedback.feedbackType).toBe('read');
      expect(r.feedback.arxivId).toBe('2403.12345');
      expect(r.feedback.notes).toBeNull();
      expect(r.feedback.reason).toBeNull();
    }
  });

  it('parses /skip with bare ID', () => {
    const r = parseFeedbackMessage('/skip 2403.12345');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'feedback') {
      expect(r.feedback.feedbackType).toBe('skip');
      expect(r.feedback.arxivId).toBe('2403.12345');
    }
  });

  it('parses /save with bare ID', () => {
    const r = parseFeedbackMessage('/save 2403.12345');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'feedback') {
      expect(r.feedback.feedbackType).toBe('save');
      expect(r.feedback.arxivId).toBe('2403.12345');
    }
  });

  it('parses /love with bare ID', () => {
    const r = parseFeedbackMessage('/love 2403.12345');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'feedback') expect(r.feedback.feedbackType).toBe('love');
  });

  it('parses /meh with bare ID', () => {
    const r = parseFeedbackMessage('/meh 2403.12345');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'feedback') expect(r.feedback.feedbackType).toBe('meh');
  });

  it('parses versioned ID (strips version)', () => {
    const r = parseFeedbackMessage('/read 2403.12345v2');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'feedback') expect(r.feedback.arxivId).toBe('2403.12345');
  });

  it('parses URL form', () => {
    const r = parseFeedbackMessage('/save https://arxiv.org/abs/2403.12345');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'feedback') {
      expect(r.feedback.feedbackType).toBe('save');
      expect(r.feedback.arxivId).toBe('2403.12345');
    }
  });

  it('parses arxiv: prefix form', () => {
    const r = parseFeedbackMessage('/read arxiv:2403.12345');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'feedback') expect(r.feedback.arxivId).toBe('2403.12345');
  });

  it('parses --notes flag', () => {
    const r = parseFeedbackMessage('/read 2403.12345 --notes "Interesting approach"');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'feedback') expect(r.feedback.notes).toBe('Interesting approach');
  });

  it('parses --reason flag', () => {
    const r = parseFeedbackMessage('/skip 2403.12345 --reason "Too theoretical"');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'feedback') expect(r.feedback.reason).toBe('Too theoretical');
  });

  it('parses --priority flag for /save', () => {
    const r = parseFeedbackMessage('/save 2403.12345 --priority 8');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'feedback') expect(r.feedback.priority).toBe(8);
  });

  it('ignores out-of-range --priority', () => {
    const r = parseFeedbackMessage('/save 2403.12345 --priority 99');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'feedback') expect(r.feedback.priority).toBeNull();
  });

  it('handles leading/trailing whitespace', () => {
    const r = parseFeedbackMessage('  /read 2403.12345  ');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'feedback') expect(r.feedback.arxivId).toBe('2403.12345');
  });

  it('preserves raw text', () => {
    const input = '/read 2403.12345 --notes "Great"';
    const r = parseFeedbackMessage(input);
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'feedback') expect(r.feedback.raw).toBe(input.trim());
  });

  // ── Multi-word unquoted flags (Signal strips quotes) ───────────────────

  it('parses --notes with unquoted multi-word value', () => {
    // Signal often strips surrounding quotes, so we get bare words
    const r = parseFeedbackMessage('/read 2403.12345 --notes interesting ML approach');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'feedback') expect(r.feedback.notes).toBe('interesting ML approach');
  });

  it('parses --reason with unquoted multi-word value', () => {
    const r = parseFeedbackMessage('/skip 2403.12345 --reason too theoretical for now');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'feedback') expect(r.feedback.reason).toBe('too theoretical for now');
  });

  it('parses single-quoted multi-word --notes', () => {
    const r = parseFeedbackMessage("/save 2403.12345 --notes 'nice use of diffusion'");
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'feedback') expect(r.feedback.notes).toBe('nice use of diffusion');
  });

  it('parses --notes before --priority (both multi-token aware)', () => {
    // notes comes before priority; priority must still be parsed correctly
    const r = parseFeedbackMessage('/save 2403.12345 --notes read later --priority 7');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'feedback') {
      expect(r.feedback.notes).toBe('read later');
      expect(r.feedback.priority).toBe(7);
    }
  });

  it('parses --priority before --notes (order independent)', () => {
    const r = parseFeedbackMessage('/save 2403.12345 --priority 3 --notes great dataset');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'feedback') {
      expect(r.feedback.priority).toBe(3);
      expect(r.feedback.notes).toBe('great dataset');
    }
  });

  it('handles --notes with empty string after stripping quotes', () => {
    const r = parseFeedbackMessage('/read 2403.12345 --notes ""');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'feedback') expect(r.feedback.notes).toBeNull(); // empty → null
  });

  // ── /reading-list command ──────────────────────────────────────────────

  it('returns unknown_command for /list (reading-list uses /reading-list)', () => {
    const r = parseFeedbackMessage('/list');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('unknown_command');
  });
});
