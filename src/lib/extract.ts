import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export function hasPdfToText(): boolean {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function extractPdfToText(pdfPath: string, txtPath: string) {
  // Ensure file exists
  if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);

  // -layout preserves columns better (still imperfect but good V0 default)
  execFileSync('pdftotext', ['-layout', pdfPath, txtPath], { stdio: 'inherit' });

  if (!fs.existsSync(txtPath)) throw new Error(`Text extraction failed: ${txtPath}`);
}
