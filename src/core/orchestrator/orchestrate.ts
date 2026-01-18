import path from 'node:path';
import type { TaskStore } from '../task-store/interface.ts';
import type { GitEffects } from '../../adapters/vcs/git-effects.ts';
import type { RunnerEffects } from '../runner/runner-effects.ts';
import { createSchedulerOperations } from './scheduler-operations.ts';
import { createPlannerOperations } from './planner-operations.ts';
import { createWorkerOperations, type WorkerDeps, type AgentType } from './worker-operations.ts';
import { createJudgeOperations } from './judge-operations.ts';
import { initialSchedulerState, removeRunningWorker } from './scheduler-state.ts';
import { taskId, workerId, repoPath } from '../../types/branded.ts';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr, isErr } from 'option-t/plain_result';

/**
 * Orchestrator依存関係
 */
export interface OrchestrateDeps {
  readonly taskStore: TaskStore;
  readonly gitEffects: GitEffects;
  readonly runnerEffects: RunnerEffects;
  readonly appRepoPath: string;
  readonly agentCoordPath?: string;
  readonly agentType: AgentType;
  readonly maxWorkers?: number;
}

/**
 * Orchestrator実行結果
 *
 * WHY: index.ts の OrchestrationResult と同一だが、循環インポート回避のため再定義
 */
export interface OrchestrationResult {
  /** 生成されたタスクID配列 */
  taskIds: string[];
  /** 完了したタスクID配列 */
  completedTaskIds: string[];
  /** 失敗したタスクID配列 */
  failedTaskIds: string[];
  /** 全体の成功可否 */
  success: boolean;
}

/**
 * Orchestratorエラー型
 */
export interface OrchestratorError {
  type: 'PLANNING_ERROR' | 'WORKER_ERROR' | 'JUDGE_ERROR' | 'UNKNOWN_ERROR';
  message: string;
  cause?: unknown;
}

/**
 * Orchestratorを作成
 *
 * ユーザー指示を受け取り、Planner→Worker→Judgeのサイクルを実行
 *
 * @param deps Orchestrator依存関係
 * @returns Orchestrator操作オブジェクト
 */
