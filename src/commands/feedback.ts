/**
 * Feedback Tracking CLI Commands
 * Proof-of-concept implementation for user feedback collection and analysis
 * 
 * Usage:
 *   arxiv-coach feedback read <paper-id>
 *   arxiv-coach feedback skip <paper-id> --reason "too theoretical"
 *   arxiv-coach feedback save <paper-id>
 *   arxiv-coach feedback summary --last 7d
 *   arxiv-coach feedback track-stats
 */

import { Command } from 'commander';
import { getSupabaseClient } from '../lib/supabase.js';
import chalk from 'chalk';

interface PaperFeedback {
  id: string;
  paper_id: string;
  feedback_type: string;
  reason: string | null;
  created_at: string;
}

interface TrackPerformance {
  track_name: string;
  papers_sent: number;
  papers_viewed: number;
  papers_read: number;
  engagement_rate: number;
  quality_score: number;
  recommendation: string;
}

const feedbackCommand = new Command('feedback')
  .description('Track and analyze paper engagement');

/**
 * Mark paper as read
 */
feedbackCommand
  .command('read <paper-id>')
  .description('Mark a paper as read (strong positive signal)')
  .option('-n, --notes <text>', 'Notes about what you learned')
  .action(async (paperId: string, options) => {
    await recordFeedback(paperId, 'read', options.notes, 8);
  });

/**
 * Skip paper (not interested)
 */
feedbackCommand
  .command('skip <paper-id>')
  .description('Mark paper as skipped/not interested')
  .option('-r, --reason <text>', 'Why skipping? (e.g., "too theoretical")')
  .action(async (paperId: string, options) => {
    await recordFeedback(paperId, 'skip', options.reason, -5);
  });

/**
 * Save paper for later
 */
feedbackCommand
  .command('save <paper-id>')
  .description('Save paper to reading list')
  .option('-n, --notes <text>', 'Why saving this paper?')
  .option('-p, --priority <1-10>', 'Priority level (1-10)', '5')
  .action(async (paperId: string, options) => {
    const supabase = getSupabaseClient();
    
    try {
      // Resolve paper ID (might be position or arxiv-id)
      const paper = await resolvePaper(paperId);
      if (!paper) {
        console.error(chalk.red(`Paper not found: ${paperId}`));
        process.exit(1);
      }
      
      // Add to reading list
      const { error } = await supabase
        .rpc('add_to_reading_list', {
          p_paper_id: paper.id,
          p_notes: options.notes || null,
          p_priority: parseInt(options.priority),
        });
      
      if (error) throw error;
      
      // Also record feedback
      await recordFeedback(paper.id, 'save', options.notes, 5, false);
      
      console.log(chalk.green('✓ Saved to reading list!'));
      console.log(chalk.white(`  ${paper.title}`));
      console.log(chalk.gray(`  Priority: ${options.priority}/10`));
      
    } catch (error) {
      console.error(chalk.red('Error saving paper:'), error);
      process.exit(1);
    }
  });

/**
 * Mark paper as loved (exceptional)
 */
feedbackCommand
  .command('love <paper-id>')
  .description('Mark paper as exceptional (strong positive)')
  .option('-n, --notes <text>', 'What made this amazing?')
  .action(async (paperId: string, options) => {
    await recordFeedback(paperId, 'love', options.notes, 10);
  });

/**
 * Mark paper as "meh" (neutral/weak negative)
 */
feedbackCommand
  .command('meh <paper-id>')
  .description('Paper was okay but not particularly useful')
  .action(async (paperId: string, options) => {
    await recordFeedback(paperId, 'meh', null, -2);
  });

/**
 * View engagement summary
 */
