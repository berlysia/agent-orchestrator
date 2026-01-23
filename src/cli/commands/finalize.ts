import { Command } from 'commander';
import { createGitEffects, type GitEffects } from '../../adapters/vcs/index.ts';
import { repoPath, branchName, type RepoPath, type BranchName } from '../../types/branded.ts';
import { isErr, isOk } from 'option-t/plain_result';

/**
 * `agent finalize` コマンドの実装
 *
 * WHY: GPG署名には認証（pinentry等）が必要で、長時間のオーケストレーション後に
 * ユーザーが席を離れていると認証タイムアウトで失敗する問題がある。
 * このコマンドは統合ブランチを署名付きリベースしてベースブランチにマージする。
 */
export function createFinalizeCommand(): Command {
  const finalizeCommand = new Command('finalize')
    .description('Finalize integration branch: rebase with GPG signing and merge into base')
    .option('--base <branch>', 'Base branch to rebase onto (default: auto-detect main/master)')
    .option('--branch <branch>', 'Branch to finalize (default: current branch)')
    .option('--no-merge', 'Skip merging into base branch after rebase')
    .option('--dry-run', 'Show what would be done without executing', false)
    .action(async (options) => {
      try {
        await executeFinalize({
          baseBranch: options.base,
          targetBranch: options.branch,
          merge: options.merge,
          dryRun: options.dryRun,
        });
      } catch (error) {
        console.error('Finalize failed:', error);
        process.exit(1);
      }
    });

  return finalizeCommand;
}

/**
 * finalize の実装
 */
async function executeFinalize(params: {
  baseBranch?: string;
  targetBranch?: string;
  merge: boolean;
  dryRun: boolean;
}): Promise<void> {
  const { baseBranch: baseBranchArg, targetBranch: targetBranchArg, merge, dryRun } = params;

  const gitEffects = createGitEffects();
  const repo = repoPath(process.cwd());

  // 現在のブランチを取得
  const currentBranchResult = await gitEffects.getCurrentBranch(repo);
  if (isErr(currentBranchResult)) {
    console.error(`❌ Failed to get current branch: ${currentBranchResult.err.message}`);
    process.exit(1);
  }
  const currentBranch = currentBranchResult.val;

  // ターゲットブランチを決定
  const targetBranch = targetBranchArg ? branchName(targetBranchArg) : currentBranch;

  // ベースブランチを決定
  let baseBranch = baseBranchArg ? branchName(baseBranchArg) : null;

  if (!baseBranch) {
    // 自動検出: main, master の順で存在確認
    const branchesResult = await gitEffects.listBranches(repo);
    if (isErr(branchesResult)) {
      console.error(`❌ Failed to list branches: ${branchesResult.err.message}`);
      process.exit(1);
    }

    const branches = branchesResult.val;
    const branchNames = branches.map((b) => String(b.name));

    if (branchNames.includes('main')) {
      baseBranch = branchName('main');
    } else if (branchNames.includes('master')) {
      baseBranch = branchName('master');
    } else {
      console.error('❌ Could not auto-detect base branch (main or master not found)');
      console.error('   Please specify --base <branch> explicitly');
      process.exit(1);
    }
  }

  console.log('\n🔏 Rebase with GPG signing');
  console.log(`   Target branch: ${targetBranch}`);
  console.log(`   Base branch: ${baseBranch}`);

  if (dryRun) {
    console.log('\n📋 Dry-run mode: Commands that would be executed:');
    if (String(targetBranch) !== String(currentBranch)) {
      console.log(`   git checkout ${targetBranch}`);
    }
    console.log(`   git rebase --gpg-sign ${baseBranch}`);
    if (merge) {
      console.log(`   git checkout ${baseBranch}`);
      console.log(`   git merge --ff-only ${targetBranch}`);
    }
    console.log('\n💡 Remove --dry-run to execute these commands.');
    return;
  }

  // ターゲットブランチに切り替え（必要な場合）
  if (String(targetBranch) !== String(currentBranch)) {
    console.log(`\n📦 Switching to branch: ${targetBranch}`);
    const switchResult = await gitEffects.switchBranch(repo, targetBranch);
    if (isErr(switchResult)) {
      console.error(`❌ Failed to switch branch: ${switchResult.err.message}`);
      process.exit(1);
    }
  }

  // rebase --gpg-sign を実行（rerere解決済みのコンフリクトは自動続行）
  const rebaseSuccess = await executeRebaseWithAutoResolve(gitEffects, repo, baseBranch);

  if (!rebaseSuccess) {
    process.exit(1);
  }

  console.log('\n✅ Rebase with GPG signing completed successfully!');
  console.log('📝 All commits on this branch are now signed.');

  // マージを実行（--no-merge が指定されていない場合）
  if (merge) {
    console.log(`\n📦 Switching to base branch: ${baseBranch}`);
    const switchToBaseResult = await gitEffects.switchBranch(repo, baseBranch);
    if (isErr(switchToBaseResult)) {
      console.error(`❌ Failed to switch to base branch: ${switchToBaseResult.err.message}`);
      process.exit(1);
    }

    console.log(`🔀 Merging ${targetBranch} into ${baseBranch} (fast-forward)...`);
    const mergeResult = await gitEffects.merge(repo, targetBranch, ['--ff-only']);
    if (isErr(mergeResult)) {
      console.error(`❌ Merge failed: ${mergeResult.err.message}`);
      console.error('\n💡 This should not happen after a successful rebase.');
      console.error('   The rebase was successful, so you can manually run:');
      console.error(`   git checkout ${baseBranch} && git merge --ff-only ${targetBranch}`);
      process.exit(1);
    }

    console.log(`\n✅ Successfully merged ${targetBranch} into ${baseBranch}!`);
    console.log(`   Current branch: ${baseBranch}`);
  }

  console.log('\n   Verify with: git log --show-signature');
}

