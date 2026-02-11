import { describe, expect, it } from 'vitest';
import { buildLessonPrompt, formatLesson } from './lesson.js';

describe('gaps/lesson', () => {
  describe('buildLessonPrompt', () => {
    it('includes concept, paper title, and abstract', () => {
      const prompt = buildLessonPrompt(
        'Tree of Thoughts',
        'Tree of Thoughts: Deliberate Problem Solving with LLMs',
        'We introduce a framework for LLM reasoning...'
      );

      expect(prompt).toContain('Tree of Thoughts');
      expect(prompt).toContain('Tree of Thoughts: Deliberate Problem Solving with LLMs');
      expect(prompt).toContain('We introduce a framework for LLM reasoning...');
    });

    it('includes instructional guidelines', () => {
      const prompt = buildLessonPrompt('RAG', 'RAG Paper', 'Abstract here');

      expect(prompt).toContain('micro-lesson');
      expect(prompt).toContain('3-4 short paragraphs');
      expect(prompt).toContain('conversational');
      expect(prompt).toContain('practical definition');
    });

    it('produces non-empty prompt', () => {
      const prompt = buildLessonPrompt('Concept', 'Title', 'Abstract');
      expect(prompt.length).toBeGreaterThan(100);
    });
  });

  describe('formatLesson', () => {
    it('formats with concept header', () => {
      const formatted = formatLesson('Chain-of-Thought', 'This is the lesson content.');

      expect(formatted).toContain('🎯 **Chain-of-Thought**');
      expect(formatted).toContain('This is the lesson content.');
    });

    it('includes paper reference when provided', () => {
      const formatted = formatLesson(
        'RAG',
        'Lesson content here.',
        'Retrieval-Augmented Generation',
        '2501.12345'
      );

      expect(formatted).toContain('📚 Seen in: Retrieval-Augmented Generation (arXiv:2501.12345)');
    });

    it('includes paper title without arXiv ID', () => {
      const formatted = formatLesson('RAG', 'Lesson content here.', 'Retrieval-Augmented Generation');

      expect(formatted).toContain('📚 Seen in: Retrieval-Augmented Generation');
      expect(formatted).not.toContain('arXiv:');
    });

    it('includes footer with /gaps command', () => {
      const formatted = formatLesson('CoT', 'Content');

      expect(formatted).toContain('💡 Reply "/gaps" to see all tracked concepts');
    });

    it('formats without paper reference when not provided', () => {
      const formatted = formatLesson('CoT', 'Lesson content here.');

      expect(formatted).toContain('🎯 **CoT**');
      expect(formatted).toContain('Lesson content here.');
      expect(formatted).not.toContain('📚 Seen in:');
      expect(formatted).toContain('💡 Reply "/gaps"');
    });

    it('preserves lesson text formatting', () => {
      const lessonText = 'First paragraph.\n\nSecond paragraph with *emphasis*.';
      const formatted = formatLesson('Concept', lessonText);

      expect(formatted).toContain('First paragraph.');
      expect(formatted).toContain('Second paragraph with *emphasis*.');
    });
  });
});
