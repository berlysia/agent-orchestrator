/**
 * Branded Types for type-safe domain identifiers
 *
 * ドメイン識別子の型安全性を確保するためのBranded Types定義。
 * 文字列をそのまま使うのではなく、意味のある型として扱うことで、
 * 異なる種類のIDを誤って混同することを防ぐ。
 */

declare const brand: unique symbol;
type Brand<K, T> = T & { readonly [brand]: K };

// Task関連
export type TaskId = Brand<'TaskId', string>;
export type RunId = Brand<'RunId', string>;
export type CheckId = Brand<'CheckId', string>;

// Worker関連
export type WorkerId = Brand<'WorkerId', string>;

// Git/VCS関連
export type RepoPath = Brand<'RepoPath', string>;
export type WorktreePath = Brand<'WorktreePath', string>;
export type BranchName = Brand<'BranchName', string>;

// コンストラクタ関数
// これらの関数を使って、素のstring型からBranded Typeへ変換する
export const taskId = (raw: string): TaskId => raw as TaskId;
export const runId = (raw: string): RunId => raw as RunId;
export const checkId = (raw: string): CheckId => raw as CheckId;
export const workerId = (raw: string): WorkerId => raw as WorkerId;
export const repoPath = (raw: string): RepoPath => raw as RepoPath;
export const worktreePath = (raw: string): WorktreePath => raw as WorktreePath;
export const branchName = (raw: string): BranchName => raw as BranchName;

// アンラップ関数（必要に応じて使用）
// Branded Typeからプレーンなstringへ変換する
export const unwrapTaskId = (id: TaskId): string => id as string;
export const unwrapRunId = (id: RunId): string => id as string;
export const unwrapCheckId = (id: CheckId): string => id as string;
export const unwrapWorkerId = (id: WorkerId): string => id as string;
export const unwrapRepoPath = (path: RepoPath): string => path as string;
export const unwrapWorktreePath = (path: WorktreePath): string => path as string;
export const unwrapBranchName = (name: BranchName): string => name as string;
