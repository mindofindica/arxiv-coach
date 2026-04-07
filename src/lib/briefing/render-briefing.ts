/**
 * Weekly Briefing Renderer
 *
 * Produces a Signal-ready Monday morning AI research digest message.
 * One message, no multi-part delivery — the whole briefing fits in a single Signal bubble.
 *
 * Format:
 *   🌅 Good morning, Mikey — week W13 in AI
 *   Mon 23 Mar → Sun 29 Mar
 *
 *   🔥 Reading streak: 7 days  (longest: 12)
 *   ░░░░░░░▓▓▓▓▓▓▓▓  (14-day window)
 *
 *   📊 Last 7 days
 *   Papers in: 42 | Rated: 8 (19%)
 *   ❤️ 2  ✅ 3  ⭐ 2  😐 1  ⏭️ 5
 *
 *   📌 Top picks this week
 *   1. Scaling Laws for Reward Model Overoptimization
 *      🔥 LLM:5/5 • LLM-engineering, RLHF
 *      First sentence of abstract.
 *      https://arxiv.org/abs/2402.01234
 *
 *   📭 You might have missed
 *   • Speculative Decoding Without a Draft Model
 *     ⭐ LLM:4/5 • LLM-engineering
 *     https://arxiv.org/abs/2402.05678
 *
 *   💪 Keep the streak going!  (or other nudge)
 */

import { truncateForSignal } from '../digest/truncate.js';
import type { WeeklyBriefingData } from './briefing.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function llmScoreEmoji(score: number): string {
  if (score >= 5) return '🔥';
  if (score >= 4) return '⭐';
  return '📌';
}

function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((n / total) * 100)}%`;
}

/**
 * Format a short month-day label like "Mon 23 Mar" from a YYYY-MM-DD string.
 */
function shortDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

/** Streak nudge copy */
function streakNudge(currentStreak: number, longestStreak: number): string {
  if (currentStreak === 0) {
    return '💡 No reads logged this week — a single /read today starts a streak!';
  }
  if (currentStreak >= longestStreak && longestStreak >= 5) {
    return `🏆 ${currentStreak}-day streak — new personal best!`;
  }
  if (currentStreak >= 7) {
    return `🔥 ${currentStreak}-day streak — you're on a roll!`;
  }
  if (currentStreak >= 3) {
    return `💪 ${currentStreak}-day streak — keep it going!`;
  }
  if (longestStreak > currentStreak && longestStreak >= 5) {
    return `📈 ${currentStreak}-day streak — your best was ${longestStreak}. Chase it!`;
  }
  return `📚 ${currentStreak}-day streak — building momentum!`;
}

// ── Renderer ───────────────────────────────────────────────────────────────

/**
 * Render a Monday morning weekly briefing as a Signal-ready message.
 *
 * @param data  The briefing data from buildWeeklyBriefing()
 * @returns     { text, truncated }
 */
export function renderWeeklyBriefing(data: WeeklyBriefingData): { text: string; truncated: boolean } {
  const lines: string[] = [];

  // ── Header ───────────────────────────────────────────────────────────────
  const weekNum = data.weekIso.replace(/^\d{4}-/, '');
  lines.push(`🌅 Good morning, Mikey — ${weekNum} in AI research`);
  lines.push(`${shortDate(data.dateRange.start)} → ${shortDate(data.dateRange.end)}`);

  // ── Streak ───────────────────────────────────────────────────────────────
  lines.push('');
  const { currentStreak, longestStreak, sparkline } = data.streak;
  if (currentStreak > 0) {
    lines.push(`🔥 Reading streak: ${currentStreak} day${currentStreak === 1 ? '' : 's'}  (best: ${longestStreak})`);
  } else {
    lines.push(`😴 Reading streak: 0  (best: ${longestStreak})`);
  }
  if (sparkline) {
    lines.push(sparkline + `  (${data.streak.windowDays}d)`);
  }

  // ── Feedback stats ───────────────────────────────────────────────────────
  lines.push('');
  lines.push('📊 Last 7 days');
  const { feedback } = data;
  const engStr =
    feedback.engagementRate !== null
      ? `${pct(
          feedback.loved + feedback.read + feedback.saved + feedback.meh,
          feedback.papersIngested,
        )} engagement`
      : null;

  if (feedback.papersIngested > 0 || feedback.total > 0) {
    const ingestLine = `📥 ${feedback.papersIngested} paper${feedback.papersIngested === 1 ? '' : 's'} in`;
    const ratedLine = `${feedback.total} rated${engStr ? ` (${engStr})` : ''}`;
    lines.push(`${ingestLine}  •  ${ratedLine}`);
  } else {
    lines.push('No papers ingested or rated this week');
  }

  if (feedback.total > 0) {
    const parts: string[] = [];
    if (feedback.loved > 0) parts.push(`❤️ ${feedback.loved}`);
    if (feedback.read > 0) parts.push(`✅ ${feedback.read}`);
    if (feedback.saved > 0) parts.push(`⭐ ${feedback.saved}`);
    if (feedback.meh > 0) parts.push(`😐 ${feedback.meh}`);
    if (feedback.skipped > 0) parts.push(`⏭️ ${feedback.skipped}`);
    lines.push(parts.join('  '));
  }

  // ── Top papers ───────────────────────────────────────────────────────────
  if (data.topPapers.length > 0) {
    lines.push('');
    const hasLlm = data.topPapers.some((p) => p.llmScore !== null);
    lines.push(hasLlm ? '📌 Top picks this week (LLM-ranked)' : '📌 Top picks this week');
    lines.push('');

    for (let i = 0; i < data.topPapers.length; i++) {
      const p = data.topPapers[i]!;
      lines.push(`${i + 1}. ${p.title}`);

      const scoreStr =
        p.llmScore !== null
          ? `${llmScoreEmoji(p.llmScore)} LLM:${p.llmScore}/5`
          : `kw:${p.keywordScore}`;
      const trackStr = p.tracks.length > 0 ? ` • ${p.tracks.join(', ')}` : '';
      lines.push(`   ${scoreStr}${trackStr}`);
      lines.push(`   ${p.highlight}`);
      lines.push(`   ${p.absUrl}`);
    }
  }

  // ── You might have missed ─────────────────────────────────────────────────
  if (data.missedPapers.length > 0) {
    lines.push('');
    lines.push('📭 You might have missed');
    lines.push('');

    for (const p of data.missedPapers) {
      lines.push(`• ${p.title}`);
      const scoreStr = p.llmScore !== null ? `${llmScoreEmoji(p.llmScore)} LLM:${p.llmScore}/5` : null;
      const trackStr = p.tracks.length > 0 ? p.tracks.join(', ') : null;
      const meta = [scoreStr, trackStr].filter(Boolean).join(' • ');
      if (meta) lines.push(`  ${meta}`);
      lines.push(`  ${p.absUrl}`);
    }
  }

  // ── Streak nudge ─────────────────────────────────────────────────────────
  lines.push('');
  lines.push(streakNudge(currentStreak, longestStreak));

  return truncateForSignal(lines.join('\n'));
}
