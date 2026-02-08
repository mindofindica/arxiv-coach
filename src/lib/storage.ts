import fs from 'node:fs';
import path from 'node:path';

export interface PaperPaths {
  paperDir: string;
  pdfPath: string;
  txtPath: string;
  metaPath: string;
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function paperPaths(storageRoot: string, arxivId: string, date = new Date()): PaperPaths {
  const yyyy = date.getUTCFullYear();
  const mm = pad2(date.getUTCMonth() + 1);
  const paperDir = path.join(storageRoot, 'papers', String(yyyy), String(mm), arxivId);
  return {
    paperDir,
    pdfPath: path.join(paperDir, 'paper.pdf'),
    txtPath: path.join(paperDir, 'paper.txt'),
    metaPath: path.join(paperDir, 'meta.json'),
  };
}

export function dailyDigestPath(storageRoot: string, date = new Date()): string {
  const yyyy = date.getUTCFullYear();
  const mm = pad2(date.getUTCMonth() + 1);
  const dd = pad2(date.getUTCDate());
  return path.join(storageRoot, 'digests', 'daily', `${yyyy}-${mm}-${dd}.md`);
}

export function weeklyDigestPath(storageRoot: string, isoWeek: string): string {
  return path.join(storageRoot, 'digests', 'weekly', `${isoWeek}.md`);
}
