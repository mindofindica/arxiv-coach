/**
 * render-progress.ts — Format ProgressData into a Signal-ready message.
 *
 * Output example:
 *
 *   📈 Learning velocity — W13 (23–29 Mar)
 *
 *   This week:  5 papers engaged  (+25% vs last week)
 *   Last week:  4 papers
 *   4-wk avg:   3.5/week
 *
 *   📥 1149 in   ⚡ 0.4% rate
 *   📊 Avg paper quality: 3.2/5 ↑
 *
 *   👍 Trend: building momentum — above your 4-week average!
 */

import type { ProgressData, WeekStats } from './progress.js';

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatWeekLabel(monday: string): string {
  const start = new Date(monday + 'T12:00:00Z');
  const end = new Date(monday + 'T12:00:00Z');
  end.setUTCDate(end.getUTCDate() + 6);

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const startDay = start.getUTCDate();
  const endDay = end.getUTCDate();
  const startMonth = months[start.getUTCMonth()];
  const endMonth = months[end.getUTCMonth()];

  if (start.getUTCMonth() === end.getUTCMonth()) {
    return `${startDay}–${endDay} ${startMonth}`;
  }
  return `${startDay} ${startMonth}–${endDay} ${endMonth}`;
}

function isoWeekNumber(monday: string): number {
  // ISO week number: Jan 4 is always in week 1
  const d = new Date(monday + 'T12:00:00Z');
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const jan4Monday = new Date(jan4);
  const dow = jan4.getUTCDay() || 7;
  jan4Monday.setUTCDate(jan4.getUTCDate() - dow + 1);
  const diff = d.getTime() - jan4Monday.getTime();
  return Math.floor(diff / (7 * 24 * 60 * 60 * 1000)) + 1;
}

function formatEngagementRate(rate: number | null): string {
  if (rate === null) return '';
  const pct = (rate * 100).toFixed(1);
  return `⚡ ${pct}% engagement`;
}

function formatAvgScore(score: number | null, improved: boolean | null): string {
  if (score === null) return '';
  const arrow = improved === true ? ' ↑' : improved === false ? ' ↓' : '';
  return `📊 Avg quality: ${score.toFixed(1)}/5${arrow}`;
}

function formatTrendLine(data: ProgressData): string {
  const { trendDirection, pctChange, thisWeek, rollingAvgEngaged } = data;
  const aboveAvg = thisWeek.engaged > rollingAvgEngaged;

  if (thisWeek.engaged === 0 && data.lastWeek.engaged === 0) {
    return '💡 No reads logged yet — start with /read <arxiv-id>!';
  }

  if (trendDirection === 'up') {
    const change = pctChange !== null ? ` (+${pctChange}%)` : '';
    if (aboveAvg) {
      return `🚀 On a roll${change} — above your 4-week average!`;
    }
    return `📈 Improving${change} — gaining momentum`;
  }

  if (trendDirection === 'down') {
    const change = pctChange !== null ? ` (${pctChange}%)` : '';
    if (aboveAvg) {
      return `📉 Slowed down a bit${change}, still above average`;
    }
    return `📉 Down${change} — pick up a paper today?`;
  }

  // flat
  if (aboveAvg) {
    return `➡️ Steady — above your 4-week average`;
  }
  return `➡️ Steady pace`;
}

function pluralise(n: number, singular: string, plural: string): string {
  return n === 1 ? `${n} ${singular}` : `${n} ${plural}`;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function renderProgressReply(data: ProgressData): string {
  const { thisWeek, lastWeek, rollingAvgEngaged } = data;
  const weekNum = isoWeekNumber(thisWeek.weekStart);
  const dateRange = formatWeekLabel(thisWeek.weekStart);

  const lines: string[] = [];

  // Header
  lines.push(`📈 Learning velocity — W${weekNum} (${dateRange})`);
  lines.push('');

  // This week vs last week
  const changeStr = data.pctChange !== null
    ? ` (${data.pctChange > 0 ? '+' : ''}${data.pctChange}% vs last week)`
    : '';

  lines.push(`This week:  ${pluralise(thisWeek.engaged, 'paper engaged', 'papers engaged')}${changeStr}`);
  lines.push(`Last week:  ${pluralise(lastWeek.engaged, 'paper', 'papers')}`);
  lines.push(`4-wk avg:   ${rollingAvgEngaged.toFixed(1)}/week`);

  // Supply + engagement rate
  const supplyParts: string[] = [];
  if (thisWeek.papersIngested > 0) {
    supplyParts.push(`📥 ${thisWeek.papersIngested} in`);
  }
  const rateStr = formatEngagementRate(thisWeek.engagementRate);
  if (rateStr) supplyParts.push(rateStr);
  if (supplyParts.length > 0) {
    lines.push('');
    lines.push(supplyParts.join('  •  '));
  }

  // Quality score
  const scoreStr = formatAvgScore(thisWeek.avgLlmScore, data.scoreImproved);
  if (scoreStr) {
    lines.push(scoreStr);
  }

  // Feedback breakdown (if any activity)
  if (thisWeek.totalFeedback > 0) {
    lines.push('');
    const parts: string[] = [];
    const counts = {
      love: 0, read: 0, save: 0, meh: 0, skip: 0,
    };
    // We don't have per-type counts in ProgressData — just totals
    // Use engaged/passive split
    if (thisWeek.engaged > 0) parts.push(`❤️✅⭐ ${thisWeek.engaged} engaged`);
    if (thisWeek.passive > 0) parts.push(`😐⏭️ ${thisWeek.passive} passive`);
    if (parts.length > 0) {
      lines.push(parts.join('  •  '));
    }
  }

  // Trend line
  lines.push('');
  lines.push(formatTrendLine(data));

  return lines.join('\n');
}
