import type { TaskId, BranchName } from '../../types/branded.ts';
import type { DependencyGraph } from './dependency-graph.ts';
import type { SchedulerOperations } from './scheduler-operations.ts';
import type { JudgeOperations } from './judge-operations.ts';
import type { SchedulerState } from './scheduler-state.ts';
import { workerId } from '../../types/branded.ts';
import { isErr } from 'option-t/plain_result';
import { removeRunningWorker } from './scheduler-state.ts';
import type { createWorkerOperations } from './worker-operations.ts';
import type { TaskStore } from '../task-store/interface.ts';
import { TaskState } from '../../types/task.ts';
import type { BaseBranchResolution } from './base-branch-resolver.ts';

type WorkerOperations = ReturnType<typeof createWorkerOperations>;

/**
 * タスク実行ステータス
 *
 * WHY: タスク実行結果の種類を明示的に定義し、一貫性を保つため
 */
const TaskExecutionStatus = {
  COMPLETED: 'completed',
  FAILED: 'failed',
  CONTINUE: 'continue',
} as const;

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
 * @param taskStore タスクストア（依存関係解決に使用）
 * @returns レベル実行結果
 */
export async function executeLevelParallel(
  levelTaskIds: TaskId[],
  schedulerOps: SchedulerOperations,
  workerOps: WorkerOperations,
  judgeOps: JudgeOperations,
  schedulerState: SchedulerState,
  blockedTaskIds: Set<TaskId>,
  taskStore: TaskStore,
): Promise<LevelExecutionResult> {
  const completed: TaskId[] = [];
  const failed: TaskId[] = [];
  const blocked: TaskId[] = [];

  // WHY: 実行対象を追跡（最初はlevelTaskIdsから開始）
  // NEEDS_CONTINUATION タスクの継続実行をサポートするため、内部でループを持つ
  let pendingTaskIds = new Set(levelTaskIds);

  // WHY: 全タスクがDONE/BLOCKED/FAILEDになるまでループ
  // これにより、NEEDS_CONTINUATION 状態のタスクのみが再実行される
  while (pendingTaskIds.size > 0) {
    // 1. 現在実行可能なタスク（READY or NEEDS_CONTINUATION）をフィルタ
    const executableTaskIds: TaskId[] = [];
    for (const tid of pendingTaskIds) {
      if (blockedTaskIds.has(tid)) {
        blocked.push(tid);
        pendingTaskIds.delete(tid);
        continue;
      }
      const taskResult = await taskStore.readTask(tid);
      if (!taskResult.ok) {
        failed.push(tid);
        pendingTaskIds.delete(tid);
        continue;
      }
      const task = taskResult.val;
      if (task.state === TaskState.READY || task.state === TaskState.NEEDS_CONTINUATION) {
        executableTaskIds.push(tid);
      } else if (task.state === TaskState.DONE) {
        completed.push(tid);
        pendingTaskIds.delete(tid);
      } else if (task.state === TaskState.BLOCKED || task.state === TaskState.CANCELLED) {
        blocked.push(tid);
        pendingTaskIds.delete(tid);
      }
      // RUNNING は待機（他のworkerが処理中）
    }

    if (executableTaskIds.length === 0) {
      break; // 実行可能なタスクがない
    }

    // 2. 実行可能なタスクを並列実行
    console.log(`\n🔨 Executing ${executableTaskIds.length} tasks in parallel`);
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
          return { taskId: tid, status: TaskExecutionStatus.FAILED, workerId: wid };
        }

        const { task: claimedTask, newState } = claimResult.val;
        schedulerState = newState;

        // 2. Worker: タスク実行
        // WHY: タスクの依存関係から起点ブランチを解決（依存先の変更を含める）
        let resolution: BaseBranchResolution;

        if (claimedTask.dependencies.length === 0) {
          resolution = { type: 'none' };
        } else if (claimedTask.dependencies.length === 1) {
          const depId = claimedTask.dependencies[0];
          if (depId) {
            const depTaskResult = await taskStore.readTask(depId);
            if (depTaskResult.ok) {
              resolution = { type: 'single', baseBranch: depTaskResult.val.branch };
            } else {
              console.log(
                `  ❌ [${rawTaskId}] Failed to read dependency task: ${depTaskResult.err.message}`,
              );
              await schedulerOps.blockTask(tid);
              return { taskId: tid, status: TaskExecutionStatus.FAILED, workerId: wid };
            }
          } else {
            // 依存タスクIDがundefinedの場合（通常は発生しない）
            console.log(`  ❌ [${rawTaskId}] Invalid dependency task ID`);
            await schedulerOps.blockTask(tid);
            return { taskId: tid, status: TaskExecutionStatus.FAILED, workerId: wid };
          }
        } else {
          // 複数依存の場合はブランチリストを構築
          const dependencyBranches: BranchName[] = [];
          for (const depId of claimedTask.dependencies) {
            const depTaskResult = await taskStore.readTask(depId);
            if (depTaskResult.ok) {
              dependencyBranches.push(depTaskResult.val.branch);
            } else {
              console.log(
                `  ❌ [${rawTaskId}] Failed to read dependency task: ${depTaskResult.err.message}`,
              );
              await schedulerOps.blockTask(tid);
              return { taskId: tid, status: TaskExecutionStatus.FAILED, workerId: wid };
            }
          }
          resolution = { type: 'multi', dependencyBranches };
        }

        console.log(`  🚀 [${rawTaskId}] Executing task...`);
        const workerResult = await workerOps.executeTaskWithWorktree(claimedTask, resolution);

        if (isErr(workerResult)) {
          const errorMsg =
            workerResult.err &&
            typeof workerResult.err === 'object' &&
            'message' in workerResult.err
              ? String((workerResult.err as { message: unknown }).message)
              : String(workerResult.err);
          console.log(`  ❌ [${rawTaskId}] Task execution failed: ${errorMsg}`);
          await schedulerOps.blockTask(tid);
          return { taskId: tid, status: TaskExecutionStatus.FAILED, workerId: wid };
        }

        const result = workerResult.val;

        if (!result.success) {
          console.log(
            `  ❌ [${rawTaskId}] Task execution failed: ${result.error ?? 'Unknown error'}`,
          );
          await schedulerOps.blockTask(tid);
          return { taskId: tid, status: TaskExecutionStatus.FAILED, workerId: wid };
        }

        // 3. Judge: 完了判定
        console.log(`  ⚖️  [${rawTaskId}] Judging task...`);
        const judgementResult = await judgeOps.judgeTask(tid, result.runId);

        if (isErr(judgementResult)) {
          console.log(`  ❌ [${rawTaskId}] Failed to judge task: ${judgementResult.err.message}`);
          await schedulerOps.blockTask(tid);
          return { taskId: tid, status: TaskExecutionStatus.FAILED, workerId: wid };
        }

        const judgement = judgementResult.val;

        if (judgement.success) {
          console.log(`  ✅ [${rawTaskId}] Task completed: ${judgement.reason}`);
          await judgeOps.markTaskAsCompleted(tid);
          return { taskId: tid, status: TaskExecutionStatus.COMPLETED, workerId: wid };
        } else if (judgement.shouldContinue) {
          // 継続実行可能な場合、タスクをREADY状態に戻す
          console.log(`  🔄 [${rawTaskId}] Task needs continuation: ${judgement.reason}`);
          if (judgement.missingRequirements && judgement.missingRequirements.length > 0) {
            console.log(`     Missing: ${judgement.missingRequirements.join(', ')}`);
          }

          const continuationResult = await judgeOps.markTaskForContinuation(tid, judgement);
          if (isErr(continuationResult)) {
            // 最大リトライ回数を超えた場合
            console.log(
              `  ❌ [${rawTaskId}] Exceeded max iterations, marking as blocked: ${continuationResult.err.message}`,
            );
            await judgeOps.markTaskAsBlocked(tid);
            return { taskId: tid, status: TaskExecutionStatus.FAILED, workerId: wid };
          }

          console.log(
            `  ➡️  [${rawTaskId}] Scheduled for re-execution (iteration ${continuationResult.val.judgementFeedback?.iteration ?? 0})`,
          );
          return { taskId: tid, status: TaskExecutionStatus.CONTINUE, workerId: wid };
        } else {
          console.log(`  ❌ [${rawTaskId}] Task failed judgement: ${judgement.reason}`);
          await judgeOps.markTaskAsBlocked(tid);
          return { taskId: tid, status: TaskExecutionStatus.FAILED, workerId: wid };
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
            cleanupResult.err &&
            typeof cleanupResult.err === 'object' &&
            'message' in cleanupResult.err
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

    // 3. 結果に基づいてpendingTaskIdsを更新
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { taskId, status } = result.value;
        if (status === TaskExecutionStatus.COMPLETED) {
          completed.push(taskId);
          pendingTaskIds.delete(taskId);
        } else if (status === TaskExecutionStatus.FAILED) {
          failed.push(taskId);
          pendingTaskIds.delete(taskId);
        }
        // status === TaskExecutionStatus.CONTINUE の場合はpendingに残す → 次のループで再実行
      } else {
        // Promise自体が失敗した場合（通常は発生しない）
        console.error(`  ❌ Task promise rejected: ${result.reason}`);
      }
    }
  } // while ループの終了

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
export function computeBlockedTasks(failedTaskIds: TaskId[], graph: DependencyGraph): TaskId[] {
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
