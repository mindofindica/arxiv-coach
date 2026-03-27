/**
 * Tests for /explain command parsing via parseFeedbackMessage
 *
 * Covers:
 *  - Basic arxiv ID explain
 *  - Title keyword explain
 *  - Digest reference explain (#N from today)
 *  - --level flag variants
 *  - Missing query → error
 *  - Non-interference with other commands
 */

import { describe, it, expect } from 'vitest';
import { parseFeedbackMessage } from '../feedback/parser.js';

describe('/explain command parser', () => {
  // ── Basic parsing ─────────────────────────────────────────────────────

  it('parses bare arxiv ID', () => {
    const result = parseFeedbackMessage('/explain 2402.01234');
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'explain') {
      expect(result.explain.command).toBe('explain');
      expect(result.explain.query).toBe('2402.01234');
      expect(result.explain.level).toBe('engineer'); // default
    } else {
      throw new Error(`Expected explain kind, got: ${result.ok ? result.kind : 'error'}`);
    }
  });

  it('parses arxiv: prefixed ID', () => {
    const result = parseFeedbackMessage('/explain arxiv:2402.01234');
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'explain') {
      expect(result.explain.query).toBe('arxiv:2402.01234');
    }
  });

  it('parses title keywords as query', () => {
    const result = parseFeedbackMessage('/explain attention is all you need');
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'explain') {
      expect(result.explain.query).toBe('attention is all you need');
      expect(result.explain.level).toBe('engineer');
    }
  });

  it('parses digest reference', () => {
    const result = parseFeedbackMessage('/explain #2 from today');
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'explain') {
      expect(result.explain.query).toBe('#2 from today');
    }
  });

  it('parses digest reference with date', () => {
    const result = parseFeedbackMessage('/explain #1 from 2026-03-20');
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'explain') {
      expect(result.explain.query).toBe('#1 from 2026-03-20');
    }
  });

  // ── Level flag ──────────────────────────────────────────────────────────

  it('parses --level eli12', () => {
    const result = parseFeedbackMessage('/explain 2402.01234 --level eli12');
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'explain') {
      expect(result.explain.query).toBe('2402.01234');
      expect(result.explain.level).toBe('eli12');
    }
  });

  it('parses --level undergrad', () => {
    const result = parseFeedbackMessage('/explain 2402.01234 --level undergrad');
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'explain') {
      expect(result.explain.level).toBe('undergrad');
    }
  });

  it('parses --level engineer explicitly', () => {
    const result = parseFeedbackMessage('/explain 2402.01234 --level engineer');
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'explain') {
      expect(result.explain.level).toBe('engineer');
    }
  });

  it('defaults to engineer level when --level not specified', () => {
    const result = parseFeedbackMessage('/explain 2402.01234');
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'explain') {
      expect(result.explain.level).toBe('engineer');
    }
  });

  it('parses title with --level flag', () => {
    const result = parseFeedbackMessage('/explain attention transformers --level eli12');
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'explain') {
      expect(result.explain.query).toBe('attention transformers');
      expect(result.explain.level).toBe('eli12');
    }
  });

  // ── Error cases ─────────────────────────────────────────────────────────

  it('returns missing_explain_query error for empty /explain', () => {
    const result = parseFeedbackMessage('/explain');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('missing_explain_query');
      expect(result.message).toContain('/explain');
    }
  });

  it('returns missing_explain_query when only --level flag', () => {
    const result = parseFeedbackMessage('/explain --level eli12');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('missing_explain_query');
    }
  });

  // ── Non-interference with other commands ────────────────────────────────

  it('does not interfere with /ask command', () => {
    const result = parseFeedbackMessage('/ask 2402.01234 what is the key contribution?');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe('paper-query');
    }
  });

  it('does not interfere with /read command', () => {
    const result = parseFeedbackMessage('/read 2402.01234');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe('feedback');
    }
  });

  it('does not interfere with /search command', () => {
    const result = parseFeedbackMessage('/search speculative decoding');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe('query');
    }
  });

  it('does not interfere with /status command', () => {
    const result = parseFeedbackMessage('/status');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe('query');
    }
  });

  // ── Raw preservation ────────────────────────────────────────────────────

  it('preserves raw message text', () => {
    const msg = '/explain 2402.01234 --level eli12';
    const result = parseFeedbackMessage(msg);
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'explain') {
      expect(result.explain.raw).toBe(msg);
    }
  });

  // ── unknown command still works ─────────────────────────────────────────

  it('unknown_command hint includes /explain', () => {
    const result = parseFeedbackMessage('/notacommand 2402.01234');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('unknown_command');
      expect(result.message).toContain('/explain');
    }
  });
});
