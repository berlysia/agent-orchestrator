/**
 * Serial Executor - 直列チェーンのタスクを実行
 *
 * WHY: 直列チェーン（A→B→Cのような連続依存）のタスクは同じworktreeを共有し、
 *      前のタスクの変更を次のタスクに引き継ぐことで、効率的かつ正確に実行できる
 */

import type { TaskId, WorktreePath } from '../../types/branded.ts';
import { repoPath } from '../../types/branded.ts';
import type { TaskStore } from '../task-store/interface.ts';
import type { SchedulerOperations } from './scheduler-operations.ts';
import type { JudgeOperations } from './judge-operations.ts';
import type { SchedulerState } from './scheduler-state.ts';
import type { GitEffects } from '../../adapters/vcs/git-effects.ts';
import { workerId } from '../../types/branded.ts';
import { isErr } from 'option-t/plain_result';
import { removeRunningWorker } from './scheduler-state.ts';
import type { createWorkerOperations } from './worker-operations.ts';
import { truncateSummary } from './utils/log-utils.ts';
import type { PlannerDeps } from './planner-operations.ts';
import { replanFailedTask, markTaskAsReplanned } from './replanning-operations.ts';
import { BlockReason } from '../../types/task.ts';
import { loadTasks } from './task-helpers.ts';

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
 * @param gitEffects Git操作
 * @param schedulerState 現在のスケジューラ状態
 * @param serialChainTaskRetries タスク実行の最大リトライ回数
 * @param plannerDeps Planner依存関係（再評価に必要）
 * @returns 直列チェーン実行結果
 */
