import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { preparePaperText } from './prepare.js';
import type { PaperInfo } from './types.js';
import type { AppConfig } from '../types.js';

// Mock the download and extract modules
vi.mock('../download.js', () => ({
  downloadToFile: vi.fn(),
}));

vi.mock('../extract.js', () => ({
  extractPdfToText: vi.fn(),
  hasPdfToText: vi.fn(),
}));

// Import mocked functions for control in tests
import { downloadToFile } from '../download.js';
import { extractPdfToText, hasPdfToText } from '../extract.js';

const mockedDownloadToFile = vi.mocked(downloadToFile);
const mockedExtractPdfToText = vi.mocked(extractPdfToText);
const mockedHasPdfToText = vi.mocked(hasPdfToText);

describe('preparePaperText', () => {
  let tmpDir: string;
  let config: AppConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-coach-prepare-'));
    
    config = {
      timezone: 'UTC',
      schedule: { dailyDigestTime: '08:30', weekly: { day: 'Sunday', time: '10:00' } },
      discovery: { categories: ['cs.AI'] },
      storage: { root: tmpDir, keepPdfsForever: true },
      limits: { maxItemsPerDigest: 5, maxPerTrackPerDay: 2 },
    };

    // Reset mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePaper(overrides: Partial<PaperInfo> = {}): PaperInfo {
    const paperDir = path.join(tmpDir, 'papers', '2602.00001');
    fs.mkdirSync(paperDir, { recursive: true });

    return {
      arxivId: '2602.00001',
      title: 'Test Paper',
      authors: ['Author One'],
      abstract: 'Test abstract',
      score: 5,
      tracks: ['Track A'],
      pdfPath: path.join(paperDir, 'paper.pdf'),
      txtPath: path.join(paperDir, 'paper.txt'),
      metaPath: path.join(paperDir, 'meta.json'),
      absUrl: 'https://arxiv.org/abs/2602.00001',
      pdfUrl: 'https://arxiv.org/pdf/2602.00001.pdf',
      ...overrides,
    };
  }

  it('returns ready when text file exists and is valid', async () => {
    const paper = makePaper();
    const textContent = 'This is the paper text content. '.repeat(10);
    fs.writeFileSync(paper.txtPath, textContent);

    const result = await preparePaperText(paper, config);

    expect(result.status).toBe('ready');
    expect(result.textPath).toBe(paper.txtPath);
    expect(result.hasFullText).toBe(true);
    expect(result.paperText).toBe(textContent);
  });

  it('extracts from PDF when text missing but PDF exists', async () => {
    const paper = makePaper();
    fs.writeFileSync(paper.pdfPath, '%PDF-1.4 fake pdf content');
    
    mockedHasPdfToText.mockReturnValue(true);
    mockedExtractPdfToText.mockImplementation((pdfPath, txtPath) => {
      fs.writeFileSync(txtPath, 'Extracted text content from PDF. '.repeat(10));
    });

    const result = await preparePaperText(paper, config);

    expect(result.status).toBe('ready');
    expect(result.hasFullText).toBe(true);
    expect(mockedExtractPdfToText).toHaveBeenCalledWith(paper.pdfPath, paper.txtPath);
  });

  it('downloads PDF and extracts when both missing', async () => {
    const paper = makePaper();
    
    mockedHasPdfToText.mockReturnValue(true);
    mockedDownloadToFile.mockImplementation(async (url, outPath) => {
      fs.writeFileSync(outPath, '%PDF-1.4 downloaded content');
      return { bytes: 100, sha256: 'abc123' };
    });
    mockedExtractPdfToText.mockImplementation((pdfPath, txtPath) => {
      fs.writeFileSync(txtPath, 'Extracted from downloaded PDF. '.repeat(10));
    });

    const result = await preparePaperText(paper, config);

    expect(result.status).toBe('ready');
    expect(mockedDownloadToFile).toHaveBeenCalledWith(paper.pdfUrl, paper.pdfPath);
    expect(mockedExtractPdfToText).toHaveBeenCalled();
  });

  it('returns download-failed when download fails', async () => {
    const paper = makePaper();
    
    mockedDownloadToFile.mockRejectedValue(new Error('Network error'));

    const result = await preparePaperText(paper, config);

    expect(result.status).toBe('download-failed');
    expect(result.hasFullText).toBe(false);
  });

  it('returns no-text when pdftotext is not available', async () => {
    const paper = makePaper({ pdfUrl: null });
    fs.writeFileSync(paper.pdfPath, '%PDF-1.4 content');
    
    mockedHasPdfToText.mockReturnValue(false);

    const result = await preparePaperText(paper, config);

    expect(result.status).toBe('no-text');
    expect(result.hasFullText).toBe(false);
  });

  it('re-extracts when text file is too small', async () => {
    const paper = makePaper();
    fs.writeFileSync(paper.txtPath, 'tiny'); // Less than 100 bytes
    fs.writeFileSync(paper.pdfPath, '%PDF-1.4 content');
    
    mockedHasPdfToText.mockReturnValue(true);
    mockedExtractPdfToText.mockImplementation((pdfPath, txtPath) => {
      fs.writeFileSync(txtPath, 'Properly extracted text content. '.repeat(10));
    });

    const result = await preparePaperText(paper, config);

    expect(result.status).toBe('ready');
    expect(mockedExtractPdfToText).toHaveBeenCalled();
  });

  it('truncates text to 50000 chars', async () => {
    const paper = makePaper();
    const longText = 'x'.repeat(100_000);
    fs.writeFileSync(paper.txtPath, longText);

    const result = await preparePaperText(paper, config);

    expect(result.status).toBe('ready');
    expect(result.paperText?.length).toBe(50_000);
  });

  it('returns no-text when no pdfUrl and no local files', async () => {
    const paper = makePaper({ pdfUrl: null });
    // No pdf, no txt

    mockedHasPdfToText.mockReturnValue(true);

    const result = await preparePaperText(paper, config);

    expect(result.status).toBe('no-text');
  });

  it('handles extraction failure gracefully', async () => {
    const paper = makePaper({ pdfUrl: null });
    fs.writeFileSync(paper.pdfPath, '%PDF-1.4 corrupted');
    
    mockedHasPdfToText.mockReturnValue(true);
    mockedExtractPdfToText.mockImplementation(() => {
      throw new Error('Extraction failed');
    });

    const result = await preparePaperText(paper, config);

    expect(result.status).toBe('no-text');
  });
});
