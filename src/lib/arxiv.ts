import { XMLParser } from 'fast-xml-parser';

export interface ArxivEntry {
  arxivId: string; // canonical, no version
  version: string; // v1, v2, ...
  title: string;
  summary: string;
  authors: string[];
  categories: string[];
  publishedAt: string;
  updatedAt: string;
  pdfUrl: string | null;
  absUrl: string | null;
  rawIdUrl: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

function text(x: unknown): string {
  if (typeof x === 'string') return x;
  return '';
}

function asArray<T>(x: T | T[] | undefined | null): T[] {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

// Example id URL: http://arxiv.org/abs/2502.12345v2
export function parseArxivId(idUrl: string): { arxivId: string; version: string } {
  const m = idUrl.match(/arxiv\.org\/abs\/(.+)$/);
  const tail = m?.[1] ?? idUrl;
  const mv = tail.match(/^(?<id>\d{4}\.\d{4,5})(?<v>v\d+)?$/);
  const arxivId = mv?.groups?.id ?? tail.replace(/v\d+$/, '');
  const version = mv?.groups?.v ?? 'v1';
  return { arxivId, version };
}

function normalizeTitle(t: string): string {
  return t.replace(/\s+/g, ' ').trim();
}

function normalizeSummary(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// NOTE: default maxResults is intentionally conservative to be kind to arXiv.
// If we need more coverage, make it configurable in config.yml.
export async function fetchAtom(category: string, maxResults = 100): Promise<string> {
  const url = `https://export.arxiv.org/api/query?search_query=cat:${encodeURIComponent(category)}&start=0&max_results=${maxResults}&sortBy=lastUpdatedDate&sortOrder=descending`;

  // Be polite + resilient: retry on transient failures (esp. 429 rate limiting).
  // NOTE: We keep this conservative to avoid hammering arXiv.
  const maxAttempts = 5;
  const FETCH_TIMEOUT_MS = 30_000; // 30s per attempt — prevents indefinite hang on slow arXiv
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // AbortSignal.timeout available in Node 18+; gives a hard timeout per request
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        signal,
        headers: {
          'User-Agent': 'arxiv-coach (+https://github.com/mindofindica/arxiv-coach)',
        },
      });
    } catch (err) {
      // Timeout (AbortError) or network error — treat as retryable
      if (attempt === maxAttempts) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`arXiv fetch failed for ${category} (attempt ${attempt}): ${msg}`);
      }
      const base = Math.min(60_000, 1000 * 2 ** (attempt - 1));
      const waitMs = Math.floor(base * (0.75 + Math.random() * 0.75));
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (res.ok) return await res.text();

    const status = res.status;
    const retryable = status === 429 || (status >= 500 && status <= 599);
    if (!retryable || attempt === maxAttempts) {
      throw new Error(`arXiv fetch failed for ${category}: ${status} ${res.statusText}`);
    }

    // Exponential backoff with jitter
    const base = Math.min(60_000, 1000 * 2 ** (attempt - 1));
    const waitMs = Math.floor(base * (0.75 + Math.random() * 0.75));
    await new Promise((r) => setTimeout(r, waitMs));
  }

  throw new Error(`arXiv fetch failed for ${category}: exceeded retries`);
}

export function parseAtom(xml: string): ArxivEntry[] {
  const doc = parser.parse(xml);
  const feed = doc?.feed;
  const entries = asArray(feed?.entry);

  return entries.map((e: any) => {
    const rawIdUrl = text(e.id);
    const { arxivId, version } = parseArxivId(rawIdUrl);

    const authors = asArray(e.author).map((a: any) => normalizeTitle(text(a?.name))).filter(Boolean);

    const categories = asArray(e.category)
      .map((c: any) => text(c?.['@_term']))
      .filter(Boolean);

    const links = asArray(e.link);
    const absUrl = links.map((l: any) => text(l?.['@_href'])).find((href) => href.includes('/abs/')) ?? null;
    const pdfUrl = links.map((l: any) => ({ href: text(l?.['@_href']), type: text(l?.['@_type']) }))
      .find((l) => l.type === 'application/pdf')?.href ?? null;

    return {
      arxivId,
      version,
      title: normalizeTitle(text(e.title)),
      summary: normalizeSummary(text(e.summary)),
      authors,
      categories,
      publishedAt: text(e.published),
      updatedAt: text(e.updated),
      pdfUrl,
      absUrl,
      rawIdUrl,
    } satisfies ArxivEntry;
  });
}

export function withinLastDays(iso: string, days: number, now = new Date()): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const windowMs = days * 24 * 60 * 60 * 1000;
  return t >= now.getTime() - windowMs;
}
