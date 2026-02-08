// Placeholder for V0 step 2+. For now, this ensures config + DB migrate works.
import path from 'node:path';
import { loadConfig, loadTracks } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';

const repoRoot = path.resolve(process.cwd());
const config = loadConfig(repoRoot);
const tracks = loadTracks(repoRoot);

const db = openDb(path.join(config.storage.root, 'db.sqlite'));
migrate(db);

console.log(`Loaded ${tracks.tracks.length} tracks. Storage root: ${config.storage.root}`);
console.log('Daily runner scaffold OK. Next: Atom discovery + matching.');
