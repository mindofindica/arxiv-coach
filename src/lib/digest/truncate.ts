import { MAX_SIGNAL_CHARS } from './limits.js';

export function truncateForSignal(text: string, maxChars = MAX_SIGNAL_CHARS): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };

  // If maxChars is extremely small, we can't fit the note. In that case, hard truncate.
  const note = "\n\n(Truncated — full digest is saved on the server. Ask me: 'send me today's full digest'.)";
  if (maxChars <= note.length + 5) {
    return { text: text.slice(0, maxChars).replace(/\s+$/g, ''), truncated: true };
  }

  // Keep room for note
  const budget = Math.max(0, maxChars - note.length);
  const trimmed = text.slice(0, budget).replace(/\s+$/g, '');
  return { text: (trimmed + note).slice(0, maxChars), truncated: true };
}
