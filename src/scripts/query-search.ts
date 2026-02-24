/**
 * query-search — /search Signal command handler
 *
 * Searches the arxiv-coach paper library using FTS5 full-text search
 * over paper titles and abstracts.
 *
 * Usage:
 *   npm run search -- "speculative decoding"
 *   npm run search -- "RAG" --limit 3
 *   npm run search -- "quantization" --min-score 4
 *   npm run search -- "inference" --track "LLM Efficiency"
 *   npm run search -- "transformers" --json
 *
 * Options:
 *   --limit <n>        Max results to return (1–20, default 5)
 *   --min-score <n>    Only return papers with LLM score >= n (1–5)
 *   --track <name>     Filter to papers in a specific track
 *   --json             Output raw JSON instead of Signal-formatted text
 *
 * Output modes:
 *   (default)  Signal-formatted text, ready to paste into Signal
 *   --json     Machine-readable JSON for further processing
 *
 * Exit codes:
 *   0  Success (including "no results found")
 *   1  Error (config / DB / no query provided)
 */

import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';
import { searchPapers } from '../lib/query/search-papers.js';
import { renderSearchMessage } from '../lib/query/render-search.js';

// ─── Arg parsing ──────────────────────────────────────────────────────────────

interface Args {
  query: string;
  limit: number;
  minLlmScore: number | undefined;
  track: string | undefined;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  let query = '';
  let limit = 5;
  let minLlmScore: number | undefined;
  let track: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === '--json' || arg === '-j') {
      json = true;
    } else if ((arg === '--limit' || arg === '-l') && i + 1 < argv.length) {
      const n = parseInt(argv[++i]!, 10);
      if (!isNaN(n) && n >= 1 && n <= 20) limit = n;
    } else if (arg.startsWith('--limit=')) {
      const n = parseInt(arg.slice('--limit='.length), 10);
      if (!isNaN(n) && n >= 1 && n <= 20) limit = n;
    } else if ((arg === '--min-score' || arg === '--min-llm-score') && i + 1 < argv.length) {
      const n = parseInt(argv[++i]!, 10);
      if (!isNaN(n) && n >= 1 && n <= 5) minLlmScore = n;
    } else if (arg.startsWith('--min-score=')) {
      const n = parseInt(arg.slice('--min-score='.length), 10);
      if (!isNaN(n) && n >= 1 && n <= 5) minLlmScore = n;
    } else if ((arg === '--track' || arg === '-t') && i + 1 < argv.length) {
      track = argv[++i]!;
    } else if (arg.startsWith('--track=')) {
      track = arg.slice('--track='.length);
    } else if (!arg.startsWith('--')) {
      // Positional args become the query
      query = query ? `${query} ${arg}` : arg;
    }
  }

  return { query, limit, minLlmScore, track, json };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { query, limit, minLlmScore, track, json } = parseArgs(process.argv.slice(2));

  if (!query.trim()) {
    console.error('Error: No search query provided.');
    console.error('Usage: npm run search -- "your query here"');
    process.exit(1);
  }

  const repoRoot = path.resolve(process.cwd());
  const config = loadConfig(repoRoot);
  const dbPath = path.join(config.storage.root, 'db.sqlite');
  const db = openDb(dbPath);
  migrate(db);

  const response = searchPapers(db, query, {
    limit,
    minLlmScore,
    track,
  });

  db.sqlite.close();

  if (json) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    const { text } = renderSearchMessage(response);
    console.log(text);
  }
}

main().catch(err => {
  console.error('query-search error:', err);
  process.exit(1);
});