export async function executeSerialChain(
  chain: TaskId[],
  taskStore: TaskStore,
  schedulerOps: SchedulerOperations,
  workerOps: WorkerOperations,
  judgeOps: JudgeOperations,
  gitEffects: GitEffects,
  schedulerState: SchedulerState,
  serialChainTaskRetries: number,
  plannerDeps: PlannerDeps,
): Promise<SerialChainExecutionResult> {
  const completed: TaskId[] = [];
  const failed: TaskId[] = [];
  let worktreePath: WorktreePath | null = null;
  let previousFeedback: string | undefined = undefined;

  console.log(`\n🔗 Executing serial chain with ${chain.length} tasks`);
  for (const tid of chain) {
    const taskResult = await taskStore.readTask(tid);
    if (taskResult.ok) {
      const summaryText = taskResult.val.summary ? ` - ${truncateSummary(taskResult.val.summary)}` : '';
      console.log(`  - ${tid}${summaryText}`);
    } else {
      console.log(`  - ${tid}`);
    }
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

        const { newState } = claimResult.val;
        let claimedTask = claimResult.val.task;
        schedulerState = newState;

        // 最初のタスク: 新しいworktreeを作成
        if (i === 0 && retryCount === 0) {
          const summaryText = claimedTask.summary ? ` - ${truncateSummary(claimedTask.summary)}` : '';
          console.log(`  🚀 [${rawTaskId}]${summaryText} Creating worktree and executing first task...`);
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
          const summaryText = claimedTask.summary ? ` - ${truncateSummary(claimedTask.summary)}` : '';
          console.log(`  🚀 [${rawTaskId}]${summaryText} Executing task in existing worktree...`);

          // WHY: serial chainでは全タスクが最初のタスクのブランチを共有するため、
          // 後続タスクのtask.branchを実際のブランチ名に更新する必要がある。
          // これにより、依存関係を持つ並列タスクが正しいブランチを参照できる。
          const actualBranchResult = await gitEffects.getCurrentBranch(repoPath(worktreePath!));
          if (actualBranchResult.ok && actualBranchResult.val !== claimedTask.branch) {
            const updateBranchResult = await taskStore.updateTaskCAS(
              tid,
              claimedTask.version,
              (t) => ({
                ...t,
                branch: actualBranchResult.val,
              }),
            );
            if (updateBranchResult.ok) {
              // 更新後のタスクを使用
              claimedTask = updateBranchResult.val;
            }
          }

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

        const runIdForJudgement = previousFeedback;
        if (!runIdForJudgement) {
          console.error(`  ❌ [${rawTaskId}] Missing runId for judgement`);
          await schedulerOps.blockTask(tid);
          failed.push(tid);
          break;
        }

        // Judge判定
        // WHY: worktreePathを渡すことで、Judgeがgit変更情報を取得できる
        console.log(`  ⚖️  [${rawTaskId}] Judging task...`);
        const judgementResult = await judgeOps.judgeTask(
          tid,
          runIdForJudgement,
          worktreePath ?? undefined,
        );
        if (isErr(judgementResult)) {
          console.log(`  ❌ [${rawTaskId}] Failed to judge task: ${judgementResult.err.message}`);
          await schedulerOps.blockTask(tid);
          failed.push(tid);
          break;
        }

        const judgement = judgementResult.val;
        // WHY: 直列チェーン内の進捗状況を表示（完了数/チェーン内タスク数）
        const chainProgress = `[${i + 1}/${chain.length}]`;

        if (judgement.success) {
          if (judgement.alreadySatisfied) {
            console.log(`  ⏭️  ${chainProgress} ${rawTaskId} skipped (already satisfied): ${judgement.reason}`);
            await judgeOps.markTaskAsSkipped(tid, judgement.reason);
            completed.push(tid);
          } else {
            console.log(`  ✅ ${chainProgress} ${rawTaskId} completed: ${judgement.reason}`);
            await judgeOps.markTaskAsCompleted(tid);
            completed.push(tid);
          }
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
            await judgeOps.markTaskAsBlocked(tid, {
              reason: BlockReason.MAX_RETRIES,
              message: `Exceeded max retry iterations: ${continuationResult.err.message}`,
            });
            failed.push(tid);
            break; // チェーン実行を中断
          }

          console.log(
            `  ➡️  [${rawTaskId}] Re-executing task (iteration ${continuationResult.val.judgementFeedback?.iteration ?? 0})`,
          );
          shouldRetry = true;
          retryCount++;
          previousFeedback = continuationResult.val.judgementFeedback?.lastJudgement.reason;
        } else if (judgement.shouldReplan) {
          // Planner再評価が必要
          console.log(`  🔄 [${rawTaskId}] Task needs replanning: ${judgement.reason}`);
          if (judgement.missingRequirements && judgement.missingRequirements.length > 0) {
            console.log(`     Missing: ${judgement.missingRequirements.join(', ')}`);
          }

          // 1. 実行ログを取得
          const logResult = await plannerDeps.runnerEffects.readLog(runIdForJudgement);
          if (!logResult.ok) {
            console.error(`  ❌ [${rawTaskId}] Failed to read log for replanning: ${logResult.err.message}`);
            await judgeOps.markTaskAsBlocked(tid);
            failed.push(tid);
            break;
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
            failed.push(tid);
            break;
          }

          const newTaskIds = replanResult.val.taskIds;
          console.log(`  ✅ [${rawTaskId}] Generated ${newTaskIds.length} new tasks from replanning`);

          // WHY: 生成されたタスクの詳細を表示してユーザーに可視性を提供
          const replanTasksLoadResult = await loadTasks(newTaskIds, taskStore);
          for (const task of replanTasksLoadResult.tasks) {
            const summaryText = task.summary ? ` - ${truncateSummary(task.summary)}` : '';
            console.log(`    - ${task.id}${summaryText}`);
          }

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
            failed.push(tid);
            break;
          }

          // WHY: 新タスクは次のスケジューリングサイクルで自動ピックアップされる
          console.log(`  ➡️  [${rawTaskId}] New tasks queued for execution`);
          failed.push(tid); // 元タスクは失敗扱い（新タスクに置き換え）
          break; // チェーン実行を中断
        } else {
          // 完全失敗（shouldContinue=false && shouldReplan=false）
          console.log(`  ❌ ${chainProgress} ${rawTaskId} failed: ${judgement.reason}`);
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

  return {
    completed,
    failed,
    worktreePath,
    updatedSchedulerState: schedulerState,
  };
}
