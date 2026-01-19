/**
 * Serial Executor - 直列チェーンのタスクを実行
 *
 * WHY: 直列チェーン（A→B→Cのような連続依存）のタスクは同じworktreeを共有し、
 *      前のタスクの変更を次のタスクに引き継ぐことで、効率的かつ正確に実行できる
 */

import type { TaskId, WorktreePath } from '../../types/branded.ts';
import type { TaskStore } from '../task-store/interface.ts';
import type { SchedulerOperations } from './scheduler-operations.ts';
import type { JudgeOperations } from './judge-operations.ts';
import type { SchedulerState } from './scheduler-state.ts';
import { workerId } from '../../types/branded.ts';
import { isErr } from 'option-t/plain_result';
import { removeRunningWorker } from './scheduler-state.ts';
import type { createWorkerOperations } from './worker-operations.ts';

type WorkerOperations = ReturnType<typeof createWorkerOperations>;

/**
 * 直列チェーン実行結果
 *
 * WHY: 実行結果を追跡し、失敗時の処理を適切に行うため
 */
export interface SerialChainExecutionResult {
  /** 完了したタスクID配列 */
  completed: TaskId[];
  /** 失敗したタスクID配列 */
  failed: TaskId[];
  /** チェーン内の最初のタスクのworktreeパス（クリーンアップ用） */
  worktreePath: WorktreePath | null;
  /** 更新されたスケジューラ状態 */
  updatedSchedulerState: SchedulerState;
}

/**
 * 直列チェーンを実行
 *
 * WHY: 直列チェーンのタスクは同じworktreeを共有することで、前のタスクの変更を引き継げる
 *
 * 実行フロー:
 * 1. 最初のタスクで新しいworktreeを作成
 * 2. 各タスクを順番に実行（前のタスクの出力を次のタスクに渡す）
 * 3. 各タスク後に変更をコミット（前のタスクの変更を保持）
 * 4. 失敗時は後続タスクをスキップし、チェーン実行を中断
 * 5. 最後にリモートにpush
 *
 * @param chain 直列チェーン（TaskIdの配列）
 * @param taskStore タスクストア
 * @param schedulerOps スケジューラ操作
 * @param workerOps ワーカー操作
 * @param judgeOps ジャッジ操作
 * @param schedulerState 現在のスケジューラ状態
 * @param serialChainTaskRetries タスク実行の最大リトライ回数
 * @returns 直列チェーン実行結果
 */
