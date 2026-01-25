/**
 * Domain Error Types
 *
 * ドメインエラーの型定義。option-tのResult型と組み合わせて使用する。
 * タグ付きユニオン型により、エラーの種類を型安全に区別できる。
 */

import type { TaskId, RunId, CheckId, WorkerId, RepoPath, BranchName } from './branded.ts';
import type { GitConflictInfo } from './integration.ts';

// ===== TaskStore Errors =====

export type TaskStoreError =
  | TaskNotFoundError
  | TaskAlreadyExistsError
  | ConcurrentModificationError
  | IOError
  | ValidationError;

export interface TaskNotFoundError {
  readonly type: 'TaskNotFoundError';
  readonly taskId: TaskId;
  readonly message: string;
}

export interface TaskAlreadyExistsError {
  readonly type: 'TaskAlreadyExistsError';
  readonly taskId: TaskId;
  readonly message: string;
}

export interface ConcurrentModificationError {
  readonly type: 'ConcurrentModificationError';
  readonly taskId: TaskId;
  readonly expectedVersion: number;
  readonly actualVersion: number;
  readonly message: string;
}

export interface IOError {
  readonly type: 'IOError';
  readonly operation: string;
  readonly cause?: unknown;
  readonly message: string;
}

export interface ValidationError {
  readonly type: 'ValidationError';
  readonly details: string;
  readonly message: string;
}

// TaskStoreError コンストラクタ
export const taskNotFound = (taskId: TaskId): TaskNotFoundError => ({
  type: 'TaskNotFoundError',
  taskId,
  message: `Task not found: ${taskId}`,
});

export const taskAlreadyExists = (taskId: TaskId): TaskAlreadyExistsError => ({
  type: 'TaskAlreadyExistsError',
  taskId,
  message: `Task already exists: ${taskId}`,
});

export const concurrentModification = (
  taskId: TaskId,
  expectedVersion: number,
  actualVersion: number,
): ConcurrentModificationError => ({
  type: 'ConcurrentModificationError',
  taskId,
  expectedVersion,
  actualVersion,
  message: `Concurrent modification detected for task ${taskId}: expected version ${expectedVersion}, actual version ${actualVersion}`,
});

