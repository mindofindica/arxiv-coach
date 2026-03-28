/**
 * Tests for help.ts — /help command
 */

import { describe, it, expect } from 'vitest';
import {
  COMMANDS,
  formatHelpOverview,
  formatCommandDetail,
  findCommand,
  findClosestCommand,
  getHelp,
} from './help.js';

// ── COMMANDS registry ───────────────────────────────────────────────────────

describe('COMMANDS registry', () => {
  it('contains all expected commands', () => {
    const names = COMMANDS.map((c) => c.name);
    // Feedback
    expect(names).toContain('read');
    expect(names).toContain('love');
    expect(names).toContain('save');
    expect(names).toContain('skip');
    expect(names).toContain('meh');
    // Reading list
    expect(names).toContain('reading-list');
    // Info
    expect(names).toContain('status');
    expect(names).toContain('stats');
    expect(names).toContain('streak');
    expect(names).toContain('weekly');
    // Discovery
    expect(names).toContain('hottest');
    expect(names).toContain('search');
    expect(names).toContain('recommend');
    expect(names).toContain('trends');
    expect(names).toContain('gaps');
    expect(names).toContain('digest');
    expect(names).toContain('preview');
    // AI
    expect(names).toContain('ask');
    expect(names).toContain('explain');
    // Meta
    expect(names).toContain('help');
  });

  it('has at least 19 commands', () => {
    expect(COMMANDS.length).toBeGreaterThanOrEqual(19);
  });

  it('every command has required fields', () => {
    for (const cmd of COMMANDS) {
      expect(typeof cmd.name, `name missing on ${JSON.stringify(cmd)}`).toBe('string');
      expect(typeof cmd.summary, `summary missing on /${cmd.name}`).toBe('string');
      expect(typeof cmd.usage, `usage missing on /${cmd.name}`).toBe('string');
      expect(Array.isArray(cmd.examples), `examples missing on /${cmd.name}`).toBe(true);
      expect(cmd.examples.length, `no examples on /${cmd.name}`).toBeGreaterThan(0);
      expect(
        ['feedback', 'reading', 'discovery', 'ai', 'info'].includes(cmd.category),
        `bad category on /${cmd.name}: ${cmd.category}`,
      ).toBe(true);
    }
  });

  it('summaries are concise (≤80 chars each)', () => {
    for (const cmd of COMMANDS) {
      expect(
        cmd.summary.length,
        `summary too long on /${cmd.name}: "${cmd.summary}"`,
      ).toBeLessThanOrEqual(80);
    }
  });

  it('has no duplicate command names', () => {
    const names = COMMANDS.map((c) => c.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});

// ── formatHelpOverview ─────────────────────────────────────────────────────

describe('formatHelpOverview', () => {
  it('returns a string', () => {
    const out = formatHelpOverview();
    expect(typeof out).toBe('string');
  });

  it('contains arxiv-coach header', () => {
    const out = formatHelpOverview();
    expect(out).toContain('arxiv-coach');
  });

  it('contains all category labels', () => {
    const out = formatHelpOverview();
    expect(out).toContain('Paper Feedback');
    expect(out).toContain('Reading List');
    expect(out).toContain('Discovery');
    expect(out).toContain('AI');
    expect(out).toContain('Info');
  });

  it('lists all command names', () => {
    const out = formatHelpOverview();
    for (const cmd of COMMANDS) {
      expect(out).toContain(`/${cmd.name}`);
    }
  });

  it('is within Signal length limit (1800 chars)', () => {
    const out = formatHelpOverview();
    expect(out.length).toBeLessThanOrEqual(1800);
  });

  it('includes tip about /help <command>', () => {
    const out = formatHelpOverview();
    expect(out).toContain('/help <command>');
  });
});

// ── formatCommandDetail ────────────────────────────────────────────────────

describe('formatCommandDetail', () => {
  it('includes the command name', () => {
    const cmd = COMMANDS.find((c) => c.name === 'search')!;
    const out = formatCommandDetail(cmd);
    expect(out).toContain('/search');
  });

  it('includes summary', () => {
    const cmd = COMMANDS.find((c) => c.name === 'search')!;
    const out = formatCommandDetail(cmd);
    expect(out).toContain(cmd.summary);
  });

  it('includes usage', () => {
    const cmd = COMMANDS.find((c) => c.name === 'search')!;
    const out = formatCommandDetail(cmd);
    expect(out).toContain('Usage:');
    expect(out).toContain(cmd.usage);
  });

  it('includes flags when present', () => {
    const cmd = COMMANDS.find((c) => c.name === 'search')!;
    const out = formatCommandDetail(cmd);
    expect(out).toContain('Flags:');
    expect(out).toContain('--limit');
  });

  it('includes examples', () => {
    const cmd = COMMANDS.find((c) => c.name === 'search')!;
    const out = formatCommandDetail(cmd);
    expect(out).toContain('Examples:');
    expect(out).toContain('/search speculative decoding');
  });

  it('omits Flags section when command has no flags', () => {
    const cmd = COMMANDS.find((c) => c.name === 'status')!;
    const out = formatCommandDetail(cmd);
    expect(out).not.toContain('Flags:');
  });

  it('handles /ask detail', () => {
    const cmd = COMMANDS.find((c) => c.name === 'ask')!;
    const out = formatCommandDetail(cmd);
    expect(out).toContain('/ask');
    expect(out).toContain('<arxiv-id>');
    expect(out).toContain('question');
  });

  it('handles /explain detail with levels', () => {
    const cmd = COMMANDS.find((c) => c.name === 'explain')!;
    const out = formatCommandDetail(cmd);
    expect(out).toContain('/explain');
    expect(out).toContain('--level');
    expect(out).toContain('eli12');
    expect(out).toContain('undergrad');
    expect(out).toContain('engineer');
  });
});

// ── findCommand ────────────────────────────────────────────────────────────

describe('findCommand', () => {
  it('finds exact match', () => {
    const cmd = findCommand('search');
    expect(cmd).not.toBeNull();
    expect(cmd!.name).toBe('search');
  });

  it('is case-insensitive', () => {
    expect(findCommand('SEARCH')).not.toBeNull();
    expect(findCommand('Search')).not.toBeNull();
  });

  it('strips leading slash', () => {
    const cmd = findCommand('/search');
    expect(cmd).not.toBeNull();
    expect(cmd!.name).toBe('search');
  });

  it('returns null for unknown command', () => {
    expect(findCommand('zxqflibble')).toBeNull();
  });

  it('finds reading-list with hyphen', () => {
    const cmd = findCommand('reading-list');
    expect(cmd).not.toBeNull();
    expect(cmd!.name).toBe('reading-list');
  });

  it('finds ask', () => {
    expect(findCommand('ask')).not.toBeNull();
  });

  it('finds explain', () => {
    expect(findCommand('explain')).not.toBeNull();
  });

  it('finds streak', () => {
    expect(findCommand('streak')).not.toBeNull();
  });

  it('finds hottest', () => {
    expect(findCommand('hottest')).not.toBeNull();
  });
});

// ── findClosestCommand ─────────────────────────────────────────────────────

describe('findClosestCommand', () => {
  it('finds by prefix match', () => {
    const cmd = findClosestCommand('sea');
    expect(cmd).not.toBeNull();
    expect(cmd!.name).toBe('search');
  });

  it('finds by substring match', () => {
    const cmd = findClosestCommand('earch');
    expect(cmd).not.toBeNull();
  });

  it('strips leading slash before matching', () => {
    const cmd = findClosestCommand('/sea');
    expect(cmd).not.toBeNull();
    expect(cmd!.name).toBe('search');
  });

  it('returns null when no match', () => {
    expect(findClosestCommand('zzzzzzz')).toBeNull();
  });
});

// ── getHelp ────────────────────────────────────────────────────────────────

describe('getHelp', () => {
  it('returns overview when no command specified', () => {
    const result = getHelp({});
    expect(result.ok).toBe(true);
    expect(result.message).toContain('arxiv-coach');
    expect(result.message).toContain('/search');
  });

  it('returns overview when commandName is null', () => {
    const result = getHelp({ commandName: null });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('/read');
  });

  it('returns detail for known command', () => {
    const result = getHelp({ commandName: 'search' });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('/search');
    expect(result.message).toContain('Usage:');
    expect(result.message).toContain('Examples:');
  });

  it('handles leading slash in commandName', () => {
    const result = getHelp({ commandName: '/search' });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('/search');
  });

  it('returns detail for ask', () => {
    const result = getHelp({ commandName: 'ask' });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('/ask');
    expect(result.message).toContain('<arxiv-id>');
  });

  it('returns detail for explain', () => {
    const result = getHelp({ commandName: 'explain' });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('/explain');
    expect(result.message).toContain('--level');
  });

  it('returns detail for streak', () => {
    const result = getHelp({ commandName: 'streak' });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('/streak');
  });

  it('returns closest match with unknown command that has prefix match', () => {
    const result = getHelp({ commandName: 'tren' });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('/trends');
    expect(result.message).toContain('Did you mean');
  });

  it('falls back to overview for completely unknown command', () => {
    const result = getHelp({ commandName: 'xyzflibble' });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Unknown command');
    // Should still contain the full command list
    expect(result.message).toContain('/search');
  });

  it('is case-insensitive for command lookup', () => {
    const lower = getHelp({ commandName: 'search' });
    const upper = getHelp({ commandName: 'SEARCH' });
    expect(lower.message).toBe(upper.message);
  });
});
