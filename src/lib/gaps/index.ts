export {
  createGap,
  createLearningSession,
  getByStatus,
  getGap,
  getLearningSession,
  listGaps,
  markUnderstood,
  updateGapStatus,
  type CreateGapInput,
  type KnowledgeGap,
  type LearningSession,
} from './repo.js';

export { gapMatchesPaper, matchGapsToPlaper, type GapMatch, type PaperMatchInput } from './match.js';

export { buildLessonPrompt, formatLesson } from './lesson.js';

export { queryGaps, type GapsQueryOptions, type GapsQueryResult } from './query.js';

export { renderGapsReply } from './render-gaps.js';
