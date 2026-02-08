import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { AppConfig, TracksFile } from './types.js';

const hhmm = z.string().regex(/^\d{2}:\d{2}$/, 'expected HH:MM');

const AppConfigSchema = z.object({
  timezone: z.string().default('Europe/Amsterdam'),
  schedule: z.object({
    dailyDigestTime: hhmm,
    weekly: z.object({
      day: z.string(),
      time: hhmm,
    }),
  }),
  discovery: z.object({
    categories: z.array(z.string()).min(1),
  }),
  storage: z.object({
    root: z.string().min(1),
    keepPdfsForever: z.boolean().default(true),
  }),
  limits: z.object({
    maxItemsPerDigest: z.number().int().min(1).max(50).default(5),
    maxPerTrackPerDay: z.number().int().min(1).max(10).default(2),
  }),
});

const TracksSchema = z.object({
  tracks: z.array(
    z.object({
      name: z.string().min(1),
      enabled: z.boolean().default(true),
      categories: z.array(z.string()).default([]),
      phrases: z.array(z.string()).default([]),
      keywords: z.array(z.string()).default([]),
      exclude: z.array(z.string()).default([]),
      threshold: z.number().int().min(0).default(0),
      maxPerDay: z.number().int().min(1).max(20).default(2),
    })
  ),
  limits: z
    .object({
      maxItemsPerDigest: z.number().int().min(1).max(50).optional(),
    })
    .optional(),
});

export function loadYamlFile<T>(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, 'utf8');
  return YAML.parse(raw);
}

export function loadConfig(repoRoot: string): AppConfig {
  const configPath = path.join(repoRoot, 'config.yml');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing config.yml at ${configPath}. Copy config.example.yml → config.yml and edit.`);
  }
  const parsed = loadYamlFile(configPath);
  return AppConfigSchema.parse(parsed) as AppConfig;
}

export function loadTracks(repoRoot: string): TracksFile {
  const tracksPath = path.join(repoRoot, 'tracks.yml');
  if (!fs.existsSync(tracksPath)) {
    throw new Error(`Missing tracks.yml at ${tracksPath}`);
  }
  const parsed = loadYamlFile(tracksPath);
  return TracksSchema.parse(parsed) as TracksFile;
}
