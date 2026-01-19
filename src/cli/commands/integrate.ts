import { Command } from 'commander';
import { createFileStore } from '../../core/task-store/file-store.ts';
import { createGitEffects } from '../../adapters/vcs/index.ts';
import { TaskState } from '../../types/task.ts';
import { isErr } from 'option-t/plain_result';
import { loadConfig } from '../utils/load-config.ts';
import { repoPath, taskId, branchName } from '../../types/branded.ts';

/**
 * `agent integrate` コマンドの実装
 *
 * 完了済みタスクのブランチを、現在の worktree のブランチへマージする。
 * main worktree を変更しないため、実行する場所はユーザーが明示的に選ぶ。
 */
export function createIntegrateCommand(): Command {
  const integrateCommand = new Command('integrate')
    .description('Merge completed task branches into the current worktree branch')
    .option('--config <path>', 'Path to configuration file')
    .option('--base <branch>', 'Expected base branch (must match current branch)')
    .option('--tasks <taskIds...>', 'Completed task IDs to integrate (default: all DONE tasks)')
    .action(async (options) => {
      try {
        await showIntegrationCommands({
          configPath: options.config,
          baseBranch: options.base,
          taskIds: options.tasks,
        });
      } catch (error) {
        console.error('Integration command failed:', error);
        process.exit(1);
      }
    });

  return integrateCommand;
}

/**
 * integrate コマンドの実装
 */
async function showIntegrationCommands(params: {
  configPath?: string;
  baseBranch?: string;
  taskIds?: string[];
}): Promise<void> {
  const { configPath, baseBranch, taskIds } = params;

  // 設定ファイルを読み込み
  const config = await loadConfig(configPath);

  // TaskStoreを初期化
  const taskStore = createFileStore({
    basePath: config.agentCoordPath,
  });

  // GitEffectsを初期化
  const gitEffects = createGitEffects();

  // タスク一覧を取得
  const tasksResult = await taskStore.listTasks();
  if (isErr(tasksResult)) {
    console.error(`❌ Failed to list tasks: ${tasksResult.err.message}`);
    process.exit(1);
  }

  const allTasks = tasksResult.val;
  const requestedTaskIds = taskIds?.map((id) => taskId(id)) ?? null;

  const selectedTasks = allTasks.filter((task) => {
    if (task.state !== TaskState.DONE) {
      return false;
    }
    if (requestedTaskIds) {
      return requestedTaskIds.some((id) => id === task.id);
    }
    return true;
  });

  if (selectedTasks.length === 0) {
    console.log('No completed tasks found for integration.');
    if (requestedTaskIds) {
      console.log('Ensure task IDs are correct and in DONE state.');
    }
    console.log(`\nRun "agent status" to see current task states.\n`);
    return;
  }

  // 現在の worktree を対象にマージする
  const repo = repoPath(process.cwd());
  const currentBranchResult = await gitEffects.getCurrentBranch(repo);
  if (isErr(currentBranchResult)) {
    console.error(`❌ Failed to detect current branch: ${currentBranchResult.err.message}`);
    process.exit(1);
  }
  const currentBranch = currentBranchResult.val;

  if (baseBranch && branchName(baseBranch) !== currentBranch) {
    console.error(`❌ Current branch is ${currentBranch}, but --base expects ${baseBranch}.`);
    process.exit(1);
  }

  const uniqueBranches = Array.from(new Set(selectedTasks.map((task) => task.branch)));

  console.log('\n🔗 Integration (execute)');
  console.log(`Base branch (current worktree): ${currentBranch}`);
  console.log(`Tasks to merge: ${uniqueBranches.length} branches`);

  const mergedTaskIds: string[] = [];

  for (const task of selectedTasks) {
    const mergeResult = await gitEffects.merge(repo, task.branch);
    if (isErr(mergeResult)) {
      console.error(`❌ Failed to merge ${task.branch}: ${mergeResult.err.message}`);
      process.exit(1);
    }

    if (mergeResult.val.hasConflicts) {
      console.error(`❌ Merge conflicts detected while merging ${task.branch}`);
      if (mergeResult.val.conflicts && mergeResult.val.conflicts.length > 0) {
        console.error('Conflicts:');
        for (const conflict of mergeResult.val.conflicts) {
          console.error(`- ${conflict.filePath}`);
        }
      }
      const abortResult = await gitEffects.abortMerge(repo);
      if (isErr(abortResult)) {
        console.warn(`⚠️  Failed to abort merge: ${abortResult.err.message}`);
      }
      process.exit(1);
    }

    mergedTaskIds.push(String(task.id));
    console.log(`✅ Merged ${task.branch}`);
  }

  console.log('\n✅ Integration complete');
  console.log(`Merged into: ${currentBranch}`);
  console.log(`Tasks merged: ${mergedTaskIds.length}`);

  if (requestedTaskIds) {
    console.log('\nIncluded tasks:');
    for (const task of selectedTasks) {
      console.log(`- ${task.id} (${task.branch})`);
    }
  }
}
