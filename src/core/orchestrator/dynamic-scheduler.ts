import type { TaskId, WorkerId, BranchName } from '../../types/branded.ts';
import { workerId } from '../../types/branded.ts';
import type { DependencyGraph } from './dependency-graph.ts';
import type { SchedulerOperations } from './scheduler-operations.ts';
import type { JudgeOperations } from './judge-operations.ts';
import type { SchedulerState } from './scheduler-state.ts';
import { removeRunningWorker, getAvailableSlots } from './scheduler-state.ts';
import type { createWorkerOperations } from './worker-operations.ts';
import { getTaskBranchName } from './worker-operations.ts';
import type { TaskStore } from '../task-store/interface.ts';
import { isErr } from 'option-t/plain_result';
import { computeBlockedTasks } from './parallel-executor.ts';

type WorkerOperations = ReturnType<typeof createWorkerOperations>;

/**
 * タスク実行ステータス
 *
 * WHY: タスク実行結果の種類を明示的に定義
 */
const TaskExecutionStatus = {
  COMPLETED: 'completed',
  FAILED: 'failed',
  CONTINUE: 'continue',
} as const;

type TaskExecutionStatusType = typeof TaskExecutionStatus[keyof typeof TaskExecutionStatus];

/**
 * タスク実行結果
 */
interface TaskExecutionResult {
  taskId: TaskId;
  status: TaskExecutionStatusType;
  workerId: string;
}

/**
 * 動的スケジューラの状態
 *
 * WHY: 実行中のタスクの状態を追跡し、依存関係に基づいて動的にスケジューリングする
 */
interface DynamicSchedulerState {
  /** 実行待ちタスク */
  pendingTasks: Set<TaskId>;
  /** 実行中タスク（タスクID → WorkerId） */
  runningTasks: Map<TaskId, WorkerId>;
  /** 完了タスク */
  completedTasks: Set<TaskId>;
  /** 失敗タスク */
  failedTasks: Set<TaskId>;
  /** ブロックされたタスク */
  blockedTasks: Set<TaskId>;
  /** 継続待ちタスク（NEEDS_CONTINUATIONから戻される） */
  continuationTasks: Set<TaskId>;
  /** 依存関係グラフ */
  graph: DependencyGraph;
  /** 最大Worker数 */
  maxWorkers: number;
}

/**
 * 動的実行結果
 */
export interface DynamicExecutionResult {
  /** 完了したタスクID配列 */
  completed: TaskId[];
  /** 失敗したタスクID配列 */
  failed: TaskId[];
  /** ブロックされたタスクID配列 */
  blocked: TaskId[];
  /** 更新されたスケジューラ状態 */
  updatedSchedulerState: SchedulerState;
}

/**
 * 実行可能なタスクを取得
 *
 * WHY: 依存関係が全て完了済みのタスクのみを抽出
 *
 * @param state 動的スケジューラ状態
 * @returns 実行可能なタスクID配列
 */
function getExecutableTasks(state: DynamicSchedulerState): TaskId[] {
  const executable: TaskId[] = [];

  for (const tid of state.pendingTasks) {
    // ブロックされているタスクはスキップ
    if (state.blockedTasks.has(tid)) {
      continue;
    }

    // 依存関係を確認
    const dependencies = state.graph.adjacencyList.get(tid) || [];
    const allDependenciesMet = dependencies.every(
      (depId) => state.completedTasks.has(depId) || state.blockedTasks.has(depId),
    );

    if (allDependenciesMet) {
      executable.push(tid);
    }
  }

  return executable;
}

/**
 * 単一タスクを非同期実行
 *
 * WHY: parallel-executor.tsから抽出した単一タスク実行ロジック
 * parallel-executor.tsのL115-248の処理を関数化
 *
 * @param tid タスクID
 * @param schedulerOps スケジューラ操作
 * @param workerOps ワーカー操作
 * @param judgeOps ジャッジ操作
 * @param schedulerState スケジューラ状態
 * @param taskStore タスクストア
 * @param dynamicState 動的スケジューラ状態（ベースブランチ解決に使用）
 * @returns タスク実行結果
 */
