import type { TaskId, WorkerId } from '../../types/branded.ts';
import { workerId, taskId, branchName } from '../../types/branded.ts';
import type { DependencyGraph } from './dependency-graph.ts';
import type { SchedulerOperations } from './scheduler-operations.ts';
import type { JudgeOperations } from './judge-operations.ts';
import type { SchedulerState } from './scheduler-state.ts';
import { removeRunningWorker, getAvailableSlots } from './scheduler-state.ts';
import type { createWorkerOperations } from './worker-operations.ts';
import type { TaskStore } from '../task-store/interface.ts';
import { isErr } from 'option-t/plain_result';
import { computeBlockedTasks } from './parallel-executor.ts';
import type { createBaseBranchResolver } from './base-branch-resolver.ts';
import { TaskState } from '../../types/task.ts';
import { truncateSummary } from './utils/log-utils.ts';
import { TaskExecutionStatus, type TaskExecutionResult } from './task-execution-status.ts';
import type { PlannerDeps } from './planner-operations.ts';
import { replanFailedTask, markTaskAsReplanned } from './replanning-operations.ts';

type WorkerOperations = ReturnType<typeof createWorkerOperations>;
type BaseBranchResolver = ReturnType<typeof createBaseBranchResolver>;

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
  /** 実行中タスクのPromise（タスクID → Promise） */
  runningPromises: Map<TaskId, Promise<TaskExecutionResult>>;
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
 * @param baseBranchResolver ベースブランチ解決器
 * @param plannerDeps Planner依存関係（再評価に必要）
 * @returns タスク実行結果
 */
