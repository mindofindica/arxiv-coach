import { describe, expect, it, vi, afterEach } from 'vitest';
import { parseArxivId, parseAtom, withinLastDays, fetchAtom } from './arxiv.js';

describe('parseArxivId', () => {
  it('parses canonical id and version', () => {
    const r = parseArxivId('http://arxiv.org/abs/2502.12345v2');
    expect(r).toEqual({ arxivId: '2502.12345', version: 'v2' });
  });

  it('defaults to v1 when missing', () => {
    const r = parseArxivId('http://arxiv.org/abs/2502.12345');
    expect(r).toEqual({ arxivId: '2502.12345', version: 'v1' });
  });
});

describe('withinLastDays', () => {
  it('includes timestamps within window', () => {
    const now = new Date('2026-02-08T12:00:00Z');
    expect(withinLastDays('2026-02-07T12:00:00Z', 3, now)).toBe(true);
  });

  it('excludes timestamps outside window', () => {
    const now = new Date('2026-02-08T12:00:00Z');
    expect(withinLastDays('2026-02-01T12:00:00Z', 3, now)).toBe(false);
  });
});

describe('fetchAtom', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns text on success', async () => {
    const mockXml = '<feed><entry></entry></feed>';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => mockXml,
    }));
    const result = await fetchAtom('cs.AI', 1);
    expect(result).toBe(mockXml);
  });

  it('throws on non-retryable HTTP error (4xx)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
    }));
    await expect(fetchAtom('cs.AI', 1)).rejects.toThrow('400 Bad Request');
  });

  it('retries on 429 and succeeds on second attempt', async () => {
    // 429 rate-limit → should retry, not throw immediately.
    const mockXml = '<feed></feed>';
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests' })
      .mockResolvedValueOnce({ ok: true, text: async () => mockXml });
    vi.stubGlobal('fetch', mockFetch);
    vi.useFakeTimers();
    const resultPromise = fetchAtom('cs.AI', 1);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();
    expect(result).toBe(mockXml);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting all retries on persistent 429', async () => {
    // If arXiv keeps rate-limiting for all 8 attempts, throw with a clear error.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 429, statusText: 'Too Many Requests',
    }));
    vi.useFakeTimers();
    // Attach rejection handler BEFORE awaiting timers to avoid unhandled rejection
    const resultPromise = fetchAtom('cs.AI', 1);
    const caught = resultPromise.catch((e: Error) => e.message);
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    const errMsg = await caught;
    expect(errMsg).toContain('429 Too Many Requests');
  });

  it('retries on timeout (AbortError): succeeds on second attempt', async () => {
    // This test validates the core fix: AbortError (from AbortSignal.timeout) is
    // caught, treated as retryable, and the function retries successfully.
    const abortErr = new DOMException('signal timed out', 'TimeoutError');
    const mockXml = '<feed></feed>';
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(abortErr) // first attempt: times out
      .mockResolvedValueOnce({ ok: true, text: async () => mockXml }); // retry: success
    vi.stubGlobal('fetch', mockFetch);
    // Use fake timers so the backoff sleep doesn't block the test
    vi.useFakeTimers();
    const resultPromise = fetchAtom('cs.AI', 1);
    // Flush the async retry queue (setTimeout backoff → next fetch attempt)
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();
    expect(result).toBe(mockXml);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('parseAtom', () => {
  it('parses a minimal Atom feed entry', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>http://arxiv.org/abs/2502.12345v1</id>
          <updated>2026-02-08T10:00:00Z</updated>
          <published>2026-02-08T09:00:00Z</published>
          <title>  Test Title  </title>
          <summary>  Hello\nworld  </summary>
          <author><name>Alice</name></author>
          <author><name>Bob</name></author>
          <category term="cs.AI"/>
          <category term="cs.CL"/>
          <link rel="alternate" type="text/html" href="http://arxiv.org/abs/2502.12345v1"/>
          <link title="pdf" rel="related" type="application/pdf" href="http://arxiv.org/pdf/2502.12345v1"/>
        </entry>
      </feed>`;

    const entries = parseAtom(xml);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.arxivId).toBe('2502.12345');
    expect(e.version).toBe('v1');
    expect(e.title).toBe('Test Title');
    expect(e.summary).toBe('Hello world');
    expect(e.authors).toEqual(['Alice', 'Bob']);
    expect(e.categories).toEqual(['cs.AI', 'cs.CL']);
    expect(e.pdfUrl).toBe('http://arxiv.org/pdf/2502.12345v1');
    expect(e.absUrl).toBe('http://arxiv.org/abs/2502.12345v1');
  });
});
