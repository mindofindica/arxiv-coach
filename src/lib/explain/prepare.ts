import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../types.js';
import { downloadToFile } from '../download.js';
import { extractPdfToText, hasPdfToText } from '../extract.js';
import { ensureDir } from '../storage.js';
import type { PaperInfo, PrepareResult } from './types.js';

const MIN_TEXT_SIZE = 100;
const MAX_TEXT_CHARS = 50_000;

/**
 * Check if text file exists and has sufficient content
 */
function hasValidText(txtPath: string): boolean {
  try {
    const stats = fs.statSync(txtPath);
    return stats.size > MIN_TEXT_SIZE;
  } catch {
    return false;
  }
}

/**
 * Read first N characters from text file
 */
function readTextPreview(txtPath: string, maxChars: number = MAX_TEXT_CHARS): string {
  const fd = fs.openSync(txtPath, 'r');
  const buffer = Buffer.alloc(maxChars);
  const bytesRead = fs.readSync(fd, buffer, 0, maxChars, 0);
  fs.closeSync(fd);
  return buffer.subarray(0, bytesRead).toString('utf8');
}

/**
 * Prepare paper text for explanation generation
 * 
 * Attempts to ensure text is available by:
 * 1. Using existing text file if valid
 * 2. Extracting from existing PDF
 * 3. Downloading PDF and extracting
 */
export async function preparePaperText(
  paper: PaperInfo,
  config: AppConfig
): Promise<PrepareResult> {
  const { txtPath, pdfPath, pdfUrl } = paper;
  
  // 1. Check if text file already exists and is valid
  if (hasValidText(txtPath)) {
    return {
      status: 'ready',
      textPath: txtPath,
      hasFullText: true,
      paperText: readTextPreview(txtPath),
    };
  }
  
  // 2. Try to extract from existing PDF
  if (fs.existsSync(pdfPath)) {
    if (hasPdfToText()) {
      try {
        extractPdfToText(pdfPath, txtPath);
        if (hasValidText(txtPath)) {
          return {
            status: 'ready',
            textPath: txtPath,
            hasFullText: true,
            paperText: readTextPreview(txtPath),
          };
        }
      } catch {
        // Extraction failed, continue to download attempt
      }
    }
  }
  
  // 3. Try to download PDF and extract
  if (pdfUrl) {
    try {
      ensureDir(path.dirname(pdfPath));
      await downloadToFile(pdfUrl, pdfPath);
      
      if (hasPdfToText()) {
        try {
          extractPdfToText(pdfPath, txtPath);
          if (hasValidText(txtPath)) {
            return {
              status: 'ready',
              textPath: txtPath,
              hasFullText: true,
              paperText: readTextPreview(txtPath),
            };
          }
        } catch {
          // Extraction failed after download
        }
      }
    } catch {
      return {
        status: 'download-failed',
        textPath: txtPath,
        hasFullText: false,
      };
    }
  }
  
  // 4. All attempts failed
  return {
    status: 'no-text',
    textPath: txtPath,
    hasFullText: false,
  };
}
