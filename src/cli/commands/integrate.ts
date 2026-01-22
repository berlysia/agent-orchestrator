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

  // 統合ブランチを作成
  const timestamp = Date.now();
  const integrationBranch = branchName(`integration/merge-${timestamp}`);

  const createBranchResult = await gitEffects.createBranch(repo, integrationBranch, currentBranch);
  if (isErr(createBranchResult)) {
    console.error(`❌ Failed to create integration branch: ${createBranchResult.err.message}`);
    process.exit(1);
  }

  // 統合ブランチに切り替え
  const switchResult = await gitEffects.switchBranch(repo, integrationBranch);
  if (isErr(switchResult)) {
    console.error(`❌ Failed to switch to integration branch: ${switchResult.err.message}`);
    process.exit(1);
  }

  const mergedTaskIds: string[] = [];

  // 統合ブランチに各タスクをマージ
  // WHY: integrationSignature=false の場合、GPG署名を無効化してマージコミットを作成
  const mergeOptions: string[] = config.commit.integrationSignature ? [] : ['--no-gpg-sign'];
  for (const task of selectedTasks) {
    const mergeResult = await gitEffects.merge(repo, task.branch, mergeOptions);
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

  // 署名設定に基づいて後続の処理を分岐
  // WHY: GPG署名にはユーザー認証（pinentry等）が必要で、タイムアウトする可能性がある
  //      そのため、署名が必要な場合はコマンドを出力して手動実行を促す
  const gpgSign = config.commit.integrationSignature;

  if (gpgSign) {
    // 署名が必要な場合はfinalizeコマンドを出力
    console.log('\n📦 Integration branch ready:');
    console.log(`   Branch: ${integrationBranch}`);
    console.log(`   Base: ${currentBranch}`);

    console.log('\n🔏 To finalize (rebase, sign, and merge):');
    console.log(`\n   agent finalize --base ${currentBranch} --branch ${integrationBranch}\n`);

    console.log('📝 To merge without signing:');
    console.log(`\n   git checkout ${currentBranch} && git merge ${integrationBranch}\n`);

    console.log('🗑️  To delete the integration branch after merging:');
    console.log(`\n   git branch -d ${integrationBranch}\n`);
  } else {
    // 署名不要の場合は自動でrebase & merge
    console.log('\n🔄 Rebasing integration branch...');
    const rebaseResult = await gitEffects.rebase(repo, currentBranch, { gpgSign: false });
    if (isErr(rebaseResult)) {
      console.error(`❌ Failed to rebase integration branch: ${rebaseResult.err.message}`);
      process.exit(1);
    }

    // ベースブランチに切り替え
    const switchBackResult = await gitEffects.switchBranch(repo, currentBranch);
    if (isErr(switchBackResult)) {
      console.error(`❌ Failed to switch back to base branch: ${switchBackResult.err.message}`);
      process.exit(1);
    }

    // Fast-forward merge
    console.log('\n🔀 Merging integration branch...');
    const finalMergeResult = await gitEffects.merge(repo, integrationBranch, ['--ff-only']);
    if (isErr(finalMergeResult)) {
      console.error(`❌ Failed to merge integration branch: ${finalMergeResult.err.message}`);
      process.exit(1);
    }

    if (!finalMergeResult.val.success) {
      console.error('❌ Fast-forward merge failed');
      process.exit(1);
    }

    // 統合ブランチを削除
    const deleteBranchResult = await gitEffects.deleteBranch(repo, integrationBranch);
    if (isErr(deleteBranchResult)) {
      console.warn(`⚠️  Failed to delete integration branch: ${deleteBranchResult.err.message}`);
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
}
