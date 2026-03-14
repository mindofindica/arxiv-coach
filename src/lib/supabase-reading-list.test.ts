import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncSaveToSupabase, syncReadToSupabase, syncLoveToSupabase } from './supabase-reading-list.js';
import { readSyncErrors } from './supabase-sync.js';

const ARXIV_ID = '2603.11513';
const USER_ID  = 'test-user-uuid';
const BASE_OPTS = { url: 'https://fake.supabase.co', key: 'test-key', userId: USER_ID };

function makeTmpLog(): string {
  return path.join(os.tmpdir(), `rl-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

function makeOk(status = 201) {
  return async () => ({ status, ok: true, text: async () => '' } as Response);
}

function makeErr(status: number, body = 'Bad Request') {
  return async () => ({ status, ok: false, text: async () => body } as Response);
}

function makeThrow(msg = 'ECONNREFUSED') {
  return async (): Promise<Response> => { throw new Error(msg); };
}

// ─── syncSaveToSupabase ───────────────────────────────────────────────────────

describe('syncSaveToSupabase', () => {
  let logPath: string;
  beforeEach(() => { logPath = makeTmpLog(); });
  afterEach(() => { try { fs.unlinkSync(logPath); } catch { /* ok */ } });

  it('returns skipped when key is missing', async () => {
    const r = await syncSaveToSupabase(ARXIV_ID, { url: '', key: '', userId: USER_ID, logPath });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(readSyncErrors(logPath)).toHaveLength(0);
  });

  it('returns skipped when userId is missing', async () => {
    const r = await syncSaveToSupabase(ARXIV_ID, { url: 'x', key: 'k', userId: '', logPath });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
  });

  it('returns ok:true on 201', async () => {
    const r = await syncSaveToSupabase(ARXIV_ID, { ...BASE_OPTS, logPath, fetch: makeOk(201) });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(201);
    expect(r.action).toBe('save');
  });

  it('returns ok:true on 200 (idempotent upsert)', async () => {
    const r = await syncSaveToSupabase(ARXIV_ID, { ...BASE_OPTS, logPath, fetch: makeOk(200) });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
  });

  it('does not log on success', async () => {
    await syncSaveToSupabase(ARXIV_ID, { ...BASE_OPTS, logPath, fetch: makeOk() });
    expect(readSyncErrors(logPath)).toHaveLength(0);
  });

  it('returns ok:false and logs on HTTP 4xx', async () => {
    const r = await syncSaveToSupabase(ARXIV_ID, { ...BASE_OPTS, logPath, fetch: makeErr(409) });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    const errs = readSyncErrors(logPath);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.arxivId).toBe(ARXIV_ID);
    expect(errs[0]!.error).toContain('reading-list:save');
    expect(errs[0]!.error).toContain('409');
  });

  it('returns ok:false and logs on HTTP 5xx', async () => {
    const r = await syncSaveToSupabase(ARXIV_ID, { ...BASE_OPTS, logPath, fetch: makeErr(503) });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
    expect(readSyncErrors(logPath)).toHaveLength(1);
  });

  it('returns ok:false and logs on network error', async () => {
    const r = await syncSaveToSupabase(ARXIV_ID, { ...BASE_OPTS, logPath, fetch: makeThrow() });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
    const errs = readSyncErrors(logPath);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.error).toContain('reading-list:save');
  });

  it('sends correct payload shape', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const mockFetch = async (url: string, init: RequestInit) => {
      captured = { url, init };
      return { status: 201, ok: true, text: async () => '' } as Response;
    };
    await syncSaveToSupabase(ARXIV_ID, {
      ...BASE_OPTS, logPath, fetch: mockFetch as any,
      priority: 8, note: 'great paper',
    });
    expect(captured).not.toBeNull();
    expect(captured!.url).toContain('/rest/v1/reading_list');
    expect(captured!.init.method).toBe('POST');
    const body = JSON.parse(captured!.init.body as string);
    expect(body.arxiv_id).toBe(ARXIV_ID);
    expect(body.user_id).toBe(USER_ID);
    expect(body.priority).toBe(8);
    expect(body.note).toBe('great paper');
    expect(body.status).toBe('unread');
  });

  it('uses default priority 5 when not specified', async () => {
    let captured: RequestInit | null = null;
    const mockFetch = async (_url: string, init: RequestInit) => {
      captured = init;
      return { status: 201, ok: true, text: async () => '' } as Response;
    };
    await syncSaveToSupabase(ARXIV_ID, { ...BASE_OPTS, logPath, fetch: mockFetch as any });
    expect(JSON.parse(captured!.body as string).priority).toBe(5);
  });
});

// ─── syncReadToSupabase ───────────────────────────────────────────────────────

describe('syncReadToSupabase', () => {
  let logPath: string;
  beforeEach(() => { logPath = makeTmpLog(); });
  afterEach(() => { try { fs.unlinkSync(logPath); } catch { /* ok */ } });

  it('returns skipped when key is missing', async () => {
    const r = await syncReadToSupabase(ARXIV_ID, { url: '', key: '', userId: USER_ID, logPath });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
  });

  it('returns ok:true on 204', async () => {
    const r = await syncReadToSupabase(ARXIV_ID, { ...BASE_OPTS, logPath, fetch: makeOk(204) });
    expect(r.ok).toBe(true);
    expect(r.action).toBe('read');
  });

  it('uses PATCH with correct filter URL', async () => {
    let capturedUrl = '';
    let capturedBody = '';
    const mockFetch = async (url: string, init: RequestInit) => {
      capturedUrl = url; capturedBody = init.body as string;
      return { status: 204, ok: true, text: async () => '' } as Response;
    };
    await syncReadToSupabase(ARXIV_ID, { ...BASE_OPTS, logPath, fetch: mockFetch as any });
    expect(capturedUrl).toContain(`arxiv_id=eq.${ARXIV_ID}`);
    expect(capturedUrl).toContain(`user_id=eq.${USER_ID}`);
    expect(JSON.parse(capturedBody).status).toBe('read');
  });

  it('logs error on failure', async () => {
    await syncReadToSupabase(ARXIV_ID, { ...BASE_OPTS, logPath, fetch: makeErr(500) });
    const errs = readSyncErrors(logPath);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.error).toContain('reading-list:read');
  });

  it('logs on network error', async () => {
    const r = await syncReadToSupabase(ARXIV_ID, { ...BASE_OPTS, logPath, fetch: makeThrow('timeout') });
    expect(r.ok).toBe(false);
    expect(readSyncErrors(logPath)).toHaveLength(1);
  });
});

// ─── syncLoveToSupabase ───────────────────────────────────────────────────────

describe('syncLoveToSupabase', () => {
  let logPath: string;
  beforeEach(() => { logPath = makeTmpLog(); });
  afterEach(() => { try { fs.unlinkSync(logPath); } catch { /* ok */ } });

  it('returns skipped when userId is missing', async () => {
    const r = await syncLoveToSupabase(ARXIV_ID, { url: 'x', key: 'k', userId: '', logPath });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
  });

  it('returns ok:true on 204', async () => {
    const r = await syncLoveToSupabase(ARXIV_ID, { ...BASE_OPTS, logPath, fetch: makeOk(204) });
    expect(r.ok).toBe(true);
    expect(r.action).toBe('love');
  });

  it('PATCHes priority to 8', async () => {
    let capturedBody = '';
    const mockFetch = async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return { status: 204, ok: true, text: async () => '' } as Response;
    };
    await syncLoveToSupabase(ARXIV_ID, { ...BASE_OPTS, logPath, fetch: mockFetch as any });
    expect(JSON.parse(capturedBody).priority).toBe(8);
  });

  it('logs error on failure', async () => {
    await syncLoveToSupabase(ARXIV_ID, { ...BASE_OPTS, logPath, fetch: makeErr(400) });
    const errs = readSyncErrors(logPath);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.error).toContain('reading-list:love');
  });

  it('logs on network error', async () => {
    await syncLoveToSupabase(ARXIV_ID, { ...BASE_OPTS, logPath, fetch: makeThrow() });
    expect(readSyncErrors(logPath)).toHaveLength(1);
  });
});
