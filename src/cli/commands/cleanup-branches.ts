/**
 * `agent cleanup-branches` コマンドの実装
 *
 * ADR-019: ブランチクリーンアップ機能
 *
 * オーケストレーションで作成されたブランチをクリーンアップする。
 * - デフォルトはdry-runモード（実際の削除には--executeが必要）
 * - 統合ブランチ（integration/*）とタスクブランチを対象
 */

import { Command } from 'commander';
import { createGitEffects } from '../../adapters/vcs/index.ts';
import { repoPath } from '../../types/branded.ts';
import { isErr } from 'option-t/plain_result';
import {
  detectCleanupTargets,
  cleanupBranches,
  formatTargets,
  formatCleanupResult,
  type CleanupOptions,
} from '../../core/orchestrator/branch-cleanup.ts';

/**
 * `agent cleanup-branches` コマンドを作成
 */
export function createCleanupBranchesCommand(): Command {
  const cleanupCommand = new Command('cleanup-branches')
    .description('Clean up orchestration branches (integration/*, task branches)')
    .option('--execute', 'Actually delete branches (default is dry-run)', false)
    .option('--pattern <glob>', 'Additional pattern to match', (val, acc: string[]) => {
      acc.push(val);
      return acc;
    }, [])
    .option('--integration-only', 'Only clean up integration/* branches', false)
    .option('--task-only', 'Only clean up task branches', false)
    .option('--delete-remote', 'Also delete remote branches', false)
    .action(async (options) => {
      try {
        await executeCleanup({
          execute: options.execute,
          integrationOnly: options.integrationOnly,
          taskOnly: options.taskOnly,
          deleteRemote: options.deleteRemote,
          additionalPatterns: options.pattern,
        });
      } catch (error) {
        console.error('Cleanup failed:', error);
        process.exit(1);
      }
    });

  return cleanupCommand;
}

/**
 * クリーンアップの実装
 */
async function executeCleanup(options: CleanupOptions): Promise<void> {
  const gitEffects = createGitEffects();
  const repo = repoPath(process.cwd());

  console.log('\nBranch Cleanup');
  console.log('==============');

  if (!options.execute) {
    console.log('\nDry-run mode: No branches will be deleted.');
    console.log('Use --execute to actually delete branches.\n');
  }

  // 対象ブランチを検出
  console.log('Scanning for cleanup targets...\n');
  const targetsResult = await detectCleanupTargets(gitEffects, repo, options);

  if (isErr(targetsResult)) {
    console.error(`Error: ${targetsResult.err.message}`);
    process.exit(1);
  }

  const targets = targetsResult.val;

  // 対象ブランチを表示
  console.log(formatTargets(targets));

  if (targets.length === 0) {
    return;
  }

  // クリーンアップ実行
  const result = await cleanupBranches(gitEffects, repo, targets, options);

  // 結果を表示
  console.log(formatCleanupResult(result, options.execute));

  if (options.execute) {
    const totalDeleted = result.deletedLocal.length + result.deletedRemote.length;
    if (totalDeleted > 0) {
      console.log(`\nCleanup complete: ${totalDeleted} branch(es) deleted.`);
    }
    if (result.errors.length > 0) {
      console.log(`\nSome branches could not be deleted. Check errors above.`);
      process.exit(1);
    }
  }
}
