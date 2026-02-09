export type ExplainLevel = 'eli12' | 'undergrad' | 'engineer';

export interface ExplainPlan {
  kind: 'explainPlan';
  status: 'ready' | 'not-found' | 'ambiguous' | 'no-text';
  level: ExplainLevel;
  paper?: {
    arxivId: string;
    title: string;
    authors: string[];
    abstract: string;
    absUrl: string | null;
    textPath: string;
    hasFullText: boolean;
  };
  candidates?: Array<{
    arxivId: string;
    title: string;
    score: number;
    tracks: string[];
  }>;
  query: string;
}

export interface PaperInfo {
  arxivId: string;
  title: string;
  authors: string[];
  abstract: string;
  score: number;
  tracks: string[];
  pdfPath: string;
  txtPath: string;
  metaPath: string;
  absUrl: string | null;
  pdfUrl: string | null;
}

export interface LookupResult {
  status: 'found' | 'not-found' | 'ambiguous';
  paper?: PaperInfo;
  candidates?: PaperInfo[];
  query: string;
  method: 'arxiv-id' | 'title-search' | 'digest-ref';
}

export interface PrepareResult {
  status: 'ready' | 'no-text' | 'download-failed';
  textPath: string;
  hasFullText: boolean;
  paperText?: string;
}