feedbackCommand
  .command('summary')
  .description('View engagement summary')
  .option('-l, --last <period>', 'Time period (7d, 30d, 90d)', '7d')
  .action(async (options) => {
    const supabase = getSupabaseClient();
    
    try {
      const days = parseInt(options.last);
      const since = new Date();
      since.setDate(since.getDate() - days);
      
      // Get interaction counts
      const { data: interactions, error: intError } = await supabase
        .from('user_interactions')
        .select('paper_id, signal_strength, interaction_type')
        .gte('created_at', since.toISOString());
      
      if (intError) throw intError;
      
      // Get feedback counts
      const { data: feedbacks, error: fbError } = await supabase
        .from('paper_feedback')
        .select('feedback_type')
        .gte('created_at', since.toISOString());
      
      if (fbError) throw fbError;
      
      // Calculate metrics
      const uniquePapers = new Set(interactions?.map(i => i.paper_id) || []).size;
      const totalInteractions = interactions?.length || 0;
      const avgSignal = interactions?.reduce((sum, i) => sum + (i.signal_strength || 0), 0) / totalInteractions || 0;
      
      const feedbackCounts = (feedbacks || []).reduce((acc, f) => {
        acc[f.feedback_type] = (acc[f.feedback_type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      // Display summary
      console.log(chalk.bold(`\n📊 Engagement Summary (last ${options.last})\n`));
      
      console.log(chalk.white('Overall Activity:'));
      console.log(chalk.gray(`  Papers engaged with: ${uniquePapers}`));
      console.log(chalk.gray(`  Total interactions: ${totalInteractions}`));
      console.log(chalk.gray(`  Average signal: ${avgSignal.toFixed(1)}/10`));
      console.log();
      
      console.log(chalk.white('Explicit Feedback:'));
      if (Object.keys(feedbackCounts).length > 0) {
        Object.entries(feedbackCounts).forEach(([type, count]) => {
          const icon = 
            type === 'love' ? '❤️' :
            type === 'read' ? '✅' :
            type === 'save' ? '⭐' :
            type === 'skip' ? '⏭️' :
            type === 'meh' ? '😐' : '📝';
          console.log(chalk.gray(`  ${icon} ${type}: ${count}`));
        });
      } else {
        console.log(chalk.yellow('  No explicit feedback yet. Try /feedback read|skip|save <paper-id>'));
      }
      console.log();
      
      // Top interests (from positive signals)
      const positiveInteractions = interactions?.filter(i => (i.signal_strength || 0) > 5) || [];
      if (positiveInteractions.length > 0) {
        console.log(chalk.white('High Interest Areas:'));
        console.log(chalk.gray('  (Based on papers you engaged deeply with)'));
        // In real implementation, would extract topics from those papers
        console.log(chalk.gray('  See track-stats for detailed breakdown'));
      }
      
    } catch (error) {
      console.error(chalk.red('Error generating summary:'), error);
      process.exit(1);
    }
  });

/**
 * View track performance statistics
 */
feedbackCommand
  .command('track-stats')
  .description('View engagement by track')
  .option('-l, --last <days>', 'Days to analyze', '30')
  .action(async (options) => {
    const supabase = getSupabaseClient();
    
    try {
      // Query v_track_engagement view
      const { data: trackStats, error } = await supabase
        .from('v_track_engagement')
        .select('*');
      
      if (error) throw error;
      
      if (!trackStats || trackStats.length === 0) {
        console.log(chalk.yellow('No track data yet. Papers need to be sent first.'));
        return;
      }
      
      console.log(chalk.bold(`\n📈 Track Performance (last ${options.last} days)\n`));
      
      trackStats.forEach((track: any) => {
        const engagementPct = track.engagement_rate_pct || 0;
        const color = 
          engagementPct >= 70 ? chalk.green :
          engagementPct >= 40 ? chalk.yellow :
          chalk.red;
        
        console.log(chalk.white.bold(track.track_name));
        console.log(chalk.gray(`  Papers sent: ${track.papers_sent}`));
        console.log(chalk.gray(`  Papers engaged: ${track.papers_engaged}`));
        console.log(color(`  Engagement rate: ${engagementPct}%`));
        
        // Recommendations
        if (engagementPct >= 70) {
          console.log(chalk.green('  ✅ High value track - consider boosting'));
        } else if (engagementPct < 25) {
          console.log(chalk.red('  ⚠️  Low engagement - consider removing'));
        } else if (engagementPct < 40) {
          console.log(chalk.yellow('  ⚡ Needs tuning or reduced frequency'));
        }
        console.log();
      });
      
    } catch (error) {
      console.error(chalk.red('Error fetching track stats:'), error);
      process.exit(1);
    }
  });

/**
 * Manage reading list
 */
const readingListCmd = feedbackCommand
  .command('reading-list')
  .description('Manage saved papers');

readingListCmd
  .command('show')
  .description('Show reading list')
  .option('-s, --status <status>', 'Filter by status (unread, in_progress, read)')
  .option('-l, --limit <number>', 'Max results', '20')
  .action(async (options) => {
    const supabase = getSupabaseClient();
    
    try {
      let query = supabase
        .from('reading_list')
        .select(`
          id,
          status,
          priority,
          notes,
          created_at,
          papers (
            id,
            arxiv_id,
            title,
            published_date
          )
        `)
        .order('priority', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(parseInt(options.limit));
      
      if (options.status) {
        query = query.eq('status', options.status);
      } else {
        // Default: show unread and in_progress
        query = query.in('status', ['unread', 'in_progress']);
      }
      
      const { data: items, error } = await query;
      
      if (error) throw error;
      
      if (!items || items.length === 0) {
        console.log(chalk.yellow('Reading list is empty. Save papers with /feedback save <paper-id>'));
        return;
      }
      
      console.log(chalk.bold(`\n📚 Reading List (${items.length})\n`));
      
      items.forEach((item: any, idx: number) => {
        const paper = item.papers;
        const statusIcon = 
          item.status === 'read' ? '✅' :
          item.status === 'in_progress' ? '📖' :
          '📄';
        
        console.log(chalk.gray(`${idx + 1}.`) + ' ' + statusIcon + ' ' + chalk.white.bold(paper.title));
        console.log(chalk.gray(`   ArXiv: ${paper.arxiv_id} | Priority: ${item.priority}/10`));
        
        if (item.notes) {
          console.log(chalk.gray(`   Notes: ${item.notes}`));
        }
        
        console.log(chalk.gray(`   Saved: ${new Date(item.created_at).toLocaleDateString()}`));
        console.log(chalk.gray(`   ID: ${paper.id}`));
        console.log();
      });
      
    } catch (error) {
      console.error(chalk.red('Error fetching reading list:'), error);
      process.exit(1);
    }
  });

readingListCmd
  .command('done <paper-id>')
  .description('Mark reading list item as read')
  .action(async (paperId: string) => {
    const supabase = getSupabaseClient();
    
    try {
      const paper = await resolvePaper(paperId);
      if (!paper) {
        console.error(chalk.red(`Paper not found: ${paperId}`));
        process.exit(1);
      }
      
      const { error } = await supabase
        .from('reading_list')
        .update({
          status: 'read',
          read_at: new Date().toISOString(),
        })
        .eq('paper_id', paper.id);
      
      if (error) throw error;
      
      console.log(chalk.green('✅ Marked as read!'));
      console.log(chalk.gray(`  ${paper.title}`));
      
    } catch (error) {
      console.error(chalk.red('Error updating reading list:'), error);
      process.exit(1);
    }
  });

/**
 * Helper: Record feedback
 */
async function recordFeedback(
  paperId: string,
  feedbackType: string,
  reason: string | null,
  signalStrength: number,
  showOutput: boolean = true
): Promise<void> {
  const supabase = getSupabaseClient();
  
  try {
    // Resolve paper (might be position like "3" or arxiv-id)
    const paper = await resolvePaper(paperId);
    if (!paper) {
      console.error(chalk.red(`Paper not found: ${paperId}`));
      process.exit(1);
    }
    
    // Insert feedback
    const { error: fbError } = await supabase
      .from('paper_feedback')
      .insert({
        paper_id: paper.id,
        feedback_type: feedbackType,
        reason,
      })
      .select()
      .single();
    
    if (fbError) {
      // Handle unique constraint violation (already gave this feedback)
      if (fbError.code === '23505') {
        console.log(chalk.yellow(`Already marked as ${feedbackType}`));
        return;
      }
      throw fbError;
    }
    
    // Log interaction (this happens via trigger, but we can log explicitly too)
    await supabase.rpc('log_interaction', {
      p_paper_id: paper.id,
      p_interaction_type: 'feedback_given',
      p_command: feedbackType,
      p_signal_strength: signalStrength,
    });
    
    if (showOutput) {
      const icon = 
        feedbackType === 'love' ? '❤️' :
        feedbackType === 'read' ? '✅' :
        feedbackType === 'save' ? '⭐' :
        feedbackType === 'skip' ? '⏭️' :
        feedbackType === 'meh' ? '😐' : '📝';
      
      console.log(chalk.green(`${icon} Feedback recorded: ${feedbackType}`));
      console.log(chalk.white(`  ${paper.title}`));
      if (reason) {
        console.log(chalk.gray(`  Reason: ${reason}`));
      }
      
      // Contextual tip
      if (feedbackType === 'skip' || feedbackType === 'meh') {
        console.log(chalk.blue('  💡 System will deprioritize similar papers in future'));
      } else if (feedbackType === 'read' || feedbackType === 'love') {
        console.log(chalk.blue('  💡 System will boost similar papers in future'));
      }
    }
    
  } catch (error) {
    console.error(chalk.red(`Error recording feedback:`), error);
    process.exit(1);
  }
}

/**
 * Helper: Resolve paper by ID, arxiv-id, or position
 */
async function resolvePaper(identifier: string): Promise<any> {
  const supabase = getSupabaseClient();
  
  // Try as UUID first
  if (identifier.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
    const { data } = await supabase
      .from('papers')
      .select('id, title, arxiv_id')
      .eq('id', identifier)
      .single();
    return data;
  }
  
  // Try as arXiv ID
  if (identifier.match(/^\d{4}\.\d{4,5}(v\d+)?$/)) {
    const { data } = await supabase
      .from('papers')
      .select('id, title, arxiv_id')
      .eq('arxiv_id', identifier)
      .single();
    return data;
  }
  
  // Try as position (e.g., "3" = third paper in recent digest)
  const position = parseInt(identifier);
  if (!isNaN(position) && position > 0) {
    // Get recent papers from last digest
    const { data: papers } = await supabase
      .from('papers')
      .select('id, title, arxiv_id')
      .order('created_at', { ascending: false })
      .limit(10);
    
    if (papers && papers[position - 1]) {
      return papers[position - 1];
    }
  }
  
  return null;
}

export default feedbackCommand;