async function executeTaskAsync(
  tid: TaskId,
  schedulerOps: SchedulerOperations,
  workerOps: WorkerOperations,
  judgeOps: JudgeOperations,
  schedulerState: SchedulerState,
  taskStore: TaskStore,
): Promise<TaskExecutionResult> {
  const rawTaskId = String(tid);
  const wid = `worker-${rawTaskId}`;

  try {
    // 1. Scheduler: タスク割り当て
    const claimResult = await schedulerOps.claimTask(schedulerState, rawTaskId, wid);

    if (isErr(claimResult)) {
      console.log(`  ⚠️  [${rawTaskId}] Failed to claim task: ${claimResult.err.message}`);
      return { taskId: tid, status: TaskExecutionStatus.FAILED, workerId: wid };
    }

    const { task: claimedTask } = claimResult.val;

    // 2. Worker: タスク実行
    // WHY: タスクの依存関係から起点ブランチを解決（依存先の変更を含める）
    let baseBranch: BranchName | undefined;
    if (claimedTask.dependencies.length === 1) {
      const depId = claimedTask.dependencies[0];
      if (depId) {
        const depTaskResult = await taskStore.readTask(depId);
        if (depTaskResult.ok) {
          baseBranch = getTaskBranchName(depTaskResult.val);
        }
      }
    }
    // 複数依存の場合は将来実装（マージベース作成）

    console.log(`  🚀 [${rawTaskId}] Executing task...`);
    const workerResult = await workerOps.executeTaskWithWorktree(claimedTask, baseBranch);

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
      console.log(`  ❌ [${rawTaskId}] Task execution failed: ${result.error ?? 'Unknown error'}`);
      await schedulerOps.blockTask(tid);
      return { taskId: tid, status: TaskExecutionStatus.FAILED, workerId: wid };
    }

    // latestRunIdを更新（Judge判定でログを読むため）
    const updateResult = await taskStore.updateTaskCAS(tid, claimedTask.version, (t) => ({
      ...t,
      latestRunId: result.runId,
    }));
    if (!updateResult.ok) {
      console.error(
        `  ❌ [${rawTaskId}] Failed to update latestRunId: ${updateResult.err.message}`,
      );
      await schedulerOps.blockTask(tid);
      return { taskId: tid, status: TaskExecutionStatus.FAILED, workerId: wid };
    }

    // 3. Judge: 完了判定
    console.log(`  ⚖️  [${rawTaskId}] Judging task...`);
    const judgementResult = await judgeOps.judgeTask(tid);

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
    return { taskId: tid, status: TaskExecutionStatus.FAILED, workerId: wid };
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

    // Workerスロットを解放（外部で管理されるため、ここでは何もしない）
  }
}

/**
 * 動的スケジューリングによる並列実行
 *
 * WHY: レベルベースの静的スケジューリングから、依存関係ベースの動的スケジューリングに変更
 * タスクの依存関係が満たされ次第、ワーカーが空いていればすぐに実行開始
 *
 * @param tasks 実行対象タスク配列
 * @param graph 依存関係グラフ
 * @param schedulerOps スケジューラ操作
 * @param workerOps ワーカー操作
 * @param judgeOps ジャッジ操作
 * @param taskStore タスクストア
 * @param maxWorkers 最大Worker数
 * @returns 動的実行結果
 */
