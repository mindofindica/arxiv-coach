import { describe, expect, it } from 'vitest';
import { parseArxivId, parseAtom, withinLastDays } from './arxiv.js';

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
