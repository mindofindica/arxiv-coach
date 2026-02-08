import fs from 'node:fs';

export function isPdfFileValid(pdfPath: string): boolean {
  try {
    const fd = fs.openSync(pdfPath, 'r');
    const buf = Buffer.alloc(5);
    fs.readSync(fd, buf, 0, 5, 0);
    fs.closeSync(fd);
    return buf.toString('utf8') === '%PDF-';
  } catch {
    return false;
  }
}
