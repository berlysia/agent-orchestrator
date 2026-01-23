/**
 * SimpleGitEffects - simple-git を使った GitEffects 実装
 *
 * simple-git ライブラリを使用して、GitEffects インターフェースを実装。
 * ブランチ操作、コミット、プッシュなどの基本的なGit操作をサポート。
 * Worktree 操作は spawn-git-effects.ts を使用すること。
 */

import { simpleGit, type BranchSummary, type StatusResult } from 'simple-git';
import { tryCatchIntoResultAsync } from 'option-t/plain_result/try_catch_async';
import { mapErrForResult } from 'option-t/plain_result/map_err';
import { createOk, createErr } from 'option-t/plain_result';
import type { GitError } from '../../types/errors.ts';
import { branchName } from '../../types/branded.ts';
import { gitCommandFailed } from '../../types/errors.ts';
import type { GitEffects, BranchInfo, GitStatus } from './git-effects.ts';
import type { MergeResult, ConflictContent, GitConflictInfo } from '../../types/integration.ts';

/**
 * エラーをGitErrorに変換するヘルパー
 */
const toGitError =
  (operation: string) =>
  (err: unknown): GitError => {
    const stderr = err instanceof Error ? err.message : String(err);
    return gitCommandFailed(operation, stderr, -1);
  };

/**
 * simple-git を使用した GitEffects 実装を作成
 *
 * 注意: Worktree 操作（createWorktree, removeWorktree など）は
 * simple-git でサポートされていないため、SpawnGitEffects を使用すること。
 */
export const createSimpleGitEffects = (): Omit<
  GitEffects,
  'createWorktree' | 'removeWorktree' | 'listWorktrees' | 'pruneWorktrees' | 'getWorktreePath'
