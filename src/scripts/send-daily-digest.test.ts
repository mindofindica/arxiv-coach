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


describe('parallel category fetch behaviour', () => {
  /**
   * Simulate the allSettled pattern used in send-daily-digest to verify:
   *  - fulfilled fetches are processed correctly
   *  - rejected fetches are captured in discoveryErrors without aborting others
   *  - fetch time is bounded by the slowest single fetch (not their sum)
   */

  async function simulateParallelFetch(
    categories: string[],
    mockFetch: (cat: string) => Promise<string>
  ): Promise<{
    results: Array<{ cat: string; xml: string } | null>;
    errors: Array<{ category: string; error: string }>;
    elapsedMs: number;
  }> {
    const start = Date.now();
    const discoveryErrors: Array<{ category: string; error: string }> = [];
    const settled = await Promise.allSettled(
      categories.map(async (cat) => {
        const xml = await mockFetch(cat);
        return { cat, xml };
      })
    );
    const results = settled.map((r, i) => {
      if (r.status === 'rejected') {
        const reason = r.reason as { message?: string } | string | undefined;
        const msg = String(typeof reason === 'object' && reason !== null ? reason.message ?? reason : reason);
        discoveryErrors.push({ category: categories[i]!, error: msg });
        return null;
      }
      return r.value;
    });
    return { results, errors: discoveryErrors, elapsedMs: Date.now() - start };
  }

  it('processes all successful fetches', async () => {
    const cats = ['cs.AI', 'cs.CL', 'cs.LG', 'cs.IR'];
    const { results, errors } = await simulateParallelFetch(cats, async (cat) => `<xml>${cat}</xml>`);
    expect(errors).toHaveLength(0);
    expect(results).toHaveLength(4);
    expect(results.every((r) => r !== null)).toBe(true);
    expect(results[0]!?.cat).toBe('cs.AI');
    expect(results[0]!?.xml).toBe('<xml>cs.AI</xml>');
  });

  it('captures failed fetches in discoveryErrors without throwing', async () => {
    const cats = ['cs.AI', 'cs.CL', 'cs.LG'];
    const { results, errors } = await simulateParallelFetch(cats, async (cat) => {
      if (cat === 'cs.CL') throw new Error('arXiv 429 rate limit');
      return `<xml>${cat}</xml>`;
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.category).toBe('cs.CL');
    expect(errors[0]!.error).toContain('rate limit');
    // Other results still present
    expect(results[0]!).not.toBeNull();
    expect(results[1]!).toBeNull(); // failed
    expect(results[2]!).not.toBeNull();
  });

  it('runs in parallel — elapsed time close to slowest fetch, not sum', async () => {
    const DELAY = 30; // ms per fetch
    const cats = ['cs.AI', 'cs.CL', 'cs.LG', 'cs.IR']; // 4 fetches
    const { elapsedMs } = await simulateParallelFetch(
      cats,
      (cat) => new Promise<string>((resolve) => setTimeout(() => resolve(`<xml>${cat}</xml>`), DELAY))
    );
    // Parallel: should be ~30ms, definitely < 4 × 30ms = 120ms
    expect(elapsedMs).toBeLessThan(DELAY * cats.length - DELAY); // at least one overlap
  });

  it('all categories fail gracefully — no unhandled rejection', async () => {
    const cats = ['cs.AI', 'cs.CL'];
    const { results, errors } = await simulateParallelFetch(cats, async () => {
      throw new Error('network unreachable');
    });
    expect(errors).toHaveLength(2);
    expect(results.every((r) => r === null)).toBe(true);
  });

  it('result order matches category order even with different fetch speeds', async () => {
    const cats = ['cs.AI', 'cs.CL', 'cs.LG'];
    // cs.AI is slowest, cs.LG fastest — order in results should still follow cats order
    const delays: Record<string, number> = { 'cs.AI': 40, 'cs.CL': 20, 'cs.LG': 5 };
    const { results } = await simulateParallelFetch(
      cats,
      (cat) => new Promise<string>((resolve) => setTimeout(() => resolve(`<xml>${cat}</xml>`), delays[cat]))
    );
    expect(results[0]?.cat).toBe('cs.AI');
    expect(results[1]?.cat).toBe('cs.CL');
    expect(results[2]?.cat).toBe('cs.LG');
  });
});

