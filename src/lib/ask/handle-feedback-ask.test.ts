/**
 * Tests for /ask command parsing in the Signal feedback parser.
 *
 * These test the parser-level recognition of /ask messages,
 * including the paper-query result kind and error cases.
 */

import { describe, it, expect } from 'vitest';
import { parseFeedbackMessage } from '../feedback/parser.js';

describe('parseFeedbackMessage — /ask command', () => {
  // ── Happy paths ───────────────────────────────────────────────────────

  it('parses /ask with bare arxiv ID and question', () => {
    const r = parseFeedbackMessage('/ask 2402.01234 what is the key contribution?');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe('paper-query');
      if (r.kind === 'paper-query') {
        expect(r.paperQuery.command).toBe('ask');
        expect(r.paperQuery.arxivId).toBe('2402.01234');
        expect(r.paperQuery.question).toBe('what is the key contribution?');
      }
    }
  });

  it('parses /ask with arxiv: prefix', () => {
    const r = parseFeedbackMessage('/ask arxiv:2402.01234 how does the method work?');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'paper-query') {
      expect(r.paperQuery.arxivId).toBe('2402.01234');
      expect(r.paperQuery.question).toBe('how does the method work?');
    }
  });

  it('parses /ask with multi-word question', () => {
    const r = parseFeedbackMessage('/ask 2501.99999 how does this compare to previous work?');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'paper-query') {
      expect(r.paperQuery.question).toBe('how does this compare to previous work?');
    }
  });

  it('parses /ask with versioned arxiv ID (strips version)', () => {
    const r = parseFeedbackMessage('/ask 2402.01234v2 what datasets were used?');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'paper-query') {
      expect(r.paperQuery.arxivId).toBe('2402.01234');
      expect(r.paperQuery.question).toBe('what datasets were used?');
    }
  });

  it('parses /ask with 4+4 digit arxiv ID', () => {
    const r = parseFeedbackMessage('/ask 2402.1234 what is speculative decoding?');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'paper-query') {
      expect(r.paperQuery.arxivId).toBe('2402.1234');
    }
  });

  it('preserves raw text in paperQuery.raw', () => {
    const msg = '/ask 2402.01234 what is this about?';
    const r = parseFeedbackMessage(msg);
    if (r.ok && r.kind === 'paper-query') {
      expect(r.paperQuery.raw).toBe(msg);
    }
  });

  // ── Error cases ───────────────────────────────────────────────────────

  it('returns missing_arxiv_id when no ID provided', () => {
    const r = parseFeedbackMessage('/ask');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('missing_arxiv_id');
      expect(r.message).toContain('/ask');
    }
  });

  it('returns missing_arxiv_id for /ask with just text (no valid ID)', () => {
    const r = parseFeedbackMessage('/ask what is a transformer?');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('missing_arxiv_id');
    }
  });

  it('returns missing_question when only arxiv ID given', () => {
    const r = parseFeedbackMessage('/ask 2402.01234');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('missing_question');
      expect(r.message).toContain('2402.01234');
    }
  });

  it('returns missing_question for /ask with ID and only spaces', () => {
    const r = parseFeedbackMessage('/ask 2402.01234   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('missing_question');
  });

  // ── Non-interference with other commands ──────────────────────────────

  it('does not misparse /read as /ask', () => {
    const r = parseFeedbackMessage('/read 2402.01234');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe('feedback');
  });

  it('does not misparse /search as /ask', () => {
    const r = parseFeedbackMessage('/search speculative decoding');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe('query');
  });

  it('does not misparse /status as /ask', () => {
    const r = parseFeedbackMessage('/status');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe('query');
  });

  it('unknown_command includes /ask in suggestion', () => {
    const r = parseFeedbackMessage('/bogus 2402.01234');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('unknown_command');
      expect(r.message).toContain('/ask');
    }
  });
});
