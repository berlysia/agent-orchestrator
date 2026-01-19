/**
 * Integration Types
 *
 * 並列実行タスクの統合処理に関する型定義。
 * マージ操作、コンフリクト検出、解決処理に使用する。
 */

import type { TaskId, BranchName } from './branded.ts';

/**
 * Git コンフリクト情報
 */
export interface GitConflictInfo {
  /** コンフリクトの理由 */
  readonly reason: string;
  /** コンフリクトが発生したファイルパス */
  readonly filePath: string;
  /** コンフリクトのタイプ */
  readonly type: 'content' | 'modify-delete' | 'rename-delete' | 'rename-rename' | 'unknown';
}

/**
 * コンフリクトの内容
 */
export interface ConflictContent {
  /** ファイルパス */
  readonly filePath: string;
  /** 自分側の内容 (ours) */
  readonly oursContent: string;
  /** 相手側の内容 (theirs) */
  readonly theirsContent: string;
  /** ベースとなる内容 (共通の祖先) */
  readonly baseContent: string | null;
  /** 相手側のブランチ名 */
  readonly theirBranch: BranchName;
}

/**
 * マージ結果
 */
export interface MergeResult {
  /** マージが成功したか */
  readonly success: boolean;
  /** マージされたファイルのリスト */
  readonly mergedFiles: string[];
  /** コンフリクトが発生したか */
  readonly hasConflicts: boolean;
  /** コンフリクト情報のリスト */
  readonly conflicts: GitConflictInfo[];
  /** マージの状態 */
  readonly status: 'success' | 'conflicts' | 'failed';
}

/**
 * マージの詳細情報
 */
export interface MergeDetail {
  /** マージ元のタスクID */
  readonly taskId: TaskId;
  /** マージ元のブランチ名 */
  readonly sourceBranch: BranchName;
  /** マージ先のブランチ名 */
  readonly targetBranch: BranchName;
  /** マージ結果 */
  readonly result: MergeResult;
}

/**
 * 統合結果
 */
export interface IntegrationResult {
  /** 統合が成功したか（コンフリクトがあっても一部成功は true） */
  readonly success: boolean;
  /** 統合されたタスクIDのリスト */
  readonly integratedTaskIds: TaskId[];
  /** コンフリクトが発生したタスクIDのリスト */
  readonly conflictedTaskIds: TaskId[];
  /** 統合ブランチ名 */
  readonly integrationBranch: BranchName;
  /** コンフリクト解決タスクのID（存在する場合） */
  readonly conflictResolutionTaskId: TaskId | null;
  /** マージの詳細情報 */
  readonly mergeDetails: MergeDetail[];
}

/**
 * 統合の最終結果（取り込み方法）
 *
 * WHY: discriminated unionにより、methodの値に応じて適切なフィールドのみが存在することを型レベルで保証
 */
export type IntegrationFinalResult =
  | {
      /** 取り込み方法: Pull Request */
      readonly method: 'pr';
      /** PR作成時のURL */
      readonly prUrl: string;
    }
  | {
      /** 取り込み方法: コマンド */
      readonly method: 'command';
      /** ローカルマージ用コマンド */
      readonly mergeCommand: string;
    };

/**
 * コンフリクト解決情報
 */
export interface ConflictResolutionInfo {
  /** タスクID */
  readonly taskId: TaskId;
  /** マージ元のブランチ */
  readonly sourceBranch: BranchName;
  /** マージ先のブランチ */
  readonly targetBranch: BranchName;
  /** コンフリクト情報 */
  readonly conflicts: GitConflictInfo[];
  /** コンフリクトの詳細内容 */
  readonly conflictContents: ConflictContent[];
}