/**
 * rebaseを実行し、rerereで解決済みのコンフリクトは自動的にadd→continueする
 *
 * WHY: git rerereが有効な場合、過去に解決したコンフリクトは自動的にマーカーが
 * 処理されるが、git addとgit rebase --continueは手動で実行する必要がある。
 * この関数はそれを自動化する。
 */
async function executeRebaseWithAutoResolve(
  gitEffects: GitEffects,
  repo: RepoPath,
  baseBranch: BranchName,
): Promise<boolean> {
  // 既にrebaseが進行中かチェック（前回の中断からの再開）
  const alreadyInProgressResult = await gitEffects.isRebaseInProgress(repo);
  if (isErr(alreadyInProgressResult)) {
    console.error(`❌ Failed to check rebase status: ${alreadyInProgressResult.err.message}`);
    return false;
  }

  if (alreadyInProgressResult.val) {
    console.log('\n🔄 Resuming in-progress rebase...');
    return await resolveConflictsLoop(gitEffects, repo);
  }

  console.log(`\n🔄 Rebasing onto ${baseBranch} with GPG signing...`);

  // 新しくrebaseを開始
  const rebaseResult = await gitEffects.rebase(repo, baseBranch, { gpgSign: true });

  if (isOk(rebaseResult)) {
    return true;
  }

  // rebaseが失敗した場合、rebase進行中かチェック
  const inProgressResult = await gitEffects.isRebaseInProgress(repo);
  if (isErr(inProgressResult) || !inProgressResult.val) {
    // rebase進行中でない＝コンフリクト以外のエラー
    console.error(`❌ Rebase failed: ${rebaseResult.err.message}`);
    return false;
  }

  // コンフリクト解決ループ
  return await resolveConflictsLoop(gitEffects, repo);
}

/**
 * コンフリクトを解決してrebaseを続行するループ
 */
async function resolveConflictsLoop(gitEffects: GitEffects, repo: RepoPath): Promise<boolean> {
  const maxIterations = 100; // 無限ループ防止

  for (let i = 0; i < maxIterations; i++) {
    // コンフリクト中のファイルを取得
    const conflictedResult = await gitEffects.getConflictedFiles(repo);
    if (isErr(conflictedResult)) {
      console.error(`❌ Failed to get conflicted files: ${conflictedResult.err.message}`);
      return false;
    }

    const conflictedFiles = conflictedResult.val;

    if (conflictedFiles.length === 0) {
      // コンフリクトなし、rebase完了またはcontinue可能
      const inProgressResult = await gitEffects.isRebaseInProgress(repo);
      if (isErr(inProgressResult)) {
        console.error(`❌ Failed to check rebase status: ${inProgressResult.err.message}`);
        return false;
      }

      if (!inProgressResult.val) {
        // rebase完了
        return true;
      }

      // rebase進行中だがコンフリクトなし→continue
      console.log('   Continuing rebase...');
      const continueResult = await gitEffects.rebaseContinue(repo, { gpgSign: true });
      if (isOk(continueResult)) {
        return true;
      }

      // continueが失敗した場合、次のイテレーションでコンフリクトをチェック
      continue;
    }

    // コンフリクトあり、マーカーが残っているかチェック
    let hasUnresolvedConflicts = false;
    const resolvedFiles: string[] = [];

    for (const file of conflictedFiles) {
      const markersResult = await gitEffects.hasConflictMarkers(repo, file);
      if (isErr(markersResult)) {
        console.error(`❌ Failed to check conflict markers in ${file}: ${markersResult.err.message}`);
        return false;
      }

      if (markersResult.val) {
        // マーカーが残っている＝手動解決が必要
        hasUnresolvedConflicts = true;
        console.log(`   ⚠️  Unresolved conflict: ${file}`);
      } else {
        // rerereで解決済み
        resolvedFiles.push(file);
      }
    }

    if (hasUnresolvedConflicts) {
      // 手動解決が必要
      console.error('\n❌ Rebase stopped due to unresolved conflicts.');
      console.error('\n💡 Resolve conflicts manually:');
      console.error('   1. Edit the conflicted files to resolve markers');
      console.error('   2. git add <resolved-files>');
      console.error('   3. Run `agent finalize` again to continue');
      console.error('\n   To abort: git rebase --abort');
      return false;
    }

    // 全て解決済み、addしてcontinue
    if (resolvedFiles.length > 0) {
      console.log(`   ✓ Auto-resolved ${resolvedFiles.length} file(s) via rerere`);
      for (const file of resolvedFiles) {
        console.log(`     - ${file}`);
      }

      const stageResult = await gitEffects.stageFiles(repo, resolvedFiles);
      if (isErr(stageResult)) {
        console.error(`❌ Failed to stage resolved files: ${stageResult.err.message}`);
        return false;
      }
    }

    // rebase --continue
    console.log('   Continuing rebase...');
    const continueResult = await gitEffects.rebaseContinue(repo, { gpgSign: true });

    if (isOk(continueResult)) {
      // 完了チェック
      const stillInProgressResult = await gitEffects.isRebaseInProgress(repo);
      if (isErr(stillInProgressResult) || !stillInProgressResult.val) {
        return true;
      }
      // まだ進行中、次のイテレーションへ
      continue;
    }

    // continueが失敗した場合、次のコンフリクトがあるかもしれないので続行
  }

  console.error('❌ Rebase loop exceeded maximum iterations');
  return false;
}
