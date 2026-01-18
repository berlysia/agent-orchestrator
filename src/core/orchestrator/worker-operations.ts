/**
 * Worker Operations - タスク実装を担当する関数群
 *
 * Workerクラスを関数型パターンで再実装。
 * タスクごとにworktreeを作成し、エージェントを実行して実装を行う。
 */

import type { Result } from 'option-t/plain_result';
import { createOk, createErr, isErr } from 'option-t/plain_result';
import type { Task } from '../../types/task.ts';
import type { TaskId, WorktreePath, RepoPath } from '../../types/branded.ts';
import { branchName, runId } from '../../types/branded.ts';
import type { GitEffects } from '../../adapters/vcs/git-effects.ts';
import type { RunnerEffects } from '../runner/runner-effects.ts';
import type { TaskStore } from '../task-store/interface.ts';
import type { OrchestratorError } from '../../types/errors.ts';
import { createInitialRun, RunStatus } from '../../types/run.ts';

/**
 * Worker依存関係
 */
export interface WorkerDeps {
  readonly gitEffects: GitEffects;
  readonly runnerEffects: RunnerEffects;
  readonly taskStore: TaskStore;
  readonly appRepoPath: RepoPath;
}

/**
 * Worker実行結果
 */
export interface WorkerResult {
  /** 実行ID */
  readonly runId: string;
  /** 成功したか */
  readonly success: boolean;
  /** エラーメッセージ（失敗時） */
  readonly error?: string;
}

const detectRateLimitReason = (text: string): string | null => {
  if (!text) {
    return null;
  }

  const patterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /hit your limit/i, reason: 'hit your limit' },
    { pattern: /rate limit/i, reason: 'rate limit' },
    { pattern: /rate[- ]?limited/i, reason: 'rate limited' },
    { pattern: /too many requests/i, reason: 'too many requests' },
    { pattern: /\b429\b/, reason: 'http 429' },
  ];

  for (const { pattern, reason } of patterns) {
    if (pattern.test(text)) {
      return reason;
    }
  }

  return null;
};

/**
 * エージェント種別
 */
export type AgentType = 'claude' | 'codex';

/**
 * コミットメッセージを生成（純粋関数）
 */
export const generateCommitMessage = (task: Task): string => {
  return `feat: ${task.acceptance}

Task ID: ${task.id}
Branch: ${task.branch}

🤖 Generated with Agent Orchestrator

Co-Authored-By: AI Agent <noreply@agent-orchestrator>`;
};

/**
 * Worker操作を生成するファクトリ関数
 */
