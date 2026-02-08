import path from 'node:path';

import { loadConfig, loadTracks } from '../lib/config.js';
import { runDaily } from '../lib/runners/daily.js';

const repoRoot = path.resolve(process.cwd());
const config = loadConfig(repoRoot);
const tracksFile = loadTracks(repoRoot);

const res = await runDaily({ config, tracksFile });

if (res.status === 'warn') {
  // Surface warnings in exit code so cron/runner can alert.
  process.exitCode = 2;
}