export async function executeSerialChain(
  chain: TaskId[],
  taskStore: TaskStore,
  schedulerOps: SchedulerOperations,
  workerOps: WorkerOperations,
  judgeOps: JudgeOperations,
  schedulerState: SchedulerState,
  serialChainTaskRetries: number,
): Promise<SerialChainExecutionResult> {
  const completed: TaskId[] = [];
  const failed: TaskId[] = [];
  let worktreePath: WorktreePath | null = null;
  let previousFeedback: string | undefined = undefined;

  console.log(`\n🔗 Executing serial chain with ${chain.length} tasks`);
  for (const tid of chain) {
    console.log(`  - ${tid}`);
  }

  for (let i = 0; i < chain.length; i++) {
    const tid = chain[i];
    if (!tid) continue; // 型安全性のためのガード（実際には発生しない）
    const rawTaskId = String(tid);
    const wid = `worker-serial-${rawTaskId}`;

    // 継続実行のための内部ループ
    let shouldRetry = true;
    let retryCount = 0;

    while (shouldRetry && retryCount < serialChainTaskRetries) {
      shouldRetry = false; // デフォルトでリトライしない

      try {
        // スケジューラにタスクを要求（内部でタスク読み込み + CAS更新）
        const claimResult = await schedulerOps.claimTask(schedulerState, rawTaskId, wid);

        if (isErr(claimResult)) {
          console.log(`  ⚠️  [${rawTaskId}] Failed to claim task: ${claimResult.err.message}`);
          failed.push(tid);
          break;
        }

        const { newState, task: claimedTask } = claimResult.val;
        schedulerState = newState;

        // 最初のタスク: 新しいworktreeを作成
        if (i === 0 && retryCount === 0) {
          console.log(`  🚀 [${rawTaskId}] Creating worktree and executing first task...`);
          const setupResult = await workerOps.setupWorktree(claimedTask);
          if (isErr(setupResult)) {
            console.log(
              `  ❌ [${rawTaskId}] Failed to create worktree: ${setupResult.err.message}`,
            );
            await schedulerOps.blockTask(tid);
            failed.push(tid);
            break;
          }
          worktreePath = setupResult.val;

          // タスク実行
          const runResult = await workerOps.executeTask(claimedTask, worktreePath);
          if (isErr(runResult) || !runResult.val.success) {
            const errorMsg = isErr(runResult)
              ? runResult.err.message
              : (runResult.val.error ?? 'Unknown error');
            console.log(`  ❌ [${rawTaskId}] Task execution failed: ${errorMsg}`);
            await schedulerOps.blockTask(tid);
            failed.push(tid);
            break;
          }

          previousFeedback = runResult.val.runId; // 次のタスクに渡す
        } else {
          // 後続タスク or リトライ: 既存のworktreeを再利用
          console.log(`  🚀 [${rawTaskId}] Executing task in existing worktree...`);
          const runResult = await workerOps.executeTaskInExistingWorktree(
            claimedTask,
            worktreePath!,
            previousFeedback,
          );
          if (isErr(runResult) || !runResult.val.success) {
            const errorMsg = isErr(runResult)
              ? runResult.err.message
              : (runResult.val.error ?? 'Unknown error');
            console.log(`  ❌ [${rawTaskId}] Task execution failed: ${errorMsg}`);
            await schedulerOps.blockTask(tid);
            failed.push(tid);
            break;
          }

          previousFeedback = runResult.val.runId;
        }

        // 変更をコミット
        if (worktreePath) {
          const commitResult = await workerOps.commitChanges(claimedTask, worktreePath);
          if (isErr(commitResult)) {
            console.log(
              `  ❌ [${rawTaskId}] Failed to commit changes: ${commitResult.err.message}`,
            );
            await schedulerOps.blockTask(tid);
            failed.push(tid);
            break;
          }
        }

        // latestRunIdを更新（Judge判定でログを読むため）
        const updateResult = await taskStore.updateTaskCAS(tid, claimedTask.version, (t) => ({
          ...t,
          latestRunId: previousFeedback ?? '',
        }));
        if (!updateResult.ok) {
          console.error(
            `  ❌ [${rawTaskId}] Failed to update latestRunId: ${updateResult.err.message}`,
          );
          await schedulerOps.blockTask(tid);
          failed.push(tid);
          break;
        }

        // Judge判定
        console.log(`  ⚖️  [${rawTaskId}] Judging task...`);
        const judgementResult = await judgeOps.judgeTask(tid);
        if (isErr(judgementResult)) {
          console.log(`  ❌ [${rawTaskId}] Failed to judge task: ${judgementResult.err.message}`);
          await schedulerOps.blockTask(tid);
          failed.push(tid);
          break;
        }

        const judgement = judgementResult.val;
        if (judgement.success) {
          console.log(`  ✅ [${rawTaskId}] Task completed: ${judgement.reason}`);
          await judgeOps.markTaskAsCompleted(tid);
          completed.push(tid);
        } else if (judgement.shouldContinue) {
          // 継続実行可能な場合
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
            failed.push(tid);
            break; // チェーン実行を中断
          }

          console.log(
            `  ➡️  [${rawTaskId}] Re-executing task (iteration ${continuationResult.val.judgementFeedback?.iteration ?? 0})`,
          );
          shouldRetry = true;
          retryCount++;
          previousFeedback = continuationResult.val.judgementFeedback?.lastJudgement.reason;
        } else {
          console.log(`  ❌ [${rawTaskId}] Task failed judgement: ${judgement.reason}`);
          await judgeOps.markTaskAsBlocked(tid);
          failed.push(tid);
          break; // チェーン実行を中断
        }

        // Workerスロットを解放
        schedulerState = removeRunningWorker(schedulerState, workerId(wid));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`  ❌ [${rawTaskId}] Unexpected error: ${errorMessage}`);
        await schedulerOps.blockTask(tid);
        failed.push(tid);
        break;
      }
    } // while (shouldRetry)

    // リトライループを抜けた後、失敗していればチェーンを中断
    if (failed.includes(tid)) {
      break;
    }
  }

  // 最後にpush
  if (completed.length > 0 && worktreePath) {
    const pushResult = await workerOps.pushChanges(worktreePath);
    if (isErr(pushResult)) {
      console.warn(`  ⚠️  Failed to push changes: ${pushResult.err.message}`);
    }
  }

  return {
    completed,
    failed,
    worktreePath,
    updatedSchedulerState: schedulerState,
  };
}
