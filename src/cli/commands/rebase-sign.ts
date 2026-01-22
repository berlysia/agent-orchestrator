import { Command } from 'commander';
import { createGitEffects } from '../../adapters/vcs/index.ts';
import { repoPath, branchName } from '../../types/branded.ts';
import { isErr } from 'option-t/plain_result';

/**
 * `agent rebase-sign` コマンドの実装
 *
 * WHY: GPG署名には認証（pinentry等）が必要で、長時間のオーケストレーション後に
 * ユーザーが席を離れていると認証タイムアウトで失敗する問題がある。
 * このコマンドは統合ブランチに対して手動で署名付きrebaseを実行するために使用する。
 */
export function createRebaseSignCommand(): Command {
  const rebaseSignCommand = new Command('rebase-sign')
    .description('Rebase a branch with GPG signing for all commits')
    .option('--base <branch>', 'Base branch to rebase onto (default: auto-detect main/master)')
    .option('--branch <branch>', 'Branch to rebase (default: current branch)')
    .option('--dry-run', 'Show what would be done without executing', false)
    .action(async (options) => {
      try {
        await executeRebaseSign({
          baseBranch: options.base,
          targetBranch: options.branch,
          dryRun: options.dryRun,
        });
      } catch (error) {
        console.error('Rebase-sign failed:', error);
        process.exit(1);
      }
    });

  return rebaseSignCommand;
}

/**
 * rebase-sign の実装
 */
async function executeRebaseSign(params: {
  baseBranch?: string;
  targetBranch?: string;
  dryRun: boolean;
}): Promise<void> {
  const { baseBranch: baseBranchArg, targetBranch: targetBranchArg, dryRun } = params;

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

  // rebase --gpg-sign を実行
  console.log(`\n🔄 Rebasing onto ${baseBranch} with GPG signing...`);
  const rebaseResult = await gitEffects.rebase(repo, baseBranch, { gpgSign: true });

  if (isErr(rebaseResult)) {
    console.error(`❌ Rebase failed: ${rebaseResult.err.message}`);
    console.error('\n💡 If conflicts occurred, resolve them manually:');
    console.error('   1. Resolve conflicts in the affected files');
    console.error('   2. git add <resolved-files>');
    console.error('   3. git rebase --continue');
    console.error('\n   To abort: git rebase --abort');
    process.exit(1);
  }

  console.log('\n✅ Rebase with GPG signing completed successfully!');
  console.log('\n📝 All commits on this branch are now signed.');
  console.log('   Verify with: git log --show-signature');
}
