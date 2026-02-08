import path from 'node:path';
import type { AppConfig } from './types.js';
import { ensureDir, paperPaths } from './storage.js';
import type { ArxivEntry } from './arxiv.js';
import type { Db } from './db.js';

export function ensureStorageRoot(config: AppConfig) {
  ensureDir(config.storage.root);
  ensureDir(path.join(config.storage.root, 'papers'));
  ensureDir(path.join(config.storage.root, 'digests', 'daily'));
  ensureDir(path.join(config.storage.root, 'digests', 'weekly'));
}

export function upsertPaper(db: Db, config: AppConfig, entry: ArxivEntry) {
  const paths = paperPaths(config.storage.root, entry.arxivId, new Date(entry.updatedAt));
  ensureDir(paths.paperDir);

  const now = new Date().toISOString();

  db.sqlite.prepare(
    `INSERT INTO papers (
      arxiv_id, latest_version, title, abstract, authors_json, categories_json,
      published_at, updated_at, pdf_path, txt_path, meta_path, sha256_pdf, ingested_at
    ) VALUES (
      @arxiv_id, @latest_version, @title, @abstract, @authors_json, @categories_json,
      @published_at, @updated_at, @pdf_path, @txt_path, @meta_path, @sha256_pdf, @ingested_at
    )
    ON CONFLICT(arxiv_id) DO UPDATE SET
      latest_version=excluded.latest_version,
      title=excluded.title,
      abstract=excluded.abstract,
      authors_json=excluded.authors_json,
      categories_json=excluded.categories_json,
      published_at=excluded.published_at,
      updated_at=excluded.updated_at,
      pdf_path=excluded.pdf_path,
      txt_path=excluded.txt_path,
      meta_path=excluded.meta_path
    `
  ).run({
    arxiv_id: entry.arxivId,
    latest_version: entry.version,
    title: entry.title,
    abstract: entry.summary,
    authors_json: JSON.stringify(entry.authors),
    categories_json: JSON.stringify(entry.categories),
    published_at: entry.publishedAt,
    updated_at: entry.updatedAt,
    pdf_path: paths.pdfPath,
    txt_path: paths.txtPath,
    meta_path: paths.metaPath,
    sha256_pdf: null,
    ingested_at: now,
  });

  db.sqlite.prepare(
    `INSERT OR IGNORE INTO paper_versions (arxiv_id, version, updated_at, pdf_sha256, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(entry.arxivId, entry.version, entry.updatedAt, null, now);
}

export function upsertTrackMatch(db: Db, arxivId: string, trackName: string, score: number, matchedTerms: string[]) {
  const now = new Date().toISOString();
  db.sqlite.prepare(
    `INSERT INTO track_matches (arxiv_id, track_name, score, matched_terms_json, matched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(arxiv_id, track_name) DO UPDATE SET
      score=excluded.score,
      matched_terms_json=excluded.matched_terms_json,
      matched_at=excluded.matched_at`
  ).run(arxivId, trackName, score, JSON.stringify(matchedTerms), now);
}