export async function executeDynamically(
  tasks: TaskId[],
  graph: DependencyGraph,
  schedulerOps: SchedulerOperations,
  workerOps: WorkerOperations,
  judgeOps: JudgeOperations,
  taskStore: TaskStore,
  maxWorkers: number,
  initialSchedulerState: SchedulerState,
  initialBlockedTasks: Set<TaskId>,
): Promise<DynamicExecutionResult> {
  // 動的スケジューラ状態を初期化
  const dynamicState: DynamicSchedulerState = {
    pendingTasks: new Set(tasks.filter((tid) => !initialBlockedTasks.has(tid))),
    runningTasks: new Map(),
    completedTasks: new Set(),
    failedTasks: new Set(),
    blockedTasks: new Set(initialBlockedTasks),
    continuationTasks: new Set(),
    graph,
    maxWorkers,
  };

  let schedulerState = initialSchedulerState;

  console.log(`\n🔨 Starting dynamic execution with ${tasks.length} tasks`);

  // メインループ: pendingまたはrunningまたはcontinuationにタスクがある間ループ
  while (
    dynamicState.pendingTasks.size > 0 ||
    dynamicState.runningTasks.size > 0 ||
    dynamicState.continuationTasks.size > 0
  ) {
    // 1. 継続タスクをpendingに戻す
    for (const tid of dynamicState.continuationTasks) {
      dynamicState.pendingTasks.add(tid);
    }
    dynamicState.continuationTasks.clear();

    // 2. 実行可能タスクを取得
    const executableTasks = getExecutableTasks(dynamicState);

    // 3. 空きスロット数を計算
    const availableSlots = getAvailableSlots(schedulerState);

    // 4. 実行可能なタスクがない、または空きスロットがない場合
    if (executableTasks.length === 0 || availableSlots === 0) {
      // 実行中タスクがある場合は待機
      if (dynamicState.runningTasks.size > 0) {
        // 実行中のタスクが完了するのを待つ
        // （実際にはPromise.raceで最初に完了したタスクを処理）
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }

      // 実行中タスクもなく、実行可能タスクもない場合
      if (dynamicState.pendingTasks.size > 0) {
        // デッドロック検出
        console.warn(
          `⚠️  Deadlock detected: ${dynamicState.pendingTasks.size} pending tasks but none are executable`,
        );
        console.warn(`   Pending tasks: ${Array.from(dynamicState.pendingTasks).join(', ')}`);

        // 残りのタスクをブロック
        for (const tid of dynamicState.pendingTasks) {
          dynamicState.blockedTasks.add(tid);
          await schedulerOps.blockTask(tid);
        }
        dynamicState.pendingTasks.clear();
      }

      break;
    }

    // 5. 空きスロット分のタスクを並列起動
    const tasksToExecute = executableTasks.slice(0, availableSlots);

    console.log(`\n🔨 Starting ${tasksToExecute.length} tasks (${availableSlots} slots available)`);
    for (const tid of tasksToExecute) {
      console.log(`  - ${tid}`);
    }

    // タスクを実行中に追加
    for (const tid of tasksToExecute) {
      dynamicState.runningTasks.set(tid, workerId(`worker-${String(tid)}`));
      dynamicState.pendingTasks.delete(tid);
    }

    // 並列実行
    const taskPromises = tasksToExecute.map((tid) =>
      executeTaskAsync(tid, schedulerOps, workerOps, judgeOps, schedulerState, taskStore),
    );

    // 6. いずれかのタスクが完了するのを待つ
    const results = await Promise.allSettled(taskPromises);

    // 7. 完了タスクの結果を処理
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { taskId, status } = result.value;

        // runningTasksから削除
        dynamicState.runningTasks.delete(taskId);
        schedulerState = removeRunningWorker(schedulerState, workerId(`worker-${String(taskId)}`));

        if (status === TaskExecutionStatus.COMPLETED) {
          dynamicState.completedTasks.add(taskId);
        } else if (status === TaskExecutionStatus.FAILED) {
          dynamicState.failedTasks.add(taskId);

          // 失敗タスクの依存先をブロック
          const blockedTasks = computeBlockedTasks([taskId], graph);
          if (blockedTasks.length > 0) {
            console.log(
              `  ⚠️  Blocking ${blockedTasks.length} dependent tasks due to failure: ${blockedTasks.map((id) => String(id)).join(', ')}`,
            );
            for (const tid of blockedTasks) {
              dynamicState.blockedTasks.add(tid);
              dynamicState.pendingTasks.delete(tid);
              await schedulerOps.blockTask(tid);
            }
          }
        } else if (status === TaskExecutionStatus.CONTINUE) {
          // 継続タスクとして記録（次のループでpendingに戻る）
          dynamicState.continuationTasks.add(taskId);
        }
      } else {
        // Promise自体が失敗した場合
        console.error(`  ❌ Task promise rejected: ${result.reason}`);
      }
    }
  }

  console.log(
    `\n✅ Dynamic execution completed: ${dynamicState.completedTasks.size} completed, ${dynamicState.failedTasks.size} failed, ${dynamicState.blockedTasks.size} blocked`,
  );

  return {
    completed: Array.from(dynamicState.completedTasks),
    failed: Array.from(dynamicState.failedTasks),
    blocked: Array.from(dynamicState.blockedTasks),
    updatedSchedulerState: schedulerState,
  };
}
