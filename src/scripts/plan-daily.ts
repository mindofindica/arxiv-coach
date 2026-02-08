import path from 'node:path';

import { loadConfig, loadTracks } from '../lib/config.js';
import { runDaily } from '../lib/runners/daily.js';

const repoRoot = path.resolve(process.cwd());
const config = loadConfig(repoRoot);
const tracksFile = loadTracks(repoRoot);

const res = await runDaily({ config, tracksFile });

// Always exit 0. Consumers should inspect res.status.
// This is the single machine-readable output used by the OpenClaw delivery runner.
console.log(JSON.stringify({
  kind: 'dailyPlan',
  status: res.status,
  discoveryErrors: res.stats.discoveryErrors ?? [],
  digestPlan: res.stats.digestPlan,
}));
