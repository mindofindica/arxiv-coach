import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { request } from 'undici';

import { ensureDir } from './storage.js';

export interface DownloadResult {
  bytes: number;
  sha256: string;
}

export async function downloadToFile(url: string, outPath: string, timeoutMs = 60_000): Promise<DownloadResult> {
  ensureDir(path.dirname(outPath));

  const tmpPath = `${outPath}.tmp`;
  const { body, statusCode, headers } = await request(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'arxiv-coach (+https://github.com/mindofindica/arxiv-coach)',
    },
    bodyTimeout: timeoutMs,
    headersTimeout: timeoutMs,
    // NOTE: undici types in this environment don't expose max redirections.
    // arXiv PDF URLs are stable; if this becomes an issue we'll handle redirects manually.
  });

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Download failed: ${statusCode} for ${url}`);
  }

  const ct = String(headers['content-type'] ?? '');
  // arXiv should return application/pdf; if not, it's likely an error page.
  if (ct && !ct.includes('pdf')) {
    throw new Error(`Unexpected content-type for ${url}: ${ct}`);
  }

  const hash = crypto.createHash('sha256');
  let bytes = 0;

  const ws = fs.createWriteStream(tmpPath);
  try {
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buf.length;
      hash.update(buf);
      ws.write(buf);
    }
  } finally {
    ws.end();
  }

  // Basic validation: ensure it looks like a PDF
  const fd = fs.openSync(tmpPath, 'r');
  const head = Buffer.alloc(5);
  fs.readSync(fd, head, 0, 5, 0);
  fs.closeSync(fd);
  if (head.toString('utf8') !== '%PDF-') {
    fs.rmSync(tmpPath, { force: true });
    throw new Error(`Downloaded file is not a valid PDF (missing %PDF- header): ${url}`);
  }

  const sha256 = hash.digest('hex');
  fs.renameSync(tmpPath, outPath);

  return { bytes, sha256 };
}
