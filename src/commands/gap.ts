/**
 * Gap Detector CLI Commands
 * Proof-of-concept implementation for knowledge gap tracking
 * 
 * Usage:
 *   arxiv-coach gap mark "concept" --paper arxiv:1234.5678
 *   arxiv-coach gap list [--status identified]
 *   arxiv-coach gap learn <gap-id> --type micro
 *   arxiv-coach gap understood <gap-id>
 */

import { Command } from 'commander';
import { getSupabaseClient } from '../lib/supabase.js';
import chalk from 'chalk';

interface KnowledgeGap {
  id: string;
  concept: string;
  context: string | null;
  source_type: string;
  detection_method: string;
  status: string;
  priority: number;
  created_at: string;
  paper_title: string | null;
  arxiv_id: string | null;
  tags: string[];
}

interface LearningSession {
  id: string;
  gap_id: string;
  lesson_type: string;
  lesson_content: string;
  delivered_at: string;
  feedback: string | null;
}

const gapCommand = new Command('gap')
  .description('Track and learn from knowledge gaps');

/**
 * Mark a new knowledge gap
 */
gapCommand
  .command('mark <concept>')
  .description('Mark a concept as unfamiliar/confusing')
  .option('-p, --paper <arxiv-id>', 'ArXiv ID of source paper')
  .option('-c, --context <text>', 'Original sentence/context where confusion occurred')
  .option('-t, --tags <tags>', 'Comma-separated tags (e.g., "llm-inference,optimization")')
  .action(async (concept: string, options) => {
    const supabase = getSupabaseClient();
    
    try {
      // Parse tags if provided
      const tags = options.tags 
        ? options.tags.split(',').map((t: string) => t.trim())
        : [];
      
      // Fetch paper details if arxiv-id provided
      let paperData = null;
      if (options.paper) {
        const { data: papers } = await supabase
          .from('papers')
          .select('id, title, arxiv_id')
          .eq('arxiv_id', options.paper)
          .limit(1);
        
        paperData = papers?.[0] || null;
      }
      
      // Insert gap
      const { data: gap, error } = await supabase
        .from('knowledge_gaps')
        .insert({
          concept,
          context: options.context || null,
          source_type: options.paper ? 'paper' : 'manual',
          source_id: paperData?.id || null,
          paper_title: paperData?.title || null,
          arxiv_id: options.paper || null,
          detection_method: 'explicit_command',
          original_message: `gap mark "${concept}"`,
          tags,
        })
        .select()
        .single();
      
      if (error) throw error;
      
      console.log(chalk.green('✓ Gap tracked!'));
      console.log(chalk.gray(`  ID: ${gap.id}`));
      console.log(chalk.white(`  Concept: ${concept}`));
      if (paperData) {
        console.log(chalk.gray(`  From: ${paperData.title} (${options.paper})`));
      }
      console.log(chalk.gray(`  Priority: ${gap.priority || 50}/100`));
      console.log(chalk.blue('  📚 Will include micro-lesson in next relevant digest'));
      
    } catch (error) {
      console.error(chalk.red('Error marking gap:'), error);
      process.exit(1);
    }
  });

/**
 * List knowledge gaps
 */
