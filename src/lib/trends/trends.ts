/**
 * Trends Analyser
 *
 * Analyses keyword frequency shifts in Mikey's feedback history to identify
 * which research topics are rising, falling, or stable in his personal
 * reading landscape.
 *
 * Data source: paper_feedback + papers tables.
 * Positive feedback (love/save/read) weighted heavier than neutral/skip.
 *
 * Algorithm:
 *  1. Pull all papers with feedback in the last N weeks
 *  2. Extract keywords from titles (noun phrases, multi-word terms)
 *  3. Bucket keywords by ISO week
 *  4. Compare recent half vs older half → % change per keyword
 *  5. Classify: rising (+30%+), falling (-30%-), stable (in between)
 */

import type { Db } from '../db.js';

// ── Stopwords ──────────────────────────────────────────────────────────────
// Common English words that shouldn't appear as keywords
const STOPWORDS = new Set([
  // Articles / conjunctions / prepositions
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'can', 'shall',
  // Pronouns / determiners
  'this', 'that', 'these', 'those', 'its', 'it', 'we', 'our', 'they',
  // Common prepositions / adverbs
  'via', 'into', 'towards', 'toward', 'through', 'under', 'over',
  'about', 'up', 'out', 'all', 'you', 'need',
  // Vague research words (too generic to be useful trends)
  'approach', 'method', 'methods', 'task', 'tasks', 'paper', 'papers',
  'study', 'work', 'analysis', 'evaluation', 'results', 'using', 'based',
]);

// Minimum chars for a single-word keyword to be considered
const MIN_KEYWORD_LEN = 3;

// Signal strengths for weighting (mirrors recorder.ts)
const FEEDBACK_WEIGHTS: Record<string, number> = {
  love: 3,
  save: 2,
  read: 2,
  meh: 1,
  skip: 0,   // skip contributes but doesn't boost
};

// ── Types ──────────────────────────────────────────────────────────────────

export type TrendDirection = 'rising' | 'falling' | 'stable';

export interface KeywordTrend {
  keyword: string;
  direction: TrendDirection;
  /** Score in the recent half of the window */
  recentScore: number;
  /** Score in the older half of the window */
  olderScore: number;
  /** Percentage change (positive = rising, negative = falling) */
  pctChange: number;
  /** Total appearances across the whole window */
  totalAppearances: number;
  /** Example paper titles containing this keyword */
  exampleTitles: string[];
}

export interface TrendsResult {
  rising: KeywordTrend[];
  falling: KeywordTrend[];
  stable: KeywordTrend[];
  windowWeeks: number;
  fromDate: string;
  toDate: string;
  totalPapersAnalysed: number;
  uniqueKeywords: number;
}

export interface TrendsOptions {
  /** Number of weeks to look back (default: 8) */
  weeks?: number;
  /** Minimum total weighted appearances to include a keyword (default: 2) */
  minAppearances?: number;
  /** % change threshold to classify as rising/falling (default: 30) */
  thresholdPct?: number;
  /** Maximum keywords to return per category (default: 10) */
  limit?: number;
}

// ── Row types ──────────────────────────────────────────────────────────────

interface FeedbackRow {
  arxiv_id: string;
  title: string;
  feedback_type: string;
  interacted_at: string;  // ISO date string
}

// ── Keyword extraction ─────────────────────────────────────────────────────

/**
 * Extract meaningful keywords and 2-gram phrases from a paper title.
 * Returns lowercased, de-stopworded tokens + meaningful bigrams.
 */
export function extractKeywords(title: string): string[] {
  // Normalise: lowercase, strip punctuation except hyphens
  const normalised = title.toLowerCase().replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = normalised.split(' ').filter(t => t.length >= MIN_KEYWORD_LEN);

  // Single keywords (filter stopwords)
  const singles = tokens.filter(t => !STOPWORDS.has(t) && !/^\d+$/.test(t));

  // Bigrams from all tokens (even with stopwords as bridges)
  const bigrams: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i]!;
    const b = tokens[i + 1]!;
    // Only include bigrams where at least one word is meaningful
    if (!STOPWORDS.has(a) || !STOPWORDS.has(b)) {
      const bigram = `${a} ${b}`;
      // Skip bigrams that are pure stopword combos
      if (!STOPWORDS.has(a) && !STOPWORDS.has(b)) {
        bigrams.push(bigram);
      }
    }
  }

  // Deduplicate and return
  return [...new Set([...singles, ...bigrams])];
}

// ── ISO week helper ────────────────────────────────────────────────────────

/**
 * Get ISO week string (YYYY-Www) from a date string.
 */
