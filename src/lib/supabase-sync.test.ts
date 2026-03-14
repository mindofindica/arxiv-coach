import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncPaperToSupabase, appendSyncError, readSyncErrors } from './supabase-sync.js';
import type { ArxivEntry } from './arxiv.js';

// Minimal ArxivEntry fixture
function makeEntry(overrides: Partial<ArxivEntry> = {}): ArxivEntry {
  return {
    arxivId:     '2603.11513',
    version:     'v1',
    title:       'Test Paper',
    summary:     'An abstract.',
    authors:     ['Alice', 'Bob'],
    categories:  ['cs.AI'],
    publishedAt: '2026-03-14',
    updatedAt:   '2026-03-14',
    pdfUrl:      'https://arxiv.org/pdf/2603.11513',
    absUrl:      'https://arxiv.org/abs/2603.11513',
    rawIdUrl:    'https://arxiv.org/abs/2603.11513',
    ...overrides,
  };
}

// Create a temp log path per test
function makeTmpLog(): string {
  return path.join(os.tmpdir(), `sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

const OVERRIDES_BASE = {
  url: 'https://fake.supabase.co',
  key: 'test-key',
};

// ─── syncPaperToSupabase ──────────────────────────────────────────────────────

describe('syncPaperToSupabase', () => {
  let logPath: string;

  beforeEach(() => { logPath = makeTmpLog(); });
  afterEach(() => { try { fs.unlinkSync(logPath); } catch { /* ok */ } });

  it('returns skipped:true when no key is configured', async () => {
    const result = await syncPaperToSupabase(makeEntry(), {
      url: 'https://fake.supabase.co',
      key: '',
      logPath,
    });
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.arxivId).toBe('2603.11513');
  });

  it('does not write a log entry when skipped', async () => {
    await syncPaperToSupabase(makeEntry(), { url: '', key: '', logPath });
    expect(readSyncErrors(logPath)).toHaveLength(0);
  });

  it('returns ok:true and status 201 on successful upsert', async () => {
    const mockFetch = async () => ({ status: 201, ok: true, text: async () => '' } as Response);
    const result = await syncPaperToSupabase(makeEntry(), { ...OVERRIDES_BASE, logPath, fetch: mockFetch });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(201);
    expect(result.skipped).toBeUndefined();
  });

  it('returns ok:true and status 200 on successful upsert (idempotent)', async () => {
    const mockFetch = async () => ({ status: 200, ok: true, text: async () => '' } as Response);
    const result = await syncPaperToSupabase(makeEntry(), { ...OVERRIDES_BASE, logPath, fetch: mockFetch });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it('does not write a log entry on success', async () => {
    const mockFetch = async () => ({ status: 201, ok: true, text: async () => '' } as Response);
    await syncPaperToSupabase(makeEntry(), { ...OVERRIDES_BASE, logPath, fetch: mockFetch });
    expect(readSyncErrors(logPath)).toHaveLength(0);
  });

  it('returns ok:false on HTTP 4xx and logs the error', async () => {
    const mockFetch = async () => ({
      status: 400,
      ok: false,
      text: async () => '{"message":"Bad Request"}',
    } as Response);
    const result = await syncPaperToSupabase(makeEntry(), { ...OVERRIDES_BASE, logPath, fetch: mockFetch });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain('HTTP 400');
    const errors = readSyncErrors(logPath);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.arxivId).toBe('2603.11513');
    expect(errors[0]!.status).toBe(400);
    expect(errors[0]!.error).toContain('HTTP 400');
    expect(errors[0]!.timestamp).toBeTruthy();
  });

  it('returns ok:false on HTTP 5xx and logs the error', async () => {
    const mockFetch = async () => ({
      status: 503,
      ok: false,
      text: async () => 'Service Unavailable',
    } as Response);
    const result = await syncPaperToSupabase(makeEntry(), { ...OVERRIDES_BASE, logPath, fetch: mockFetch });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    const errors = readSyncErrors(logPath);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.status).toBe(503);
  });

  it('returns ok:false on network error and logs the error', async () => {
    const mockFetch = async (): Promise<Response> => { throw new Error('ECONNREFUSED'); };
    const result = await syncPaperToSupabase(makeEntry(), { ...OVERRIDES_BASE, logPath, fetch: mockFetch });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
    const errors = readSyncErrors(logPath);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toContain('ECONNREFUSED');
    expect(errors[0]!.status).toBeUndefined();
  });

  it('accumulates multiple failures in the log', async () => {
    const mockFetch = async () => ({
      status: 500,
      ok: false,
      text: async () => 'Internal Server Error',
    } as Response);
    const entries = ['2601.00001', '2601.00002', '2601.00003'].map(id => makeEntry({ arxivId: id }));
    for (const entry of entries) {
      await syncPaperToSupabase(entry, { ...OVERRIDES_BASE, logPath, fetch: mockFetch });
    }
    const errors = readSyncErrors(logPath);
    expect(errors).toHaveLength(3);
    expect(errors.map(e => e.arxivId)).toEqual(['2601.00001', '2601.00002', '2601.00003']);
  });

  it('sends correct payload to Supabase', async () => {
    let capturedRequest: { url: string; init: RequestInit } | null = null;
    const mockFetch = async (url: string, init: RequestInit) => {
      capturedRequest = { url, init };
      return { status: 201, ok: true, text: async () => '' } as Response;
    };
    const entry = makeEntry();
    await syncPaperToSupabase(entry, { ...OVERRIDES_BASE, logPath, fetch: mockFetch as any });

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.url).toContain('/rest/v1/papers');
    expect(capturedRequest!.init.method).toBe('POST');

    const headers = capturedRequest!.init.headers as Record<string, string>;
    expect(headers['Prefer']).toBe('resolution=merge-duplicates');
    expect(headers['apikey']).toBe('test-key');

    const body = JSON.parse(capturedRequest!.init.body as string);
    expect(body).toHaveLength(1);
    expect(body[0].arxiv_id).toBe('2603.11513');
    expect(body[0].title).toBe('Test Paper');
    expect(body[0].abstract).toBe('An abstract.');
    expect(body[0].authors).toEqual(['Alice', 'Bob']);
    expect(body[0].categories).toEqual(['cs.AI']);
  });

  it('truncates oversized error body in log entry', async () => {
    const bigBody = 'x'.repeat(500);
    const mockFetch = async () => ({
      status: 422,
      ok: false,
      text: async () => bigBody,
    } as Response);
    const result = await syncPaperToSupabase(makeEntry(), { ...OVERRIDES_BASE, logPath, fetch: mockFetch });
    expect(result.error!.length).toBeLessThanOrEqual(215); // "HTTP 422: " + 200 chars
  });
});

// ─── appendSyncError / readSyncErrors ────────────────────────────────────────

describe('appendSyncError', () => {
  let logPath: string;

  beforeEach(() => { logPath = makeTmpLog(); });
  afterEach(() => { try { fs.unlinkSync(logPath); } catch { /* ok */ } });

  it('creates the file and appends a JSONL entry', () => {
    appendSyncError(logPath, { timestamp: '2026-03-14T00:00:00Z', arxivId: '2603.00001', error: 'boom' });
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.arxivId).toBe('2603.00001');
    expect(entry.error).toBe('boom');
  });

  it('appends multiple entries as separate lines', () => {
    appendSyncError(logPath, { timestamp: 't1', arxivId: 'id1', error: 'e1' });
    appendSyncError(logPath, { timestamp: 't2', arxivId: 'id2', error: 'e2' });
    const errors = readSyncErrors(logPath);
    expect(errors).toHaveLength(2);
    expect(errors[0]!.arxivId).toBe('id1');
    expect(errors[1]!.arxivId).toBe('id2');
  });

  it('stores optional status field', () => {
    appendSyncError(logPath, { timestamp: 't', arxivId: 'id', status: 503, error: 'down' });
    const errors = readSyncErrors(logPath);
    expect(errors[0]!.status).toBe(503);
  });
});

describe('readSyncErrors', () => {
  it('returns empty array when log file does not exist', () => {
    expect(readSyncErrors('/tmp/definitely-does-not-exist-xyz.jsonl')).toEqual([]);
  });

  it('skips blank lines', () => {
    const logPath = makeTmpLog();
    fs.writeFileSync(logPath, '\n{"timestamp":"t","arxivId":"x","error":"e"}\n\n', 'utf8');
    const errors = readSyncErrors(logPath);
    expect(errors).toHaveLength(1);
    fs.unlinkSync(logPath);
  });
});