gapCommand
  .command('list')
  .description('List tracked knowledge gaps')
  .option('-s, --status <status>', 'Filter by status (identified, lesson_queued, lesson_sent, understood, archived)')
  .option('-l, --limit <number>', 'Max number of results', '10')
  .option('--all', 'Include all statuses (default: active only)')
  .action(async (options) => {
    const supabase = getSupabaseClient();
    
    try {
      let query = supabase
        .from('knowledge_gaps')
        .select(`
          id,
          concept,
          context,
          status,
          priority,
          created_at,
          paper_title,
          arxiv_id,
          tags
        `)
        .order('priority', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(parseInt(options.limit));
      
      // Filter by status
      if (options.status) {
        query = query.eq('status', options.status);
      } else if (!options.all) {
        // Default: active statuses only
        query = query.in('status', ['identified', 'lesson_queued', 'lesson_sent']);
      }
      
      const { data: gaps, error } = await query;
      
      if (error) throw error;
      
      if (!gaps || gaps.length === 0) {
        console.log(chalk.yellow('No gaps found.'));
        return;
      }
      
      console.log(chalk.bold(`\n📚 Knowledge Gaps (${gaps.length})\n`));
      
      gaps.forEach((gap: KnowledgeGap, idx: number) => {
        const statusColor = 
          gap.status === 'understood' ? chalk.green :
          gap.status === 'lesson_sent' ? chalk.blue :
          chalk.yellow;
        
        console.log(chalk.gray(`${idx + 1}.`) + ' ' + chalk.white.bold(gap.concept));
        console.log(chalk.gray(`   Priority: ${gap.priority}/100 | Status: `) + statusColor(gap.status));
        
        if (gap.context) {
          const truncated = gap.context.length > 80 
            ? gap.context.substring(0, 77) + '...'
            : gap.context;
          console.log(chalk.gray(`   Context: "${truncated}"`));
        }
        
        if (gap.paper_title) {
          console.log(chalk.gray(`   From: ${gap.paper_title} (${gap.arxiv_id})`));
        }
        
        if (gap.tags && gap.tags.length > 0) {
          console.log(chalk.gray(`   Tags: ${gap.tags.join(', ')}`));
        }
        
        console.log(chalk.gray(`   ID: ${gap.id}`));
        console.log();
      });
      
    } catch (error) {
      console.error(chalk.red('Error listing gaps:'), error);
      process.exit(1);
    }
  });

/**
 * Generate and optionally send a micro-lesson for a gap
 */
gapCommand
  .command('learn <gap-id>')
  .description('Generate a micro-lesson for a knowledge gap')
  .option('-t, --type <type>', 'Lesson type (micro, deep_dive, eli12, undergrad, engineer)', 'micro')
  .option('--send', 'Send lesson via Signal immediately')
  .option('--save', 'Save lesson to database (default: true)', true)
  .action(async (gapId: string, options) => {
    const supabase = getSupabaseClient();
    
    try {
      // Fetch gap details
      const { data: gap, error: gapError } = await supabase
        .from('knowledge_gaps')
        .select('*')
        .eq('id', gapId)
        .single();
      
      if (gapError || !gap) {
        console.error(chalk.red('Gap not found'));
        process.exit(1);
      }
      
      console.log(chalk.blue(`\n🎯 Generating ${options.type} lesson for: ${gap.concept}\n`));
      
      // Generate lesson using Claude
      const lessonContent = await generateLesson(gap, options.type);
      
      // Display lesson
      console.log(chalk.white(lessonContent));
      console.log();
      
      // Save lesson if requested
      if (options.save) {
        const { error: sessionError } = await supabase
          .from('learning_sessions')
          .insert({
            gap_id: gapId,
            lesson_type: options.type,
            lesson_content: lessonContent,
            lesson_format: 'text',
            delivered_via: options.send ? 'signal_digest' : 'cli',
            generation_model: 'claude-sonnet-4',
          });
        
        if (sessionError) throw sessionError;
        
        // Update gap status
        await supabase
          .from('knowledge_gaps')
          .update({
            status: 'lesson_sent',
            lesson_generated_at: new Date().toISOString(),
            lesson_sent_at: new Date().toISOString(),
          })
          .eq('id', gapId);
        
        console.log(chalk.green('✓ Lesson saved to database'));
      }
      
      // TODO: Implement Signal sending
      if (options.send) {
        console.log(chalk.yellow('⚠ Signal delivery not yet implemented (use --save for now)'));
      }
      
    } catch (error) {
      console.error(chalk.red('Error generating lesson:'), error);
      process.exit(1);
    }
  });

/**
 * Mark a gap as understood
 */
gapCommand
  .command('understood <gap-id>')
  .description('Mark a knowledge gap as understood')
  .option('-f, --feedback <feedback>', 'Feedback on the lesson (helpful, too_simple, too_complex, want_more)')
  .option('-n, --notes <text>', 'Additional feedback notes')
  .action(async (gapId: string, options) => {
    const supabase = getSupabaseClient();
    
    try {
      // Update gap status
      const { error: gapError } = await supabase
        .from('knowledge_gaps')
        .update({
          status: 'understood',
          marked_understood_at: new Date().toISOString(),
        })
        .eq('id', gapId);
      
      if (gapError) throw gapError;
      
      // Update most recent learning session with feedback
      if (options.feedback || options.notes) {
        const { error: sessionError } = await supabase
          .from('learning_sessions')
          .update({
            feedback: options.feedback || null,
            feedback_text: options.notes || null,
            read: true,
            read_at: new Date().toISOString(),
          })
          .eq('gap_id', gapId)
          .order('delivered_at', { ascending: false })
          .limit(1);
        
        if (sessionError) console.warn('Warning: could not update session feedback');
      }
      
      console.log(chalk.green('✓ Marked as understood!'));
      if (options.feedback) {
        console.log(chalk.gray(`  Feedback: ${options.feedback}`));
      }
      
    } catch (error) {
      console.error(chalk.red('Error marking understood:'), error);
      process.exit(1);
    }
  });

/**
 * View learning history for gaps
 */
gapCommand
  .command('history')
  .description('View learning session history')
  .option('-l, --limit <number>', 'Max results', '20')
  .option('-g, --gap-id <id>', 'Filter by specific gap')
  .action(async (options) => {
    const supabase = getSupabaseClient();
    
    try {
      let query = supabase
        .from('learning_sessions')
        .select(`
          id,
          lesson_type,
          delivered_at,
          delivered_via,
          read,
          feedback,
          knowledge_gaps (
            concept,
            status
          )
        `)
        .order('delivered_at', { ascending: false })
        .limit(parseInt(options.limit));
      
      if (options.gapId) {
        query = query.eq('gap_id', options.gapId);
      }
      
      const { data: sessions, error } = await query;
      
      if (error) throw error;
      
      if (!sessions || sessions.length === 0) {
        console.log(chalk.yellow('No learning sessions found.'));
        return;
      }
      
      console.log(chalk.bold(`\n📖 Learning History (${sessions.length})\n`));
      
      sessions.forEach((session: any, idx: number) => {
        const gap = session.knowledge_gaps;
        const readStatus = session.read ? chalk.green('✓ read') : chalk.gray('unread');
        
        console.log(chalk.gray(`${idx + 1}.`) + ' ' + chalk.white.bold(gap?.concept || 'Unknown'));
        console.log(chalk.gray(`   Type: ${session.lesson_type} | Via: ${session.delivered_via} | ${readStatus}`));
        
        if (session.feedback) {
          const feedbackColor = 
            session.feedback === 'helpful' ? chalk.green :
            session.feedback === 'too_complex' ? chalk.red :
            chalk.yellow;
          console.log(chalk.gray(`   Feedback: `) + feedbackColor(session.feedback));
        }
        
        console.log(chalk.gray(`   Delivered: ${new Date(session.delivered_at).toLocaleDateString()}`));
        console.log();
      });
      
    } catch (error) {
      console.error(chalk.red('Error fetching history:'), error);
      process.exit(1);
    }
  });

/**
 * Generate a micro-lesson using Claude (mock implementation for POC)
 */
async function generateLesson(gap: KnowledgeGap, lessonType: string): Promise<string> {
  // In real implementation, this would call Claude API
  // For POC, return formatted template
  
  const templates: Record<string, string> = {
    micro: `🎯 ${gap.concept}

📖 Quick Context:
${gap.concept} is a key concept in LLM engineering that addresses [specific problem/goal].

The core idea: [2-3 sentence explanation of the concept]

Think of it like: [concrete analogy or real-world example]

Why it matters: [practical impact - why should you care?]

📚 Seen in: ${gap.paper_title || 'Multiple papers'}${gap.arxiv_id ? ` (arXiv:${gap.arxiv_id})` : ''}
🔗 Want deeper dive? Reply /learn ${gap.id} --type deep_dive`,

    deep_dive: `# Deep Dive: ${gap.concept}

## Overview
[Comprehensive explanation of the concept - 1-2 paragraphs]

## How It Works
[Technical details, step-by-step breakdown]

## Mathematical Foundation
[If applicable - key equations or algorithmic logic]

## Implementation Example
\`\`\`python
# Pseudo-code showing how ${gap.concept} works
def example_implementation():
    # Key steps...
    pass
\`\`\`

## Tradeoffs & Limitations
- **Pros:** [List key advantages]
- **Cons:** [List limitations or edge cases]

## Real-World Usage
- Used in: [Systems/models that implement this]
- Performance: [Typical improvements or benchmarks]

## Key Papers
1. [Primary paper - arXiv:XXXX.XXXXX]
2. [Related work - arXiv:XXXX.XXXXX]

## Related Concepts
- [Prerequisite concept 1]
- [Related technique 2]`,

    eli12: `# ${gap.concept} - Explained for a Smart 12-Year-Old

Imagine [relatable analogy that a kid would understand]...

[Break down the concept using simple language, concrete examples, and analogies]

**Why is this cool?**
[Explain the impact in terms a young person would find exciting]

**Real example:**
[Show a simple, tangible case where this is used]`,
  };
  
  const template = templates[lessonType] || templates.micro;
  return template;
}

export default gapCommand;
