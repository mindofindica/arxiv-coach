import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export interface Db {
  sqlite: Database.Database;
}

const SCHEMA_VERSION = 2;

export function openDb(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return { sqlite };
}

export function migrate(db: Db) {
  const sqlite = db.sqlite;

  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS schema_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );`
  );

  const row = sqlite.prepare('SELECT version FROM schema_meta WHERE id=1').get() as { version?: number } | undefined;
  const current = row?.version ?? 0;
  if (current === SCHEMA_VERSION) return;

  // v1 bootstrap
  if (current === 0) {
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS papers (
        arxiv_id TEXT PRIMARY KEY,
        latest_version TEXT,
        title TEXT NOT NULL,
        abstract TEXT NOT NULL,
        authors_json TEXT NOT NULL,
        categories_json TEXT NOT NULL,
        published_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        pdf_path TEXT NOT NULL,
        txt_path TEXT NOT NULL,
        meta_path TEXT NOT NULL,
        sha256_pdf TEXT,
        ingested_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS paper_versions (
        arxiv_id TEXT NOT NULL,
        version TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        pdf_sha256 TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (arxiv_id, version),
        FOREIGN KEY (arxiv_id) REFERENCES papers(arxiv_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS track_matches (
        arxiv_id TEXT NOT NULL,
        track_name TEXT NOT NULL,
        score INTEGER NOT NULL,
        matched_terms_json TEXT NOT NULL,
        matched_at TEXT NOT NULL,
        PRIMARY KEY (arxiv_id, track_name),
        FOREIGN KEY (arxiv_id) REFERENCES papers(arxiv_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        stats_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_papers_updated_at ON papers(updated_at);
      CREATE INDEX IF NOT EXISTS idx_track_matches_track ON track_matches(track_name);
      CREATE INDEX IF NOT EXISTS idx_track_matches_matched_at ON track_matches(matched_at);
      `
    );

    sqlite
      .prepare('INSERT OR REPLACE INTO schema_meta (id, version, updated_at) VALUES (1, ?, ?)')
      .run(1, new Date().toISOString());
  }

  // v2 migration
  if (current <= 1) {
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS sent_digests (
        digest_date TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        header_text TEXT NOT NULL,
        tracks_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sent_digests_sent_at ON sent_digests(sent_at);
      `
    );

    sqlite.prepare('UPDATE schema_meta SET version=?, updated_at=? WHERE id=1')
      .run(2, new Date().toISOString());
  }
}
