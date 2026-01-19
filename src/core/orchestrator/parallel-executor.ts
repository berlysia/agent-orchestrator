import type { TaskId } from '../../types/branded.ts';
import type { DependencyGraph } from './dependency-graph.ts';
import type { SchedulerOperations } from './scheduler-operations.ts';
import type { JudgeOperations } from './judge-operations.ts';
import type { SchedulerState } from './scheduler-state.ts';
import { workerId } from '../../types/branded.ts';
import { isErr } from 'option-t/plain_result';
import { removeRunningWorker } from './scheduler-state.ts';
import type { createWorkerOperations } from './worker-operations.ts';

type WorkerOperations = ReturnType<typeof createWorkerOperations>;

/**
 * レベル実行結果
 *
 * WHY: 並列実行の結果を追跡し、失敗タスクの依存先をブロックするため
 */
export interface LevelExecutionResult {
  /** 完了したタスクID配列 */
  completed: TaskId[];
  /** 失敗したタスクID配列 */
  failed: TaskId[];
  /** ブロックされたタスクID配列（依存先の失敗により実行されなかった） */
  blocked: TaskId[];
  /** 更新されたスケジューラ状態 */
  updatedSchedulerState: SchedulerState;
}

/**
 * 単一レベルのタスクを並列実行
 *
 * WHY: 依存関係のないタスクを並列実行することで、全体の実行時間を短縮
 *
 * @param levelTaskIds このレベルのタスクID配列
 * @param schedulerOps スケジューラ操作
 * @param workerOps ワーカー操作
 * @param judgeOps ジャッジ操作
 * @param schedulerState 現在のスケジューラ状態
 * @param blockedTaskIds ブロック済みタスクIDのセット
 * @returns レベル実行結果
 */