export const createOrchestrator = (deps: OrchestrateDeps) => {
  const toRelativePath = (targetPath: string): string => {
    const absolutePath = path.resolve(targetPath);
    const relativePath = path.relative(process.cwd(), absolutePath);
    return relativePath === '' ? '.' : relativePath;
  };

  const getRunDisplayPath = (runId: string, ext: 'log' | 'json'): string => {
    if (!deps.agentCoordPath) {
      return `runs/${runId}.${ext}`;
    }

    return toRelativePath(path.join(deps.agentCoordPath, 'runs', `${runId}.${ext}`));
  };

  // 各コンポーネントの操作を生成
  const schedulerOps = createSchedulerOperations({ taskStore: deps.taskStore });
  const plannerOps = createPlannerOperations({
    taskStore: deps.taskStore,
    runnerEffects: deps.runnerEffects,
    appRepoPath: deps.appRepoPath,
    agentType: deps.agentType,
  });
  const workerDeps: WorkerDeps = {
    gitEffects: deps.gitEffects,
    runnerEffects: deps.runnerEffects,
    taskStore: deps.taskStore,
    appRepoPath: repoPath(deps.appRepoPath),
  };
  const workerOps = createWorkerOperations(workerDeps);
  const judgeOps = createJudgeOperations({ taskStore: deps.taskStore });

  /**
   * ユーザー指示を実行
   *
   * 1. Planner: タスク分解
   * 2. Scheduler: タスク割り当て
   * 3. Worker: タスク実行
   * 4. Judge: 完了判定
   *
   * @param userInstruction ユーザーの指示
   * @returns 実行結果（Result型）
   */
  const executeInstruction = async (
    userInstruction: string,
  ): Promise<Result<OrchestrationResult, OrchestratorError>> => {
    const completedTaskIds: string[] = [];
    const failedTaskIds: string[] = [];
    let schedulerState = initialSchedulerState(deps.maxWorkers ?? 3);

    try {
      // 1. Planner: タスク分解
      console.log('🔍 Planning tasks...');
      const planningResult = await plannerOps.planTasks(userInstruction);

      if (isErr(planningResult)) {
        return createErr({
          type: 'PLANNING_ERROR',
          message: planningResult.err.message,
          cause: planningResult.err,
        });
      }

      const { taskIds } = planningResult.val;
      console.log(`📋 Generated ${taskIds.length} tasks`);

      // 2-4. 各タスクを順次実行（Scheduler→Worker→Judge）
      for (const rawTaskId of taskIds) {
        console.log(`\n🔨 Processing task: ${rawTaskId}`);

        // 2. Scheduler: タスク割り当て
        const wid = `worker-${rawTaskId}`;
        const claimResult = await schedulerOps.claimTask(schedulerState, rawTaskId, wid);

        if (isErr(claimResult)) {
          console.log(`⚠️  Failed to claim task: ${claimResult.err.message}`);
          failedTaskIds.push(rawTaskId);
          continue;
        }

        const { task: claimedTask, newState } = claimResult.val;
        schedulerState = newState;

        const tid = taskId(rawTaskId);

        try {
          // 3. Worker: タスク実行
          console.log(`  🚀 Executing task...`);
          const workerResult = await workerOps.executeTaskWithWorktree(claimedTask, deps.agentType);

          if (isErr(workerResult)) {
            console.log(`  ❌ Task execution failed: ${workerResult.err.message}`);
            await schedulerOps.blockTask(tid);
            failedTaskIds.push(rawTaskId);
            continue;
          }

          const result = workerResult.val;
          // ログファイルの場所を表示
          console.log(`  📝 Execution log: ${getRunDisplayPath(result.runId, 'log')}`);
          console.log(`  📊 Metadata: ${getRunDisplayPath(result.runId, 'json')}`);

          if (!result.success) {
            console.log(`  ❌ Task execution failed: ${result.error ?? 'Unknown error'}`);
            await schedulerOps.blockTask(tid);
            failedTaskIds.push(rawTaskId);
            continue;
          }

          // 4. Judge: 完了判定
          console.log(`  ⚖️  Judging task...`);
          const judgementResult = await judgeOps.judgeTask(tid);

          if (isErr(judgementResult)) {
            console.log(`  ❌ Failed to judge task: ${judgementResult.err.message}`);
            await schedulerOps.blockTask(tid);
            failedTaskIds.push(rawTaskId);
            continue;
          }

          const judgement = judgementResult.val;

          if (judgement.success) {
            console.log(`  ✅ Task completed: ${judgement.reason}`);
            await judgeOps.markTaskAsCompleted(tid);
            completedTaskIds.push(rawTaskId);
          } else {
            console.log(`  ❌ Task failed judgement: ${judgement.reason}`);
            await judgeOps.markTaskAsBlocked(tid);
            failedTaskIds.push(rawTaskId);
          }
        } finally {
          // Worktreeをクリーンアップ
          const cleanupResult = await workerOps.cleanupWorktree(tid);
          if (isErr(cleanupResult)) {
            console.warn(`  ⚠️  Failed to cleanup worktree: ${cleanupResult.err.message}`);
          }

          // Workerスロットを解放
          schedulerState = removeRunningWorker(schedulerState, workerId(wid));
        }
      }

      const success = failedTaskIds.length === 0;
      console.log(
        `\n${success ? '🎉' : '⚠️ '} Orchestration ${success ? 'completed' : 'finished with errors'}`,
      );
      console.log(`  Completed: ${completedTaskIds.length}`);
      console.log(`  Failed: ${failedTaskIds.length}`);

      return createOk({
        taskIds,
        completedTaskIds,
        failedTaskIds,
        success,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ Orchestration error: ${errorMessage}`);

      return createErr({
        type: 'UNKNOWN_ERROR',
        message: errorMessage,
        cause: error,
      });
    }
  };

  return {
    executeInstruction,
  };
};

/**
 * Orchestrator操作型
 */
export type OrchestratorOperations = ReturnType<typeof createOrchestrator>;
