/**
 * render-gaps.ts — Format GapsQueryResult into a Signal-ready message.
 *
 * Output examples:
 *
 *   === No active gaps ===
 *   🎉 You've worked through everything! 3 concepts understood.
 *   Use /gaps --all to see the full list.
 *
 *   === With active gaps ===
 *   🧠 Knowledge gaps (3 active, 2 understood)
 *
 *   1. Speculative Decoding   [identified]   ★★★
 *      Via: 2401.12345 — "Fast Inference for Transformers"
 *
 *   2. LoRA Rank Selection   [lesson_queued]   ★★
 *      Via: paper "PEFT at scale"
 *
 *   3. KV Cache Quantization   [identified]   ★
 *      (no paper link)
 *
 *   💡 Reply /gaps --all to include understood concepts
 */

import type { KnowledgeGap } from './repo.js';
import type { GapsQueryResult } from './query.js';

// ─── Status labels ────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  identified: '🔍 new',
  lesson_queued: '📝 lesson pending',
  understood: '✅ understood',
};

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

// ─── Priority stars ───────────────────────────────────────────────────────────

/**
 * Convert priority 0–100 to 1–3 stars.
 *   ≥70 → ★★★
 *   40–69 → ★★
 *   <40 → ★
 */
function priorityStars(priority: number): string {
  if (priority >= 70) return '★★★';
  if (priority >= 40) return '★★';
  return '★';
}

// ─── Gap formatting ───────────────────────────────────────────────────────────

function formatGapLine(gap: KnowledgeGap, index: number): string {
  const lines: string[] = [];

  // Main line: number. Concept  [status]  stars
  const mainParts = [
    `${index}. *${gap.concept}*`,
    statusLabel(gap.status),
    priorityStars(gap.priority),
  ];
  lines.push(mainParts.join('   '));

  // Source line (paper or detection method)
  if (gap.arxivId && gap.paperTitle) {
    const title = gap.paperTitle.length > 50
      ? gap.paperTitle.slice(0, 47) + '…'
      : gap.paperTitle;
    lines.push(`   📄 ${gap.arxivId} — "${title}"`);
  } else if (gap.paperTitle) {
    const title = gap.paperTitle.length > 50
      ? gap.paperTitle.slice(0, 47) + '…'
      : gap.paperTitle;
    lines.push(`   📄 "${title}"`);
  } else if (gap.detectionMethod) {
    lines.push(`   🔧 Detected via: ${gap.detectionMethod}`);
  }

  return lines.join('\n');
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Render a GapsQueryResult into a Signal message string.
 *
 * @param result       - Query result from queryGaps()
 * @param showingAll   - Whether --all was used (affects footer hint)
 */
export function renderGapsReply(result: GapsQueryResult, showingAll = false): string {
  const { gaps, totalActive, totalUnderstood } = result;
  const lines: string[] = [];

  // ── Empty state ──
  if (result.totalAll === 0) {
    lines.push('🧠 No knowledge gaps tracked yet.');
    lines.push('');
    lines.push('Gaps are detected automatically when papers mention concepts you haven\'t engaged with.');
    lines.push('You can also add one manually — ask Indica.');
    return lines.join('\n');
  }

  if (gaps.length === 0 && !showingAll) {
    lines.push('🎉 No active gaps right now!');
    if (totalUnderstood > 0) {
      lines.push(`You've understood ${totalUnderstood} concept${totalUnderstood === 1 ? '' : 's'}.`);
      lines.push('');
      lines.push('Use /gaps --all to see the full history.');
    }
    return lines.join('\n');
  }

  if (gaps.length === 0 && showingAll) {
    lines.push('🧠 No gaps found.');
    return lines.join('\n');
  }

  // ── Header ──
  const parts: string[] = [];
  if (totalActive > 0) {
    parts.push(`${totalActive} active`);
  }
  if (totalUnderstood > 0) {
    parts.push(`${totalUnderstood} understood`);
  }
  const countSummary = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  lines.push(`🧠 Knowledge gaps${countSummary}`);
  lines.push('');

  // ── Gap list ──
  gaps.forEach((gap, i) => {
    lines.push(formatGapLine(gap, i + 1));
    lines.push('');
  });

  // ── Footer hint ──
  if (!showingAll && totalUnderstood > 0) {
    lines.push(`💡 /gaps --all to include ${totalUnderstood} understood concept${totalUnderstood === 1 ? '' : 's'}`);
  } else if (!showingAll && totalActive > gaps.length) {
    const remaining = totalActive - gaps.length;
    lines.push(`💡 ${remaining} more — use /gaps --limit ${gaps.length + remaining} to see all`);
  } else if (!showingAll) {
    lines.push('💡 Reply /read <arxiv-id> when you engage with a paper');
  }

  return lines.join('\n').trimEnd();
}