export async function executeLevelParallel(
  levelTaskIds: TaskId[],
  schedulerOps: SchedulerOperations,
  workerOps: WorkerOperations,
  judgeOps: JudgeOperations,
  schedulerState: SchedulerState,
  blockedTaskIds: Set<TaskId>,
): Promise<LevelExecutionResult> {
  const completed: TaskId[] = [];
  const failed: TaskId[] = [];
  const blocked: TaskId[] = [];

  // ブロック済みタスクをスキップ
  const executableTaskIds = levelTaskIds.filter((tid) => !blockedTaskIds.has(tid));

  if (executableTaskIds.length === 0) {
    return {
      completed,
      failed,
      blocked: levelTaskIds.filter((tid) => blockedTaskIds.has(tid)),
      updatedSchedulerState: schedulerState,
    };
  }

  console.log(`\n🔨 Executing level with ${executableTaskIds.length} tasks in parallel`);
  for (const tid of executableTaskIds) {
    console.log(`  - ${tid}`);
  }

  // 並列実行用のPromiseを生成
  const taskPromises = executableTaskIds.map(async (tid) => {
    const rawTaskId = String(tid);
    const wid = `worker-${rawTaskId}`;

    try {
      // 1. Scheduler: タスク割り当て
      const claimResult = await schedulerOps.claimTask(schedulerState, rawTaskId, wid);

      if (isErr(claimResult)) {
        console.log(`  ⚠️  [${rawTaskId}] Failed to claim task: ${claimResult.err.message}`);
        return { taskId: tid, status: 'failed' as const, workerId: wid };
      }

      const { task: claimedTask, newState } = claimResult.val;
      schedulerState = newState;

      // 2. Worker: タスク実行
      console.log(`  🚀 [${rawTaskId}] Executing task...`);
      const workerResult = await workerOps.executeTaskWithWorktree(claimedTask);

      if (isErr(workerResult)) {
        const errorMsg =
          workerResult.err && typeof workerResult.err === 'object' && 'message' in workerResult.err
            ? String((workerResult.err as { message: unknown }).message)
            : String(workerResult.err);
        console.log(`  ❌ [${rawTaskId}] Task execution failed: ${errorMsg}`);
        await schedulerOps.blockTask(tid);
        return { taskId: tid, status: 'failed' as const, workerId: wid };
      }

      const result = workerResult.val;

      if (!result.success) {
        console.log(`  ❌ [${rawTaskId}] Task execution failed: ${result.error ?? 'Unknown error'}`);
        await schedulerOps.blockTask(tid);
        return { taskId: tid, status: 'failed' as const, workerId: wid };
      }

      // 3. Judge: 完了判定
      console.log(`  ⚖️  [${rawTaskId}] Judging task...`);
      const judgementResult = await judgeOps.judgeTask(tid);

      if (isErr(judgementResult)) {
        console.log(`  ❌ [${rawTaskId}] Failed to judge task: ${judgementResult.err.message}`);
        await schedulerOps.blockTask(tid);
        return { taskId: tid, status: 'failed' as const, workerId: wid };
      }

      const judgement = judgementResult.val;

      if (judgement.success) {
        console.log(`  ✅ [${rawTaskId}] Task completed: ${judgement.reason}`);
        await judgeOps.markTaskAsCompleted(tid);
        return { taskId: tid, status: 'completed' as const, workerId: wid };
      } else {
        console.log(`  ❌ [${rawTaskId}] Task failed judgement: ${judgement.reason}`);
        await judgeOps.markTaskAsBlocked(tid);
        return { taskId: tid, status: 'failed' as const, workerId: wid };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`  ❌ [${rawTaskId}] Unexpected error: ${errorMessage}`);
      await schedulerOps.blockTask(tid);
      return { taskId: tid, status: 'failed' as const, workerId: wid };
    } finally {
      // Worktreeをクリーンアップ
      const cleanupResult = await workerOps.cleanupWorktree(tid);
      if (isErr(cleanupResult)) {
        const errorMsg =
          cleanupResult.err && typeof cleanupResult.err === 'object' && 'message' in cleanupResult.err
            ? String((cleanupResult.err as { message: unknown }).message)
            : String(cleanupResult.err);
        console.warn(`  ⚠️  [${rawTaskId}] Failed to cleanup worktree: ${errorMsg}`);
      }

      // Workerスロットを解放
      schedulerState = removeRunningWorker(schedulerState, workerId(wid));
    }
  });

  // Promise.allSettled で並列実行
  const results = await Promise.allSettled(taskPromises);

  // 結果を集計
  for (const result of results) {
    if (result.status === 'fulfilled') {
      const taskResult = result.value;
      if (taskResult.status === 'completed') {
        completed.push(taskResult.taskId);
      } else {
        failed.push(taskResult.taskId);
      }
    } else {
      // Promise自体が失敗した場合（通常は発生しない）
      console.error(`  ❌ Task promise rejected: ${result.reason}`);
    }
  }

  return {
    completed,
    failed,
    blocked,
    updatedSchedulerState: schedulerState,
  };
}

/**
 * 失敗したタスクの依存先を計算してブロック対象を特定
 *
 * WHY: 依存先が失敗した場合、後続タスクは実行不可能なため事前にブロック
 *
 * @param failedTaskIds 失敗したタスクID配列
 * @param graph 依存関係グラフ
 * @returns ブロック対象タスクID配列
 */
export function computeBlockedTasks(
  failedTaskIds: TaskId[],
  graph: DependencyGraph,
): TaskId[] {
  const blockedSet = new Set<TaskId>();

  /**
   * DFSで依存先をすべて収集
   */
  function collectDependents(taskId: TaskId): void {
    const dependents = graph.reverseAdjacencyList.get(taskId) || [];
    for (const depId of dependents) {
      if (!blockedSet.has(depId)) {
        blockedSet.add(depId);
        collectDependents(depId);
      }
    }
  }

  for (const failedId of failedTaskIds) {
    collectDependents(failedId);
  }

  return Array.from(blockedSet);
}
