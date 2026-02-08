export type IsoDateTime = string;

export interface TrackConfig {
  name: string;
  enabled: boolean;
  categories: string[];
  phrases: string[];
  keywords: string[];
  exclude: string[];
  threshold: number;
  maxPerDay: number;
}

export interface TracksFile {
  tracks: TrackConfig[];
  limits?: {
    maxItemsPerDigest?: number;
  };
}

export interface AppConfig {
  timezone: string;
  schedule: {
    dailyDigestTime: string; // HH:MM
    weekly: {
      day: string; // e.g. Sun
      time: string; // HH:MM
    };
  };
  discovery: {
    categories: string[];
  };
  storage: {
    root: string;
    keepPdfsForever: boolean;
  };
  limits: {
    maxItemsPerDigest: number;
    maxPerTrackPerDay: number;
  };
}

export interface PaperRow {
  arxiv_id: string;
  latest_version: string | null;
  title: string;
  abstract: string;
  authors_json: string;
  categories_json: string;
  published_at: IsoDateTime;
  updated_at: IsoDateTime;
  pdf_path: string;
  txt_path: string;
  meta_path: string;
  sha256_pdf: string | null;
  ingested_at: IsoDateTime;
}
