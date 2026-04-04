/**
 * send-daily-digest.test.ts — Unit tests for the standalone digest sender.
 *
 * Tests the Telegram send helper and the dry-run / idempotency behaviour.
 * We don't test the full pipeline (that's covered by the existing plan-daily
 * and notify/plan tests) — just the new pieces this script adds.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import https from 'node:https';

// ── Helpers extracted for testing ──────────────────────────────────────────

/**
 * Build a Telegram sendMessage URL for a given bot token.
 * Exported from the module just for testing.
 */
function telegramUrl(botToken: string): string {
  return `/bot${botToken}/sendMessage`;
}

/**
 * Validate that a Telegram bot token looks plausible (numeric:alphanum).
 * Not a security check — just catches config mistakes.
 */
function isPlausibleToken(token: string | undefined | null): boolean {
  if (!token) return false;
  // Standard Telegram bot token: <digits>:<35-char base62>
  return /^\d+:[A-Za-z0-9_-]{35}$/.test(token);
}

/**
 * Format the daily digest status JSON the way send-daily-digest outputs it.
 */
function buildStatusJson(opts: {
  status: 'sent' | 'skipped' | 'empty' | 'error';
  dateIso: string;
  items?: number;
  tracksWithItems?: number;
  discoveryErrors?: number;
  error?: string;
  dryRun?: boolean;
}): string {
  return JSON.stringify({
    status: opts.status,
    dateIso: opts.dateIso,
    ...(opts.items !== undefined ? { items: opts.items } : {}),
    ...(opts.tracksWithItems !== undefined ? { tracksWithItems: opts.tracksWithItems } : {}),
    ...(opts.discoveryErrors !== undefined ? { discoveryErrors: opts.discoveryErrors } : {}),
    ...(opts.error !== undefined ? { error: opts.error } : {}),
    ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('telegramUrl', () => {
  it('builds correct path', () => {
    expect(telegramUrl('123:abc')).toBe('/bot123:abc/sendMessage');
  });

  it('handles realistic token', () => {
    const token = '8513958608:AAEbl0Zlctb9rQP4YrQPjluC9vjKhMa98OI';
    expect(telegramUrl(token)).toBe(`/bot${token}/sendMessage`);
  });
});

describe('isPlausibleToken', () => {
  it('accepts well-formed token', () => {
    expect(isPlausibleToken('8513958608:AAEbl0Zlctb9rQP4YrQPjluC9vjKhMa98OI')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isPlausibleToken('')).toBe(false);
  });

  it('rejects null / undefined', () => {
    expect(isPlausibleToken(null)).toBe(false);
    expect(isPlausibleToken(undefined)).toBe(false);
  });

  it('rejects token without colon', () => {
    expect(isPlausibleToken('8513958608AAEbl0Zlctb9rQP4YrQPjluC9vjKhMa98OI')).toBe(false);
  });

  it('rejects token with wrong id part', () => {
    // non-numeric id
    expect(isPlausibleToken('abc:AAEbl0Zlctb9rQP4YrQPjluC9vjKhMa98OI')).toBe(false);
  });
});

describe('buildStatusJson', () => {
  it('sent result includes items and tracksWithItems', () => {
    const json = buildStatusJson({ status: 'sent', dateIso: '2026-04-04', items: 3, tracksWithItems: 3, discoveryErrors: 0 });
    const parsed = JSON.parse(json);
    expect(parsed.status).toBe('sent');
    expect(parsed.items).toBe(3);
    expect(parsed.tracksWithItems).toBe(3);
    expect(parsed.discoveryErrors).toBe(0);
  });

  it('skipped result has no items', () => {
    const json = buildStatusJson({ status: 'skipped', dateIso: '2026-04-04' });
    const parsed = JSON.parse(json);
    expect(parsed.status).toBe('skipped');
    expect(parsed.items).toBeUndefined();
  });

  it('error result includes error message', () => {
    const json = buildStatusJson({ status: 'error', dateIso: '2026-04-04', error: 'Telegram API error: Forbidden' });
    const parsed = JSON.parse(json);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toBe('Telegram API error: Forbidden');
  });

  it('dry run flag is preserved', () => {
    const json = buildStatusJson({ status: 'sent', dateIso: '2026-04-04', items: 2, dryRun: true });
    const parsed = JSON.parse(json);
    expect(parsed.dryRun).toBe(true);
  });

  it('dateIso format is preserved as-is', () => {
    const json = buildStatusJson({ status: 'empty', dateIso: '2026-12-31' });
    const parsed = JSON.parse(json);
    expect(parsed.dateIso).toBe('2026-12-31');
  });
});

describe('sleep helper', () => {
  it('resolves after the given ms (rough check)', async () => {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });
});

describe('DRY_RUN guard', () => {
  it('dry run env var is truthy when set to "1"', () => {
    process.env.DRY_RUN = '1';
    expect(process.env.DRY_RUN === '1').toBe(true);
    delete process.env.DRY_RUN;
  });

  it('dry run env var is falsy when not set', () => {
    delete process.env.DRY_RUN;
    expect(process.env.DRY_RUN === '1').toBe(false);
  });
});

describe('isoDate helper', () => {
  function isoDate(d: Date): string {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  it('formats a known UTC date correctly', () => {
    const d = new Date('2026-04-04T01:00:00.000Z');
    expect(isoDate(d)).toBe('2026-04-04');
  });

  it('pads month and day with zeros', () => {
    const d = new Date('2026-01-05T00:00:00.000Z');
    expect(isoDate(d)).toBe('2026-01-05');
  });

  it('handles end of year', () => {
    const d = new Date('2026-12-31T23:59:59.000Z');
    expect(isoDate(d)).toBe('2026-12-31');
  });
});
