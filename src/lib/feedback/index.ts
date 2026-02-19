/**
 * arxiv-coach Signal feedback module
 *
 * Public API for parsing and recording user feedback from Signal messages.
 */

export type { FeedbackType, ParsedFeedback, ParseResult, ParseResultOk, ParseResultError } from './parser.js';
export { parseFeedbackMessage, extractArxivId } from './parser.js';

export type { RecordOptions, RecordResult, PaperInfo } from './recorder.js';
export { recordFeedback, formatConfirmation, SIGNAL_STRENGTHS, FEEDBACK_ICONS } from './recorder.js';

export type { HandlerOptions, HandleResult } from './handler.js';
export { createFeedbackHandler } from './handler.js';

export { ensureFeedbackTables } from './migrate.js';