export const ioError = (operation: string, cause?: unknown): IOError => ({
  type: 'IOError',
  operation,
  cause,
  message: `IO error during ${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
});

export const validationError = (details: string): ValidationError => ({
  type: 'ValidationError',
  details,
  message: `Validation failed: ${details}`,
});

// ===== Git/VCS Errors =====

export type GitError =
  | GitCommandFailedError
  | GitRepoNotFoundError
  | GitBranchExistsError
  | GitWorktreeExistsError
  | GitMergeConflictError;

export interface GitCommandFailedError {
  readonly type: 'GitCommandFailedError';
  readonly command: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly message: string;
}

export interface GitRepoNotFoundError {
  readonly type: 'GitRepoNotFoundError';
  readonly repoPath: RepoPath;
  readonly message: string;
}

export interface GitBranchExistsError {
  readonly type: 'GitBranchExistsError';
  readonly branchName: BranchName;
  readonly message: string;
}

export interface GitWorktreeExistsError {
  readonly type: 'GitWorktreeExistsError';
  readonly worktreeName: string;
  readonly message: string;
}

export interface GitMergeConflictError {
  readonly type: 'GitMergeConflictError';
  readonly sourceBranch: BranchName;
  readonly conflicts: GitConflictInfo[];
  readonly message: string;
}

// GitError コンストラクタ
export const gitCommandFailed = (
  command: string,
  stderr: string,
  exitCode: number,
): GitCommandFailedError => ({
  type: 'GitCommandFailedError',
  command,
  stderr,
  exitCode,
  message: `Git command failed: ${command} (exit code ${exitCode})\n${stderr}`,
});

export const gitRepoNotFound = (repoPath: RepoPath): GitRepoNotFoundError => ({
  type: 'GitRepoNotFoundError',
  repoPath,
  message: `Git repository not found: ${repoPath}`,
});

export const gitBranchExists = (branchName: BranchName): GitBranchExistsError => ({
  type: 'GitBranchExistsError',
  branchName,
  message: `Branch already exists: ${branchName}`,
});

export const gitWorktreeExists = (worktreeName: string): GitWorktreeExistsError => ({
  type: 'GitWorktreeExistsError',
  worktreeName,
  message: `Worktree already exists: ${worktreeName}`,
});

export const gitMergeConflict = (
  sourceBranch: BranchName,
  conflicts: GitConflictInfo[],
): GitMergeConflictError => ({
  type: 'GitMergeConflictError',
  sourceBranch,
  conflicts,
  message: `Merge conflict when merging ${sourceBranch}: ${conflicts.length} file(s) conflicted`,
});

// ===== GitHub API Errors =====

export type GitHubError =
  | GitHubAuthFailedError
  | GitHubRateLimitedError
  | GitHubNotFoundError
  | GitHubValidationError
  | GitHubUnknownError;

export interface GitHubAuthFailedError {
  readonly type: 'GitHubAuthFailedError';
  readonly missingEnvName?: string;
  readonly message: string;
}

export interface GitHubRateLimitedError {
  readonly type: 'GitHubRateLimitedError';
  readonly resetAt?: number;
  readonly remaining?: number;
  readonly message: string;
}

export interface GitHubNotFoundError {
  readonly type: 'GitHubNotFoundError';
  readonly resourceType: 'repository' | 'branch' | 'pullRequest';
  readonly message: string;
}

export interface GitHubValidationError {
  readonly type: 'GitHubValidationError';
  readonly field?: string;
  readonly message: string;
}

export interface GitHubUnknownError {
  readonly type: 'GitHubUnknownError';
  readonly statusCode?: number;
  readonly originalError?: string;
  readonly message: string;
}

// GitHubError コンストラクタ
export const githubAuthFailed = (message: string, missingEnvName?: string): GitHubAuthFailedError => ({
  type: 'GitHubAuthFailedError',
  missingEnvName,
  message,
});

export const githubRateLimited = (
  message: string,
  resetAt?: number,
  remaining?: number,
): GitHubRateLimitedError => ({
  type: 'GitHubRateLimitedError',
  resetAt,
  remaining,
  message,
});

export const githubNotFound = (
  resourceType: 'repository' | 'branch' | 'pullRequest',
  message: string,
): GitHubNotFoundError => ({
  type: 'GitHubNotFoundError',
  resourceType,
  message,
});

export const githubValidationError = (message: string, field?: string): GitHubValidationError => ({
  type: 'GitHubValidationError',
  field,
  message,
});

export const githubUnknownError = (
  message: string,
  statusCode?: number,
  originalError?: string,
): GitHubUnknownError => ({
  type: 'GitHubUnknownError',
  statusCode,
  originalError,
  message,
});

// ===== Runner Errors =====

export type RunnerError = AgentExecutionError | LogWriteError | CheckExecutionError;

export interface AgentExecutionError {
  readonly type: 'AgentExecutionError';
  readonly agentType: string;
  readonly cause?: unknown;
  readonly message: string;
}

export interface LogWriteError {
  readonly type: 'LogWriteError';
  readonly runId: RunId;
  readonly cause?: unknown;
  readonly message: string;
}

export interface CheckExecutionError {
  readonly type: 'CheckExecutionError';
  readonly checkId: CheckId;
  readonly cause?: unknown;
  readonly message: string;
}

// RunnerError コンストラクタ
export const agentExecutionError = (agentType: string, cause?: unknown): AgentExecutionError => ({
  type: 'AgentExecutionError',
  agentType,
  cause,
  message: `Agent execution failed (${agentType}): ${cause instanceof Error ? cause.message : String(cause)}`,
});

export const logWriteError = (runId: RunId, cause?: unknown): LogWriteError => ({
  type: 'LogWriteError',
  runId,
  cause,
  message: `Failed to write log for run ${runId}: ${cause instanceof Error ? cause.message : String(cause)}`,
});

export const checkExecutionError = (checkId: CheckId, cause?: unknown): CheckExecutionError => ({
  type: 'CheckExecutionError',
  checkId,
  cause,
  message: `Check execution failed (${checkId}): ${cause instanceof Error ? cause.message : String(cause)}`,
});

// ===== Orchestrator Errors =====

export type OrchestratorError =
  | TaskStoreError
  | GitError
  | RunnerError
  | WorkerCapacityError
  | TaskClaimError
  | ConflictResolutionRequiredError
  | GitHubError;

export interface WorkerCapacityError {
  readonly type: 'WorkerCapacityError';
  readonly currentWorkers: number;
  readonly maxWorkers: number;
  readonly message: string;
}

export interface TaskClaimError {
  readonly type: 'TaskClaimError';
  readonly taskId: TaskId;
  readonly workerId: WorkerId;
  readonly reason: string;
  readonly message: string;
}

export interface ConflictResolutionRequiredError {
  readonly type: 'ConflictResolutionRequiredError';
  readonly parentTaskId: TaskId;
  readonly conflictTaskId: TaskId;
  readonly tempBranch: BranchName;
  readonly message: string;
}

// OrchestratorError コンストラクタ
export const workerCapacityError = (
  currentWorkers: number,
  maxWorkers: number,
): WorkerCapacityError => ({
  type: 'WorkerCapacityError',
  currentWorkers,
  maxWorkers,
  message: `Worker capacity exceeded: ${currentWorkers}/${maxWorkers}`,
});

export const taskClaimError = (
  taskId: TaskId,
  workerId: WorkerId,
  reason: string,
): TaskClaimError => ({
  type: 'TaskClaimError',
  taskId,
  workerId,
  reason,
  message: `Failed to claim task ${taskId} for worker ${workerId}: ${reason}`,
});

export const conflictResolutionRequired = (
  parentTaskId: TaskId,
  conflictTaskId: TaskId,
  tempBranch: BranchName,
): ConflictResolutionRequiredError => ({
  type: 'ConflictResolutionRequiredError',
  parentTaskId,
  conflictTaskId,
  tempBranch,
  message: `Conflict resolution required for task ${parentTaskId}: created resolution task ${conflictTaskId} on ${tempBranch}`,
});

// ===== Config Errors =====

export type ConfigError =
  | ConfigFileNotFoundError
  | ConfigParseError
  | ConfigValidationError
  | ConfigMergeError;

export interface ConfigFileNotFoundError {
  readonly type: 'ConfigFileNotFoundError';
  readonly filePath: string;
  readonly message: string;
}

export interface ConfigParseError {
  readonly type: 'ConfigParseError';
  readonly filePath: string;
  readonly cause?: unknown;
  readonly message: string;
}

export interface ConfigValidationError {
  readonly type: 'ConfigValidationError';
  readonly filePath?: string;
  readonly details: string;
  readonly message: string;
}

export interface ConfigMergeError {
  readonly type: 'ConfigMergeError';
  readonly details: string;
  readonly message: string;
}

// ConfigError コンストラクタ
export const configFileNotFound = (filePath: string): ConfigFileNotFoundError => ({
  type: 'ConfigFileNotFoundError',
  filePath,
  message: `Configuration file not found: ${filePath}`,
});

export const configParseError = (filePath: string, cause?: unknown): ConfigParseError => ({
  type: 'ConfigParseError',
  filePath,
  cause,
  message: `Failed to parse configuration file: ${filePath}${cause instanceof Error ? `\n${cause.message}` : ''}`,
});

export const configValidationError = (details: string, filePath?: string): ConfigValidationError => ({
  type: 'ConfigValidationError',
  filePath,
  details,
  message: `Configuration validation failed${filePath ? ` (${filePath})` : ''}: ${details}`,
});

export const configMergeError = (details: string): ConfigMergeError => ({
  type: 'ConfigMergeError',
  details,
  message: `Configuration merge failed: ${details}`,
});