> => {
  // ===== ブランチ操作 =====

  const createBranch: GitEffects['createBranch'] = async (repo, branch, startPoint) => {
    const result = await tryCatchIntoResultAsync(async () => {
      const git = simpleGit(repo);
      const args = startPoint ? [branch, startPoint] : [branch];
      await git.branch(args);
      return branch;
    });
    return mapErrForResult(result, toGitError('createBranch'));
  };

  const switchBranch: GitEffects['switchBranch'] = async (repo, branch) => {
    const result = await tryCatchIntoResultAsync(async () => {
      const git = simpleGit(repo);
      await git.checkout(branch);
    });
    return mapErrForResult(result, toGitError('switchBranch'));
  };

  const deleteBranch: GitEffects['deleteBranch'] = async (repo, branch, force = false) => {
    const result = await tryCatchIntoResultAsync(async () => {
      const git = simpleGit(repo);
      const flag = force ? '-D' : '-d';
      await git.branch([flag, branch]);
    });
    return mapErrForResult(result, toGitError('deleteBranch'));
  };

  const getCurrentBranch: GitEffects['getCurrentBranch'] = async (repo) => {
    const result = await tryCatchIntoResultAsync(async () => {
      const git = simpleGit(repo);
      const summary: BranchSummary = await git.branch();
      return branchName(summary.current);
    });
    return mapErrForResult(result, toGitError('getCurrentBranch'));
  };

  const listBranches: GitEffects['listBranches'] = async (repo) => {
    const result = await tryCatchIntoResultAsync(async () => {
      const git = simpleGit(repo);
      const summary: BranchSummary = await git.branch();

      const branches: BranchInfo[] = Object.entries(summary.branches).map(
        ([name, info]): BranchInfo => ({
          name: branchName(name),
          current: name === summary.current,
          commit: info.commit,
        }),
      );

      return branches;
    });
    return mapErrForResult(result, toGitError('listBranches'));
  };

  // ===== コミット/プッシュ操作 =====

  const stageAll: GitEffects['stageAll'] = async (path) => {
    const result = await tryCatchIntoResultAsync(async () => {
      const git = simpleGit(path);
      await git.add('.');
    });
    return mapErrForResult(result, toGitError('stageAll'));
  };

  const stageFiles: GitEffects['stageFiles'] = async (path, files) => {
    if (files.length === 0) {
      return createOk(undefined);
    }
    const result = await tryCatchIntoResultAsync(async () => {
      const git = simpleGit(path);
      await git.add(files);
    });
    return mapErrForResult(result, toGitError('stageFiles'));
  };

  const commit: GitEffects['commit'] = async (path, message, options) => {
    const result = await tryCatchIntoResultAsync(async () => {
      const git = simpleGit(path);
      // gpgSign オプションで署名の有無を明示的に制御
      // WHY: git config の設定に依存せず、常に意図した動作を保証するため
      //      - gpgSign: true → --gpg-sign（署名を強制）
      //      - gpgSign: false → --no-gpg-sign（署名を無効化）
      //      - gpgSign: undefined かつ noGpgSign: true → --no-gpg-sign（後方互換性）
      //      - 両方 undefined → git config に任せる
      let commitOptions: Record<string, null> | undefined;
      if (options?.gpgSign === true) {
        commitOptions = { '--gpg-sign': null };
      } else if (options?.gpgSign === false || options?.noGpgSign) {
        commitOptions = { '--no-gpg-sign': null };
      }
      await git.commit(message, undefined, commitOptions);
    });
    return mapErrForResult(result, toGitError('commit'));
  };

  const rebase: GitEffects['rebase'] = async (path, branch, options) => {
    const result = await tryCatchIntoResultAsync(async () => {
      const git = simpleGit(path);
      const args = ['rebase'];
      if (options?.gpgSign) {
        args.push('--gpg-sign');
      }
      args.push(branch);
      await git.raw(args);
    });
    return mapErrForResult(result, toGitError('rebase'));
  };

  const rebaseContinue: GitEffects['rebaseContinue'] = async (path, options) => {
    const result = await tryCatchIntoResultAsync(async () => {
      const git = simpleGit(path);
      const args = ['rebase', '--continue'];
      if (options?.gpgSign) {
        args.push('--gpg-sign');
      }
      await git.raw(args);
    });
    return mapErrForResult(result, toGitError('rebaseContinue'));
  };

  const isRebaseInProgress: GitEffects['isRebaseInProgress'] = async (path) => {
    const result = await tryCatchIntoResultAsync(async () => {
      const git = simpleGit(path);
      // .git/rebase-merge または .git/rebase-apply が存在すればrebase進行中
      const gitDir = await git.revparse(['--git-dir']);
      const fs = await import('node:fs/promises');
      const rebaseMerge = `${path}/${gitDir.trim()}/rebase-merge`;
      const rebaseApply = `${path}/${gitDir.trim()}/rebase-apply`;

      try {
        await fs.access(rebaseMerge);
        return true;
      } catch {
        // rebase-merge doesn't exist
      }

      try {
        await fs.access(rebaseApply);
        return true;
      } catch {
        // rebase-apply doesn't exist
      }

      return false;
    });
    return mapErrForResult(result, toGitError('isRebaseInProgress'));
  };

  const hasConflictMarkers: GitEffects['hasConflictMarkers'] = async (path, filePath) => {
    const result = await tryCatchIntoResultAsync(async () => {
      const fs = await import('node:fs/promises');
      const fullPath = `${path}/${filePath}`;
      const content = await fs.readFile(fullPath, 'utf-8');
      // コンフリクトマーカーのパターンをチェック
      const markers = ['<<<<<<<', '=======', '>>>>>>>'];
      return markers.some((marker) => content.includes(marker));
    });
    return mapErrForResult(result, toGitError('hasConflictMarkers'));
  };

  const push: GitEffects['push'] = async (path, remote, branch) => {
    const result = await tryCatchIntoResultAsync(async () => {
      const git = simpleGit(path);
      if (branch) {
        await git.push(remote, branch);
      } else {
        await git.push(remote);
      }
    });
    return mapErrForResult(result, toGitError('push'));
  };

  const pull: GitEffects['pull'] = async (path, remote, branch) => {
    const result = await tryCatchIntoResultAsync(async () => {
      const git = simpleGit(path);
      if (branch) {
        await git.pull(remote, branch);
      } else {
        await git.pull(remote);
      }
    });
    return mapErrForResult(result, toGitError('pull'));
  };

  const hasRemote: GitEffects['hasRemote'] = async (path, remote) => {
    const result = await tryCatchIntoResultAsync(async () => {
      const git = simpleGit(path);
      const remotes = await git.getRemotes();
      return remotes.some((r) => r.name === remote);
    });
    return mapErrForResult(result, toGitError('hasRemote'));
  };

  // ===== ステータス/差分操作 =====

  const getStatus: GitEffects['getStatus'] = async (path) => {
    const result = await tryCatchIntoResultAsync(async () => {
      const git = simpleGit(path);
      const status: StatusResult = await git.status();

      const gitStatus: GitStatus = {
        staged: status.staged,
        modified: status.modified,
        untracked: status.not_added,
        currentBranch: status.current ? branchName(status.current) : null,
      };

      return gitStatus;
    });
    return mapErrForResult(result, toGitError('getStatus'));
  };

  const getDiff: GitEffects['getDiff'] = async (path, options) => {
    const result = await tryCatchIntoResultAsync(async () => {
      const git = simpleGit(path);
      return await git.diff(options);
    });
    return mapErrForResult(result, toGitError('getDiff'));
  };

  // ===== マージ操作 =====

  const merge: GitEffects['merge'] = async (path, sourceBranch, options) => {
    try {
      const git = simpleGit(path);
      const mergeOptions = options || [];
      await git.merge([sourceBranch, ...mergeOptions]);

      // マージ成功時
      const mergedFiles: string[] = [];
      const status = await git.status();
      // ステージングされたファイルがマージされたファイル
      mergedFiles.push(...status.staged);

      const result: MergeResult = {
        success: true,
        mergedFiles,
        hasConflicts: false,
        conflicts: [],
        status: 'success',
      };

      return createOk(result);
    } catch (err) {
      // 改善: エラー型に関係なく、まずstatusを確認
      // WHY: simple-gitが返すエラーがGitResponseErrorではない場合があるため
      try {
        const git = simpleGit(path);
        const status = await git.status();

        if (status.conflicted.length > 0) {
          // コンフリクトが発生している
          const conflicts: GitConflictInfo[] = status.conflicted.map((filePath) => ({
            reason: 'merge conflict',
            filePath,
            type: 'content' as const,
          }));

          const result: MergeResult = {
            success: false,
            mergedFiles: [],
            hasConflicts: true,
            conflicts,
            status: 'conflicts',
          };

          return createOk(result);
        }
      } catch (statusErr) {
        // status取得失敗時のログ出力
        console.error('Failed to get git status after merge error:', statusErr);
      }

      // コンフリクトでない場合はエラーとして扱う
      const gitError = toGitError(`merge ${sourceBranch}`)(err);
      return createErr(gitError);
    }
  };

  const abortMerge: GitEffects['abortMerge'] = async (path) => {
    const result = await tryCatchIntoResultAsync(async () => {
      const git = simpleGit(path);
      await git.raw(['merge', '--abort']);
    });
    return mapErrForResult(result, toGitError('abortMerge'));
  };

  const getConflictedFiles: GitEffects['getConflictedFiles'] = async (path) => {
    const result = await tryCatchIntoResultAsync(async () => {
      const git = simpleGit(path);
      const status = await git.status();
      return status.conflicted;
    });
    return mapErrForResult(result, toGitError('getConflictedFiles'));
  };

  const getConflictContent: GitEffects['getConflictContent'] = async (path, filePath) => {
    const result = await tryCatchIntoResultAsync(async () => {
      const git = simpleGit(path);

      // 現在のブランチ名を取得
      const status = await git.status();
      const currentBranch = status.current ? branchName(status.current) : branchName('HEAD');

      // :2: = ours (現在のブランチ), :3: = theirs (マージ元)
      let oursContent = '';
      let theirsContent = '';
      let baseContent: string | null = null;

      try {
        oursContent = await git.show([`:2:${filePath}`]);
      } catch {
        oursContent = '';
      }

      try {
        theirsContent = await git.show([`:3:${filePath}`]);
      } catch {
        theirsContent = '';
      }

      try {
        baseContent = await git.show([`:1:${filePath}`]);
      } catch {
        baseContent = null;
      }

      const conflictContent: ConflictContent = {
        filePath,
        oursContent,
        theirsContent,
        baseContent,
        theirBranch: currentBranch, // マージ元のブランチ名は取得が難しいため暫定的に現在のブランチを使用
      };

      return conflictContent;
    });
    return mapErrForResult(result, toGitError('getConflictContent'));
  };

  const markConflictResolved: GitEffects['markConflictResolved'] = async (path, filePath) => {
    const result = await tryCatchIntoResultAsync(async () => {
      const git = simpleGit(path);
      await git.add(filePath);
    });
    return mapErrForResult(result, toGitError('markConflictResolved'));
  };

  const raw: NonNullable<GitEffects['raw']> = async (path, args) => {
    const result = await tryCatchIntoResultAsync(async () => {
      const git = simpleGit(path);
      return await git.raw(args);
    });
    return mapErrForResult(result, toGitError(`raw ${args.join(' ')}`));
  };

  return {
    createBranch,
    switchBranch,
    deleteBranch,
    getCurrentBranch,
    listBranches,
    stageAll,
    stageFiles,
    commit,
    rebase,
    rebaseContinue,
    isRebaseInProgress,
    hasConflictMarkers,
    push,
    pull,
    hasRemote,
    getStatus,
    getDiff,
    merge,
    abortMerge,
    getConflictedFiles,
    getConflictContent,
    markConflictResolved,
    raw,
  };
};