export const createWorkerOperations = (deps: WorkerDeps) => {
  /**
   * タスク用のworktreeを作成
   *
   * ブランチが存在しない場合は新規作成します。
   *
   * @param task タスク
   * @returns worktreeのパス（Result型）
   */
  const setupWorktree = async (task: Task): Promise<Result<WorktreePath, OrchestratorError>> => {
    // ブランチが存在するか確認
    const branchesResult = await deps.gitEffects.listBranches(deps.appRepoPath);
    if (isErr(branchesResult)) {
      return createErr(branchesResult.err);
    }

    const branches = branchesResult.val;
    const taskBranchName = branchName(task.branch);
    const branchExists = branches.some((b) => b.name === taskBranchName);

    // Worktreeを作成（createBranchフラグでブランチも同時作成）
    const worktreeResult = await deps.gitEffects.createWorktree(
      deps.appRepoPath,
      task.id,
      taskBranchName,
      !branchExists,
    );

    return worktreeResult;
  };

  /**
   * タスクを実行（エージェント実行のみ）
   *
   * エージェントを起動してタスクを実行します。
   * 実行ログとメタデータをrunsディレクトリに保存します。
   * Git操作（commit、push）は別の関数で行います。
   *
   * @param task タスク
   * @param worktreePath worktreeのパス
   * @param agentType 使用するエージェント種別
   * @returns 実行結果（runIdと成功/失敗）
   */
  const executeTask = async (
    task: Task,
    worktreePath: WorktreePath,
    agentType: AgentType,
  ): Promise<Result<WorkerResult, OrchestratorError>> => {
    // 1. runsディレクトリを確保
    const ensureResult = await deps.runnerEffects.ensureRunsDir();
    if (isErr(ensureResult)) {
      return createErr(ensureResult.err);
    }

    // 2. RunID生成（タスクIDベース）
    const timestamp = Date.now();
    const theRunId = runId(`run-${task.id}-${timestamp}`);
    const logPath = `runs/${theRunId}.log`;

    // 3. 実行メタデータを初期化
    const run = createInitialRun({
      id: theRunId,
      taskId: task.id,
      agentType,
      logPath,
    });

    // メタデータ保存
    const saveMetaResult = await deps.runnerEffects.saveRunMetadata(run);
    if (isErr(saveMetaResult)) {
      return createErr(saveMetaResult.err);
    }

    // 4. ログにタスク開始を記録
    await deps.runnerEffects.appendLog(
      theRunId,
      `[${new Date().toISOString()}] Starting task: ${task.acceptance}\n`,
    );
    await deps.runnerEffects.appendLog(theRunId, `Agent Type: ${agentType}\n`);
    await deps.runnerEffects.appendLog(theRunId, `Worktree: ${worktreePath}\n\n`);

    // 5. エージェントを実行
    const agentPrompt = `Execute task: ${task.acceptance}`;
    const agentResult =
      agentType === 'claude'
        ? await deps.runnerEffects.runClaudeAgent(
            agentPrompt,
            worktreePath as string,
            'claude-sonnet-4-5-20250929',
          )
        : await deps.runnerEffects.runCodexAgent(agentPrompt, worktreePath as string);

    // 6. 結果をログに記録
    if (isErr(agentResult)) {
      const errorMsg = agentResult.err.message;
      await deps.runnerEffects.appendLog(
        theRunId,
        `[${new Date().toISOString()}] ❌ Agent execution failed\n`,
      );
      await deps.runnerEffects.appendLog(theRunId, `Error: ${errorMsg}\n`);

      // メタデータ更新（失敗）
      const failedRun = {
        ...run,
        status: RunStatus.FAILURE,
        finishedAt: new Date().toISOString(),
        errorMessage: errorMsg,
      };
      await deps.runnerEffects.saveRunMetadata(failedRun);

      return createOk({
        runId: theRunId,
        success: false,
        error: errorMsg,
      });
    }

    // 7. 成功時の処理
    const output = agentResult.val;
    const rateLimitReason = detectRateLimitReason(output.finalResponse ?? "");
    if (rateLimitReason) {
      const errorMsg = `Rate limit detected (${rateLimitReason})`;
      await deps.runnerEffects.appendLog(
        theRunId,
        `[${new Date().toISOString()}] ❌ Agent execution failed\n`,
      );
      await deps.runnerEffects.appendLog(theRunId, `Error: ${errorMsg}\n`);
      await deps.runnerEffects.appendLog(theRunId, `Final Response:\n${output.finalResponse}\n`);

      const failedRun = {
        ...run,
        status: RunStatus.FAILURE,
        finishedAt: new Date().toISOString(),
        errorMessage: errorMsg,
      };
      await deps.runnerEffects.saveRunMetadata(failedRun);

      return createOk({
        runId: theRunId,
        success: false,
        error: errorMsg,
      });
    }

    await deps.runnerEffects.appendLog(
      theRunId,
      `[${new Date().toISOString()}] ✅ Agent execution completed\n`,
    );
    await deps.runnerEffects.appendLog(theRunId, `Final Response:\n${output.finalResponse}\n`);

    // メタデータ更新（成功）
    const completedRun = {
      ...run,
      status: RunStatus.SUCCESS,
      finishedAt: new Date().toISOString(),
    };
    await deps.runnerEffects.saveRunMetadata(completedRun);

    return createOk({
      runId: theRunId,
      success: true,
    });
  };

  /**
   * 変更をコミット
   *
   * @param task タスク
   * @param worktreePath worktreeのパス
   * @returns Result型
   */
  const commitChanges = async (
    task: Task,
    worktreePath: WorktreePath,
  ): Promise<Result<void, OrchestratorError>> => {
    // 変更をステージング
    const stageResult = await deps.gitEffects.stageAll(worktreePath);
    if (isErr(stageResult)) {
      return createErr(stageResult.err);
    }

    // コミットメッセージを生成
    const commitMessage = generateCommitMessage(task);

    // コミット
    const commitResult = await deps.gitEffects.commit(worktreePath, commitMessage);
    if (isErr(commitResult)) {
      return createErr(commitResult.err);
    }

    return createOk(undefined);
  };

  /**
   * リモートにpush
   *
   * @param task タスク
   * @param worktreePath worktreeのパス
   * @returns Result型
   */
  const pushChanges = async (
    task: Task,
    worktreePath: WorktreePath,
  ): Promise<Result<void, OrchestratorError>> => {
    const taskBranchName = branchName(task.branch);
    const pushResult = await deps.gitEffects.push(worktreePath, 'origin', taskBranchName);

    if (isErr(pushResult)) {
      return createErr(pushResult.err);
    }

    return createOk(undefined);
  };

  /**
   * Worktreeをクリーンアップ（削除）
   *
   * @param taskId タスクID
   * @returns Result型
   */
  const cleanupWorktree = async (taskId: TaskId): Promise<Result<void, OrchestratorError>> => {
    const removeResult = await deps.gitEffects.removeWorktree(deps.appRepoPath, taskId);
    return removeResult;
  };

  /**
   * タスクを実行（全体のオーケストレーション）
   *
   * 1. worktreeを作成
   * 2. Workerエージェントを起動
   * 3. 変更をコミット
   * 4. リモートにpush
   *
   * @param task 実行するタスク
   * @param agentType 使用するエージェント種別
   * @returns 実行結果
   */
  const executeTaskWithWorktree = async (
    task: Task,
    agentType: AgentType,
  ): Promise<Result<WorkerResult, OrchestratorError>> => {
    // 1. Worktreeを作成
    const worktreeResult = await setupWorktree(task);
    if (isErr(worktreeResult)) {
      return createErr(worktreeResult.err);
    }

    const worktreePath = worktreeResult.val;

    try {
      // 2. タスクを実行
      const runResult = await executeTask(task, worktreePath, agentType);
      if (isErr(runResult)) {
        return createErr(runResult.err);
      }

      const result = runResult.val;

      if (!result.success) {
        // エージェント実行失敗時はWorkerResultをそのまま返す
        return createOk(result);
      }

      // 3. 変更をコミット
      const commitResult = await commitChanges(task, worktreePath);
      if (isErr(commitResult)) {
        return createErr(commitResult.err);
      }

      // 4. リモートにpush
      const pushResult = await pushChanges(task, worktreePath);
      if (isErr(pushResult)) {
        return createErr(pushResult.err);
      }

      return createOk(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return createOk({
        runId: `error-${task.id}`,
        success: false,
        error: errorMessage,
      });
    }
  };

  return {
    setupWorktree,
    executeTask,
    commitChanges,
    pushChanges,
    cleanupWorktree,
    executeTaskWithWorktree,
  };
};