async function executeTaskAsync(
  tid: TaskId,
  schedulerOps: SchedulerOperations,
  workerOps: WorkerOperations,
  judgeOps: JudgeOperations,
  schedulerState: SchedulerState,
  taskStore: TaskStore,
  baseBranchResolver: BaseBranchResolver,
  plannerDeps: PlannerDeps,
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

    // 2. BaseBranchResolver: ベースブランチ解決
    // WHY: タスクの依存関係から起点ブランチを解決（依存先の変更を含める）
    // 複数依存の場合は一時マージブランチを作成（コンフリクト時はエラー）
    const baseBranchResolution = await baseBranchResolver.resolveBaseBranch(claimedTask);

    if (isErr(baseBranchResolution)) {
      // resolveBaseBranchは常に成功を返すはずだが、念のためエラー処理を残す
      console.log(
        `  ❌ [${rawTaskId}] Failed to resolve base branch: ${baseBranchResolution.err.message}`,
      );
      await schedulerOps.blockTask(tid);
      return { taskId: tid, status: TaskExecutionStatus.FAILED, workerId: wid };
    }

    const resolution = baseBranchResolution.val;

    // 3. Worker: タスク実行
    const summaryText = claimedTask.summary ? ` - ${truncateSummary(claimedTask.summary)}` : '';
    console.log(`  🚀 [${rawTaskId}]${summaryText} Executing task...`);
    const workerResult = await workerOps.executeTaskWithWorktree(claimedTask, resolution);

    if (isErr(workerResult)) {
      // ConflictResolutionRequiredエラーの場合は特別処理
      if (
        workerResult.err &&
        typeof workerResult.err === 'object' &&
        'type' in workerResult.err &&
        workerResult.err.type === 'ConflictResolutionRequiredError'
      ) {
        const conflictErr = workerResult.err as {
          type: 'ConflictResolutionRequiredError';
          conflictTaskId: string;
          tempBranch: string;
        };
        const { conflictTaskId, tempBranch } = conflictErr;

        console.log(
          `  ⚠️  [${rawTaskId}] Conflict detected, scheduling resolution task: ${conflictTaskId}`,
        );

        // 元タスクを一時停止（BLOCKED with reason）
        const updateResult = await taskStore.updateTaskCAS(tid, claimedTask.version, (t) => ({
          ...t,
          state: TaskState.BLOCKED,
          owner: null, // ワーカーを解放
          pendingConflictResolution: {
            conflictTaskId: taskId(conflictTaskId),
            tempBranch: branchName(tempBranch),
          },
          updatedAt: new Date().toISOString(),
        }));

        if (isErr(updateResult)) {
          console.warn(
            `  ⚠️  [${rawTaskId}] Failed to update task state: ${updateResult.err.message}`,
          );
        }

        // ConflictResolutionRequiredエラーを返す（呼び出し元でpendingTasksに追加）
        return { taskId: tid, status: TaskExecutionStatus.FAILED, workerId: wid };
      }

      // その他のエラー
      const errorMsg =
        workerResult.err && typeof workerResult.err === 'object' && 'message' in workerResult.err
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

    // 4. Judge: 完了判定
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
    } else if (judgement.shouldReplan) {
      // Planner再評価が必要
      console.log(`  🔄 [${rawTaskId}] Task needs replanning: ${judgement.reason}`);
      if (judgement.missingRequirements && judgement.missingRequirements.length > 0) {
        console.log(`     Missing: ${judgement.missingRequirements.join(', ')}`);
      }

      // 1. 実行ログを取得
      const logResult = await plannerDeps.runnerEffects.readLog(result.runId);
      if (!logResult.ok) {
        console.error(`  ❌ [${rawTaskId}] Failed to read log for replanning: ${logResult.err.message}`);
        await judgeOps.markTaskAsBlocked(tid);
        return { taskId: tid, status: TaskExecutionStatus.FAILED, workerId: wid };
      }

      // 2. Planner再評価を呼び出し
      const replanResult = await replanFailedTask(
        plannerDeps,
        claimedTask,
        logResult.val,
        judgement,
      );

      if (!replanResult.ok) {
        console.error(`  ❌ [${rawTaskId}] Replanning failed: ${replanResult.err.message}`);
        await judgeOps.markTaskAsBlocked(tid);
        return { taskId: tid, status: TaskExecutionStatus.FAILED, workerId: wid };
      }

      const newTaskIds = replanResult.val.taskIds;
      console.log(`  ✅ [${rawTaskId}] Generated ${newTaskIds.length} new tasks from replanning`);

      // 3. 元タスクをREPLACED_BY_REPLANにマーク
      const maxReplanIterations = 3;
      const markResult = await markTaskAsReplanned(
        taskStore,
        tid,
        newTaskIds,
        judgement,
        maxReplanIterations,
      );

      if (!markResult.ok) {
        // 最大リトライ回数超過 → BLOCKED
        console.log(`  ❌ [${rawTaskId}] ${markResult.err.message}`);
        await judgeOps.markTaskAsBlocked(tid);
        return { taskId: tid, status: TaskExecutionStatus.FAILED, workerId: wid };
      }

      // WHY: 新タスクは次のスケジューリングサイクルで自動ピックアップされる
      console.log(`  ➡️  [${rawTaskId}] New tasks queued for execution`);
      return { taskId: tid, status: TaskExecutionStatus.REPLANNED, workerId: wid };
    } else {
      // 完全失敗（shouldContinue=false && shouldReplan=false）
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
        cleanupResult.err && typeof cleanupResult.err === 'object' && 'message' in cleanupResult.err
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
 * 実装の特徴:
 * 1. Promise.raceによるイベント駆動型スケジューリング
 *    - どれか1つのタスクが完了した瞬間に次のアクションを取る
 *    - Promise.allSettledと異なり、全タスク完了を待たない
 * 2. 空きスロットの即座活用
 *    - タスクが完了してスロットが空いたら、即座に次のタスクを起動
 *    - 常に最大並列度を維持することで実行時間を最小化
 * 3. 実行中タスクの追跡
 *    - runningPromises Mapで実行中のPromiseを管理
 *    - 完了したタスクを特定して結果を処理
 *
 * @param tasks 実行対象タスク配列
 * @param graph 依存関係グラフ
 * @param schedulerOps スケジューラ操作
 * @param workerOps ワーカー操作
 * @param judgeOps ジャッジ操作
 * @param taskStore タスクストア
 * @param maxWorkers 最大Worker数
 * @param baseBranchResolver ベースブランチ解決器
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
  baseBranchResolver: BaseBranchResolver,
  plannerDeps: PlannerDeps,
): Promise<DynamicExecutionResult> {
  // 動的スケジューラ状態を初期化
  const dynamicState: DynamicSchedulerState = {
    pendingTasks: new Set(tasks.filter((tid) => !initialBlockedTasks.has(tid))),
    runningTasks: new Map(),
    runningPromises: new Map(),
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
    dynamicState.runningPromises.size > 0 ||
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

    // 4. 空きスロット分のタスクを新規起動
    if (executableTasks.length > 0 && availableSlots > 0) {
      const tasksToExecute = executableTasks.slice(0, availableSlots);

      console.log(
        `\n🔨 Starting ${tasksToExecute.length} tasks (${availableSlots} slots available)`,
      );
      for (const tid of tasksToExecute) {
        const taskResult = await taskStore.readTask(tid);
        if (taskResult.ok) {
          const summaryText = taskResult.val.summary ? ` - ${truncateSummary(taskResult.val.summary)}` : '';
          console.log(`  - ${tid}${summaryText}`);
        } else {
          console.log(`  - ${tid}`);
        }
      }

      // タスクを実行中に追加し、Promiseを保存
      for (const tid of tasksToExecute) {
        dynamicState.runningTasks.set(tid, workerId(`worker-${String(tid)}`));
        dynamicState.pendingTasks.delete(tid);

        // タスク実行をPromiseとして保存
        const taskPromise = executeTaskAsync(
          tid,
          schedulerOps,
          workerOps,
          judgeOps,
          schedulerState,
          taskStore,
          baseBranchResolver,
          plannerDeps,
        );
        dynamicState.runningPromises.set(tid, taskPromise);
      }
    }

    // 5. 実行中タスクがあれば、いずれか1つが完了するまで待つ
    if (dynamicState.runningPromises.size > 0) {
      // Promise.raceでどれか1つ完了するまで待つ
      // どのタスクが完了したか識別するため、taskIdを一緒に返す
      const promiseEntries = Array.from(dynamicState.runningPromises.entries()).map(
        ([tid, promise]) => promise.then((result) => ({ taskId: tid, result })),
      );

      const { taskId, result } = await Promise.race(promiseEntries);

      // 完了したタスクをrunningから削除
      dynamicState.runningPromises.delete(taskId);
      dynamicState.runningTasks.delete(taskId);
      schedulerState = removeRunningWorker(schedulerState, workerId(`worker-${String(taskId)}`));

      // 6. 結果を処理
      if (result.status === TaskExecutionStatus.COMPLETED) {
        dynamicState.completedTasks.add(taskId);
      } else if (result.status === TaskExecutionStatus.FAILED) {
        // タスクがBLOCKED状態でpendingConflictResolutionを持つ場合、
        // コンフリクト解消タスクをpendingTasksに追加
        const taskResult = await taskStore.readTask(taskId);
        if (taskResult.ok && taskResult.val.pendingConflictResolution) {
          const conflictTaskId = taskResult.val.pendingConflictResolution.conflictTaskId;
          console.log(
            `  🔄 [${String(taskId)}] Added conflict resolution task to pending: ${conflictTaskId}`,
          );
          dynamicState.pendingTasks.add(conflictTaskId);
          // 元タスクはブロック済みなのでfailedには追加しない
          dynamicState.blockedTasks.add(taskId);
        } else {
          // 通常の失敗
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
        }
      } else if (result.status === TaskExecutionStatus.CONTINUE) {
        // 継続タスクとして記録（次のループでpendingに戻る）
        dynamicState.continuationTasks.add(taskId);
      }

      // すぐに次のループに戻る（空きができたので次のタスクを起動できる）
      continue;
    }

    // 7. 実行中タスクもなく、実行可能タスクもない場合（デッドロック検出）
    if (dynamicState.pendingTasks.size > 0) {
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

    // 実行中タスクもなく、pendingも空になったら終了
    break;
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
