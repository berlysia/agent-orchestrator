/**
 * SpawnGitEffects - child_process.spawn を使った GitEffects 実装（Worktree 専用）
 *
 * simple-git では worktree 操作がサポートされていないため、
 * child_process.spawn を使って git コマンドを直接実行する。
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createOk, createErr } from 'option-t/plain_result';
import { tryCatchIntoResultAsync } from 'option-t/plain_result/try_catch_async';
import { mapErrForResult } from 'option-t/plain_result/map_err';
import type { Result } from 'option-t/plain_result';
import type { GitError } from '../../types/errors.ts';
import type { RepoPath, WorktreePath, BranchName } from '../../types/branded.ts';
import { worktreePath, branchName } from '../../types/branded.ts';
import { gitCommandFailed } from '../../types/errors.ts';
import type { WorktreeInfo } from './git-effects.ts';

/**
 * Git コマンド実行結果
 */
interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Git コマンドを実行
 */
const executeGitCommand = async (
  cwd: string,
  args: string[],
): Promise<Result<GitCommandResult, GitError>> => {
  const result = await tryCatchIntoResultAsync(async () => {
    return new Promise<GitCommandResult>((resolve, reject) => {
      const gitProcess = spawn('git', args, {
        cwd,
        shell: false,
      });

      let stdout = '';
      let stderr = '';

      gitProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      gitProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      gitProcess.on('error', (error) => {
        reject(error);
      });

      gitProcess.on('close', (exitCode) => {
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: exitCode ?? -1,
        });
      });
    });
  });

  return mapErrForResult(result, (err) => {
    const message = err instanceof Error ? err.message : String(err);
    return gitCommandFailed('git', message, -1);
  });
};

/**
 * `git worktree list --porcelain` の出力をパース
 *
 * 出力例:
 * ```
 * worktree /path/to/main
 * HEAD abc123
 * branch refs/heads/main
 *
 * worktree /path/to/feature
 * HEAD def456
 * branch refs/heads/feature
 * ```
 */
const parseWorktreeList = (output: string): WorktreeInfo[] => {
  if (!output) {
    return [];
  }

  const worktrees: WorktreeInfo[] = [];
  const entries = output.split('\n\n');

  for (const entry of entries) {
    const lines = entry.split('\n').filter((line) => line.trim());
    if (lines.length === 0) continue;

    let path: string | undefined;
    let head: string | undefined;
    let branch: BranchName | 'detached HEAD' | undefined;
    let bare = false;

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.substring('worktree '.length);
      } else if (line.startsWith('HEAD ')) {
        head = line.substring('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        const branchRef = line.substring('branch '.length);
        // Extract branch name from refs/heads/branch-name
        branch = branchName(branchRef.replace('refs/heads/', ''));
      } else if (line.startsWith('detached')) {
        branch = 'detached HEAD';
      } else if (line.startsWith('bare')) {
        bare = true;
      }
    }

    if (path && head && branch) {
      worktrees.push({
        path: worktreePath(path),
        head,
        branch,
        bare,
      });
    }
  }

  return worktrees;
};

/**
 * child_process.spawn を使用した GitEffects のうち、Worktree 操作部分を実装
 */
export const createSpawnGitEffects = (): Pick<
  import('./git-effects.ts').GitEffects,
  'createWorktree' | 'removeWorktree' | 'listWorktrees' | 'pruneWorktrees' | 'getWorktreePath'
> => {
  const createWorktree = async (
    repo: RepoPath,
    name: string,
    branch: BranchName,
    createBranch = false,
  ): Promise<Result<WorktreePath, GitError>> => {
    const wtPath = join(repo, '.git', 'worktree', name);
    const args = ['worktree', 'add'];

    if (createBranch) {
      args.push('-b', branch);
    }

    args.push(wtPath);

    if (!createBranch) {
      args.push(branch);
    }

    const result = await executeGitCommand(repo, args);

    if (!result.ok) {
      return result;
    }

    if (result.val.exitCode !== 0) {
      return createErr(gitCommandFailed('worktree add', result.val.stderr, result.val.exitCode));
    }

    return createOk(worktreePath(wtPath));
  };

  const removeWorktree = async (
    repo: RepoPath,
    name: string,
    force = false,
  ): Promise<Result<void, GitError>> => {
    const wtPath = join(repo, '.git', 'worktree', name);
    const args = ['worktree', 'remove'];

    if (force) {
      args.push('--force');
    }

    args.push(wtPath);

    const result = await executeGitCommand(repo, args);

    if (!result.ok) {
      return result;
    }

    if (result.val.exitCode !== 0) {
      return createErr(gitCommandFailed('worktree remove', result.val.stderr, result.val.exitCode));
    }

    return createOk(undefined);
  };

  const listWorktrees = async (repo: RepoPath): Promise<Result<WorktreeInfo[], GitError>> => {
    const result = await executeGitCommand(repo, ['worktree', 'list', '--porcelain']);

    if (!result.ok) {
      return result;
    }

    if (result.val.exitCode !== 0) {
      return createErr(gitCommandFailed('worktree list', result.val.stderr, result.val.exitCode));
    }

    const worktrees = parseWorktreeList(result.val.stdout);
    return createOk(worktrees);
  };

  const pruneWorktrees = async (repo: RepoPath): Promise<Result<void, GitError>> => {
    const result = await executeGitCommand(repo, ['worktree', 'prune']);

    if (!result.ok) {
      return result;
    }

    if (result.val.exitCode !== 0) {
      return createErr(gitCommandFailed('worktree prune', result.val.stderr, result.val.exitCode));
    }

    return createOk(undefined);
  };

  const getWorktreePath = async (
    repo: RepoPath,
    name: string,
  ): Promise<Result<WorktreePath, GitError>> => {
    const worktreesResult = await listWorktrees(repo);

    if (!worktreesResult.ok) {
      return worktreesResult;
    }

    const worktrees = worktreesResult.val;
    const targetWorktree = worktrees.find((wt) => {
      // Worktreeのパスに name が含まれているかチェック
      return String(wt.path).includes(name);
    });

    if (!targetWorktree) {
      return createErr(gitCommandFailed('getWorktreePath', `Worktree not found: ${name}`, -1));
    }

    return createOk(targetWorktree.path);
  };

  return {
    createWorktree,
    removeWorktree,
    listWorktrees,
    pruneWorktrees,
    getWorktreePath,
  };
};
