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
