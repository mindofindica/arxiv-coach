import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';

const repoRoot = path.resolve(process.cwd());
const config = loadConfig(repoRoot);

const dbPath = path.join(config.storage.root, 'db.sqlite');
const db = openDb(dbPath);

migrate(db);
console.log(`DB ready: ${dbPath}`);