export function isoWeekOf(dateStr: string): string {
  // Use UTC arithmetic to avoid timezone drift
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = d.getUTCDay() || 7; // Mon=1 … Sun=7
  // Shift to the Thursday of this ISO week
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// ── Main analysis ──────────────────────────────────────────────────────────

/**
 * Analyse keyword frequency trends across Mikey's feedback history.
 *
 * Returns keywords classified as rising, falling, or stable based on
 * whether their weighted occurrence increased or decreased between the
 * older half and the recent half of the time window.
 */
export function analyseTrends(db: Db, opts: TrendsOptions = {}): TrendsResult {
  const {
    weeks = 8,
    minAppearances = 2,
    thresholdPct = 30,
    limit = 10,
  } = opts;

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - weeks * 7);
  const fromDate = cutoffDate.toISOString().slice(0, 10);
  const toDate = new Date().toISOString().slice(0, 10);

  // Pull papers with feedback in the window
  const rows = db.sqlite.prepare(`
    SELECT
      p.arxiv_id,
      p.title,
      pf.feedback_type,
      pf.created_at AS interacted_at
    FROM paper_feedback pf
    JOIN papers p ON p.arxiv_id = pf.paper_id
    WHERE pf.created_at >= ?
    ORDER BY pf.created_at ASC
  `).all(fromDate) as FeedbackRow[];

  if (rows.length === 0) {
    return {
      rising: [],
      falling: [],
      stable: [],
      windowWeeks: weeks,
      fromDate,
      toDate,
      totalPapersAnalysed: 0,
      uniqueKeywords: 0,
    };
  }

  // Mid-point: exactly halfway through the calendar window
  const midPoint = new Date();
  midPoint.setDate(midPoint.getDate() - Math.floor((weeks * 7) / 2));
  const midDate = midPoint.toISOString().slice(0, 10);

  // Accumulate weighted scores per keyword, split by older/recent
  const keywordScores = new Map<string, { older: number; recent: number; titles: Set<string> }>();

  const seenPapers = new Set<string>();
  for (const row of rows) {
    seenPapers.add(row.arxiv_id);
    const weight = FEEDBACK_WEIGHTS[row.feedback_type] ?? 1;
    const isRecent = row.interacted_at >= midDate;
    const keywords = extractKeywords(row.title);

    for (const kw of keywords) {
      let entry = keywordScores.get(kw);
      if (!entry) {
        entry = { older: 0, recent: 0, titles: new Set() };
        keywordScores.set(kw, entry);
      }
      if (isRecent) {
        entry.recent += weight;
      } else {
        entry.older += weight;
      }
      entry.titles.add(row.title);
    }
  }

  // Convert to trend classifications
  const trends: KeywordTrend[] = [];

  for (const [keyword, scores] of keywordScores) {
    const totalAppearances = scores.older + scores.recent;
    if (totalAppearances < minAppearances) continue;

    let pctChange: number;
    if (scores.older === 0 && scores.recent > 0) {
      // Emerged in recent half — maximum rise
      pctChange = 200;
    } else if (scores.older > 0 && scores.recent === 0) {
      // Dropped off completely — maximum fall
      pctChange = -100;
    } else if (scores.older === 0 && scores.recent === 0) {
      pctChange = 0;
    } else {
      pctChange = ((scores.recent - scores.older) / scores.older) * 100;
    }

    let direction: TrendDirection;
    if (pctChange >= thresholdPct) {
      direction = 'rising';
    } else if (pctChange <= -thresholdPct) {
      direction = 'falling';
    } else {
      direction = 'stable';
    }

    const exampleTitles = [...scores.titles].slice(0, 2);

    trends.push({
      keyword,
      direction,
      recentScore: scores.recent,
      olderScore: scores.older,
      pctChange: Math.round(pctChange),
      totalAppearances,
      exampleTitles,
    });
  }

  // Sort each category by total appearances descending, then by abs(pctChange)
  const sortFn = (a: KeywordTrend, b: KeywordTrend) =>
    b.totalAppearances - a.totalAppearances || Math.abs(b.pctChange) - Math.abs(a.pctChange);

  const rising = trends
    .filter(t => t.direction === 'rising')
    .sort((a, b) => b.pctChange - a.pctChange || b.totalAppearances - a.totalAppearances)
    .slice(0, limit);

  const falling = trends
    .filter(t => t.direction === 'falling')
    .sort((a, b) => a.pctChange - b.pctChange || b.totalAppearances - a.totalAppearances)
    .slice(0, limit);

  const stable = trends
    .filter(t => t.direction === 'stable')
    .sort(sortFn)
    .slice(0, limit);

  return {
    rising,
    falling,
    stable,
    windowWeeks: weeks,
    fromDate,
    toDate,
    totalPapersAnalysed: seenPapers.size,
    uniqueKeywords: keywordScores.size,
  };
}

// ── Formatting ─────────────────────────────────────────────────────────────

/**
 * Format a TrendsResult into a Signal-friendly plain-text message.
 */
export function formatTrendsReply(result: TrendsResult): string {
  const { rising, falling, stable, windowWeeks, fromDate, toDate, totalPapersAnalysed } = result;

  if (totalPapersAnalysed === 0) {
    return (
      `📊 No feedback data in the last ${windowWeeks} weeks.\n\n` +
      `Start using /read, /love, /save, /skip, or /meh on papers to build your trends history.`
    );
  }

  const lines: string[] = [];
  lines.push(`📊 *Your Research Trends* (${windowWeeks}w: ${fromDate} → ${toDate})`);
  lines.push(`Analysed ${totalPapersAnalysed} paper${totalPapersAnalysed !== 1 ? 's' : ''} with feedback\n`);

  if (rising.length > 0) {
    lines.push('📈 *Rising topics*');
    for (const t of rising) {
      const arrow = t.pctChange >= 200 ? '🆕' : `+${t.pctChange}%`;
      lines.push(`  ${arrow}  ${t.keyword}`);
    }
    lines.push('');
  }

  if (falling.length > 0) {
    lines.push('📉 *Fading topics*');
    for (const t of falling) {
      const arrow = t.pctChange <= -100 ? '🔇' : `${t.pctChange}%`;
      lines.push(`  ${arrow}  ${t.keyword}`);
    }
    lines.push('');
  }

  if (stable.length > 0) {
    lines.push('➡️  *Stable interests*');
    lines.push('  ' + stable.slice(0, 6).map(t => t.keyword).join(' · '));
    lines.push('');
  }

  if (rising.length === 0 && falling.length === 0) {
    lines.push('Your reading pattern is stable — no significant shifts detected yet.');
    lines.push('');
  }

  lines.push(`_Tip: /trends --weeks 4 for a tighter window, /trends --weeks 12 for broader view_`);

  return lines.join('\n');
}
