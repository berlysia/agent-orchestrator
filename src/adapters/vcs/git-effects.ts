/**
 * GitEffects インターフェース
 *
 * Git操作の副作用を抽象化するインターフェース。
 * すべての操作は Result<T, GitError> を返し、エラーハンドリングを統一する。
 */

import type { Result } from 'option-t/plain_result';
import type { GitError } from '../../types/errors.ts';
import type { RepoPath, WorktreePath, BranchName } from '../../types/branded.ts';

/**
 * Git ブランチ情報
 */
export interface BranchInfo {
  /** ブランチ名 */
  readonly name: BranchName;
  /** 現在のブランチかどうか */
  readonly current: boolean;
  /** コミットハッシュ */
  readonly commit: string;
}

/**
 * Git ステータス情報
 */
export interface GitStatus {
  /** ステージングされたファイル */
  readonly staged: string[];
  /** 変更されたファイル（未ステージング） */
  readonly modified: string[];
  /** 追跡されていないファイル */
  readonly untracked: string[];
  /** 現在のブランチ */
  readonly currentBranch: BranchName | null;
}

/**
 * Worktree 情報
 */
export interface WorktreeInfo {
  /** Worktree のパス */
  readonly path: WorktreePath;
  /** HEAD コミットハッシュ */
  readonly head: string;
  /** ブランチ名（detached の場合は "detached HEAD"） */
  readonly branch: BranchName | 'detached HEAD';
  /** ベアリポジトリかどうか */
  readonly bare: boolean;
}

/**
 * GitEffects インターフェース
 *
 * Git の副作用操作を抽象化。テスト時にはモックで置き換え可能。
 */
export interface GitEffects {
  // ===== ブランチ操作 =====

  /**
   * 新しいブランチを作成
   * @param repo リポジトリパス
   * @param branch ブランチ名
   * @param startPoint 開始ポイント（省略時は現在のHEAD）
   * @returns 成功時は作成されたブランチ名
   */
  createBranch(
    repo: RepoPath,
    branch: BranchName,
    startPoint?: string,
  ): Promise<Result<BranchName, GitError>>;

  /**
   * ブランチに切り替え
   * @param repo リポジトリパス
   * @param branch ブランチ名
   */
  switchBranch(repo: RepoPath, branch: BranchName): Promise<Result<void, GitError>>;

  /**
   * ブランチを削除
   * @param repo リポジトリパス
   * @param branch ブランチ名
   * @param force 強制削除するか
   */
  deleteBranch(
    repo: RepoPath,
    branch: BranchName,
    force?: boolean,
  ): Promise<Result<void, GitError>>;

  /**
   * 現在のブランチ名を取得
   * @param repo リポジトリパス
   */
  getCurrentBranch(repo: RepoPath): Promise<Result<BranchName, GitError>>;

  /**
   * 全ブランチのリストを取得
   * @param repo リポジトリパス
   */
  listBranches(repo: RepoPath): Promise<Result<BranchInfo[], GitError>>;

  // ===== Worktree 操作 =====

  /**
   * Worktree を作成
   * @param repo リポジトリパス
   * @param name Worktree 名（.git/worktree/<name> に配置）
   * @param branch チェックアウトするブランチ
   * @param createBranch 新しいブランチを作成するか
   * @returns 作成された Worktree のパス
   */
  createWorktree(
    repo: RepoPath,
    name: string,
    branch: BranchName,
    createBranch?: boolean,
  ): Promise<Result<WorktreePath, GitError>>;

  /**
   * Worktree を削除
   * @param repo リポジトリパス
   * @param name Worktree 名
   * @param force 強制削除するか
   */
  removeWorktree(repo: RepoPath, name: string, force?: boolean): Promise<Result<void, GitError>>;

  /**
   * 全 Worktree のリストを取得
   * @param repo リポジトリパス
   */
  listWorktrees(repo: RepoPath): Promise<Result<WorktreeInfo[], GitError>>;

  /**
   * 古い Worktree の管理ファイルを削除
   * @param repo リポジトリパス
   */
  pruneWorktrees(repo: RepoPath): Promise<Result<void, GitError>>;

  // ===== コミット/プッシュ操作 =====

  /**
   * すべての変更をステージング
   * @param path リポジトリまたは Worktree のパス
   */
  stageAll(path: RepoPath | WorktreePath): Promise<Result<void, GitError>>;

  /**
   * コミットを作成
   * @param path リポジトリまたは Worktree のパス
   * @param message コミットメッセージ
   */
  commit(path: RepoPath | WorktreePath, message: string): Promise<Result<void, GitError>>;

  /**
   * リモートにプッシュ
   * @param path リポジトリまたは Worktree のパス
   * @param remote リモート名（デフォルト: 'origin'）
   * @param branch ブランチ名（省略時は現在のブランチ）
   */
  push(
    path: RepoPath | WorktreePath,
    remote: string,
    branch?: BranchName,
  ): Promise<Result<void, GitError>>;

  /**
   * リモートからプル
   * @param path リポジトリまたは Worktree のパス
   * @param remote リモート名（デフォルト: 'origin'）
   * @param branch ブランチ名（省略時は現在のブランチ）
   */
  pull(
    path: RepoPath | WorktreePath,
    remote: string,
    branch?: BranchName,
  ): Promise<Result<void, GitError>>;

  /**
   * リモートが存在するかチェック
   * @param path リポジトリまたは Worktree のパス
   * @param remote リモート名（デフォルト: 'origin'）
   */
  hasRemote(path: RepoPath | WorktreePath, remote: string): Promise<Result<boolean, GitError>>;

  // ===== ステータス/差分操作 =====

  /**
   * リポジトリのステータスを取得
   * @param path リポジトリまたは Worktree のパス
   */
  getStatus(path: RepoPath | WorktreePath): Promise<Result<GitStatus, GitError>>;

  /**
   * 差分を取得
   * @param path リポジトリまたは Worktree のパス
   * @param options 差分オプション（例: ['--cached'] でステージング済みの差分）
   */
  getDiff(path: RepoPath | WorktreePath, options?: string[]): Promise<Result<string, GitError>>;
}
