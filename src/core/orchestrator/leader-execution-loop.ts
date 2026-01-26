import type { Result } from 'option-t/plain_result';
import { createOk, createErr, isErr } from 'option-t/plain_result';
import type { TaskStoreError } from '../../types/errors.ts';
import { ioError } from '../../types/errors.ts';
import type { LeaderSession } from '../../types/leader-session.ts';
import { LeaderSessionStatus } from '../../types/leader-session.ts';
import type { Task } from '../../types/task.ts';
import { TaskState } from '../../types/task.ts';
import type { TaskId } from '../../types/branded.ts';
import type { LeaderDeps } from './leader-operations.ts';
import {
  assignTaskToMember,
  updateLeaderSessionStatus,
  escalateToUser,
  escalateToPlanner,
} from './leader-operations.ts';

/**
 * Leader 実行ループの結果
 *
 * WHY: Phase 2 Task 3 - Leader 実行完了時の状態を返す
 */
export interface LeaderLoopResult {
  /** 更新された Leader セッション */
  session: LeaderSession;
  /** 完了したタスク ID 一覧 */
  completedTaskIds: TaskId[];
  /** 失敗したタスク ID 一覧 */
  failedTaskIds: TaskId[];
  /** 保留中のエスカレーション（停止理由） */
  pendingEscalation?: {
    target: string;
    reason: string;
    relatedTaskId?: TaskId;
  };
}

/**
 * タスクが実行可能かチェック
 *
 * 実行可能条件:
 * 1. タスクが READY 状態
 * 2. 依存タスクが全て DONE または SKIPPED
 *
 * @param task チェック対象タスク
 * @param allTasks 全タスクリスト
 * @returns 実行可能なら true
 */
function isTaskExecutable(task: Task, allTasks: Task[]): boolean {
  // タスクが READY 状態でなければ実行不可
  if (task.state !== TaskState.READY) {
    return false;
  }

  // 依存タスクが全て完了しているかチェック
  const taskMap = new Map(allTasks.map((t) => [t.id, t]));

  for (const depId of task.dependencies) {
    const depTask = taskMap.get(depId);
    if (!depTask) {
      // 依存タスクが存在しない場合は実行不可
      return false;
    }

    // 依存タスクが DONE または SKIPPED でなければ実行不可
    if (depTask.state !== TaskState.DONE && depTask.state !== TaskState.SKIPPED) {
      return false;
    }
  }

  return true;
}

/**
 * 実行可能なタスクを取得
 *
 * 依存関係を考慮して、実行可能なタスクのリストを返す
 *
 * @param allTasks 全タスクリスト
 * @returns 実行可能なタスクリスト
 */
function getExecutableTasks(allTasks: Task[]): Task[] {
  return allTasks.filter((task) => isTaskExecutable(task, allTasks));
}

/**
 * 全タスクが完了したかチェック
 *
 * 完了条件:
 * - 全タスクが DONE, SKIPPED, CANCELLED, または REPLACED_BY_REPLAN のいずれか
 *
 * @param allTasks 全タスクリスト
 * @returns 全タスクが完了していれば true
 */
function allTasksCompleted(allTasks: Task[]): boolean {
  return allTasks.every(
    (task) =>
      task.state === TaskState.DONE ||
      task.state === TaskState.SKIPPED ||
      task.state === TaskState.CANCELLED ||
      task.state === TaskState.REPLACED_BY_REPLAN,
  );
}

/**
 * Leader 実行ループ
 *
 * Phase 2 Task 3: タスクを順次実行し、Judge判定に基づいてアクションを決定
 *
 * フロー:
 * 1. 実行可能タスク選択（依存関係考慮）
 * 2. `assignTaskToMember()` で Worker 実行と Judge 判定
 * 3. Judge判定結果に基づいて次アクション決定
 * 4. アクションに応じて分岐（accept/continue/replan/escalate）
 * 5. 全タスク完了 or エスカレーション待ちで終了
 *
 * Phase 2 実装範囲:
 * - Judge判定結果を直接使用（WorkerFeedbackはPhase 3）
 * - タスクは1つずつ順次実行（並列化はPhase 3以降）
 * - エスカレーション発生時は ESCALATING 状態で停止、記録のみ
 * - Planner再計画は実行、User/LogicValidator/ExternalAdvisorへは停止
 *
 * @param deps Leader 依存関係
 * @param session Leader セッション
 * @param tasks 実行対象タスクリスト
 * @returns Leader実行結果
 */
export async function executeLeaderLoop(
  deps: LeaderDeps,
  session: LeaderSession,
  tasks: Task[],
): Promise<Result<LeaderLoopResult, TaskStoreError>> {
  try {
    console.log('\n🚀 Leader: Starting execution loop');
    console.log(`  Total tasks: ${tasks.length}`);

    let currentSession = session;
    const completedTaskIds: TaskId[] = [];
    const failedTaskIds: TaskId[] = [];
    let pendingEscalation: LeaderLoopResult['pendingEscalation'] = undefined;

    // セッション状態を EXECUTING に更新
    const executingResult = await updateLeaderSessionStatus(
      deps,
      currentSession,
      LeaderSessionStatus.EXECUTING,
    );
    if (isErr(executingResult)) {
      return executingResult;
    }
    currentSession = executingResult.val;

    // タスク実行ループ
    let iteration = 0;
    const maxIterations = 1000; // 無限ループ防止

    while (iteration < maxIterations) {
      iteration++;

      // タスクストアから最新のタスクリストを取得
      const taskListResult = await deps.taskStore.listTasks();
      if (isErr(taskListResult)) {
        return createErr(ioError(`Failed to list tasks: ${taskListResult.err.message}`));
      }
      const currentTasks = taskListResult.val;

      // 全タスク完了チェック
      if (allTasksCompleted(currentTasks)) {
        console.log('\n✅ All tasks completed');
        break;
      }

      // 実行可能なタスクを取得
      const executableTasks = getExecutableTasks(currentTasks);

      if (executableTasks.length === 0) {
        console.log('\n⏸️  No executable tasks available (waiting for dependencies or escalation)');
        break;
      }

      // 最初の実行可能タスクを実行（Phase 2 では順次実行）
      const task = executableTasks[0];
      if (!task) {
        // 実行可能タスクがない場合はスキップ（安全性チェック）
        console.log('\n⚠️  No executable task found (safety check)');
        break;
      }

      console.log(`\n📋 Processing task: ${task.id}`);
      console.log(`   Summary: ${task.summary ?? 'N/A'}`);
      console.log(`   Branch: ${task.branch}`);

      // Worker 実行と Judge 判定
      const assignResult = await assignTaskToMember(deps, currentSession, task);
      if (isErr(assignResult)) {
        console.error(`  ❌ Failed to assign task: ${assignResult.err.message}`);
        failedTaskIds.push(task.id);

        // タスクを BLOCKED 状態に更新
        await deps.taskStore.updateTaskCAS(task.id, task.version, (t) => ({
          ...t,
          state: TaskState.BLOCKED,
        }));

        continue;
      }

      const { judgementResult } = assignResult.val;

      // Judge判定結果に基づいてアクション決定
      if (judgementResult.success) {
        // タスク成功
        console.log(`  ✅ Task completed successfully`);
        completedTaskIds.push(task.id);

        // タスクを DONE 状態に更新
        await deps.taskStore.updateTaskCAS(task.id, task.version, (t) => ({
          ...t,
          state: TaskState.DONE,
        }));
      } else if (judgementResult.alreadySatisfied) {
        // タスクは既に実装済み
        console.log(`  ⏭️  Task already satisfied, skipping`);
        completedTaskIds.push(task.id);

        // タスクを SKIPPED 状態に更新
        await deps.taskStore.updateTaskCAS(task.id, task.version, (t) => ({
          ...t,
          state: TaskState.SKIPPED,
        }));
      } else if (judgementResult.shouldContinue) {
        // 継続実行が必要
        console.log(`  🔄 Task needs continuation`);

        // タスクを NEEDS_CONTINUATION 状態に更新
        await deps.taskStore.updateTaskCAS(task.id, task.version, (t) => ({
          ...t,
          state: TaskState.NEEDS_CONTINUATION,
        }));

        // 次のイテレーションで再実行
        // Phase 2: 簡易実装として NEEDS_CONTINUATION → READY に戻す
        await deps.taskStore.updateTaskCAS(task.id, task.version + 1, (t) => ({
          ...t,
          state: TaskState.READY,
        }));
      } else if (judgementResult.shouldReplan) {
        // 再計画が必要
        console.log(`  🔄 Task needs replanning`);

        // Planner へエスカレーション
        const escalationResult = await escalateToPlanner(
          deps,
          currentSession,
          `Task ${task.id} failed and needs replanning: ${judgementResult.reason}`,
          task.id,
        );

        if (isErr(escalationResult)) {
          return createErr(
            ioError(`Failed to escalate to Planner: ${escalationResult.err.message}`),
          );
        }

        currentSession = escalationResult.val;

        // Phase 2: Plannerエスカレーションは停止（Phase 3 で実際の再計画実行）
        pendingEscalation = {
          target: 'planner',
          reason: `Task needs replanning: ${judgementResult.reason}`,
          relatedTaskId: task.id,
        };

        console.log(`  ⏸️  Escalated to Planner, stopping execution`);
        break;
      } else {
        // その他の失敗（ユーザーエスカレーション）
        console.log(`  ⚠️  Task failed: ${judgementResult.reason}`);
        failedTaskIds.push(task.id);

        // ユーザーへエスカレーション
        const escalationResult = await escalateToUser(
          deps,
          currentSession,
          `Task ${task.id} failed: ${judgementResult.reason}`,
          task.id,
        );

        if (isErr(escalationResult)) {
          return createErr(ioError(`Failed to escalate to User: ${escalationResult.err.message}`));
        }

        currentSession = escalationResult.val;

        // Phase 2: Userエスカレーションは停止
        pendingEscalation = {
          target: 'user',
          reason: `Task failed: ${judgementResult.reason}`,
          relatedTaskId: task.id,
        };

        console.log(`  ⏸️  Escalated to User, stopping execution`);
        break;
      }
    }

    if (iteration >= maxIterations) {
      return createErr(
        ioError(`Leader execution loop exceeded maximum iterations (${maxIterations})`),
      );
    }

    // 最終タスクリストを取得して状態を判定
    const finalTaskListResult = await deps.taskStore.listTasks();
    if (isErr(finalTaskListResult)) {
      return createErr(ioError(`Failed to list tasks for final status: ${finalTaskListResult.err.message}`));
    }
    const finalTasks = finalTaskListResult.val;

    // 最終状態の決定
    let finalStatus: LeaderSessionStatus;
    if (pendingEscalation) {
      finalStatus = LeaderSessionStatus.ESCALATING;
    } else if (allTasksCompleted(finalTasks)) {
      finalStatus = LeaderSessionStatus.COMPLETED;
    } else {
      // タスクが残っているが実行不可（依存関係など）
      finalStatus = LeaderSessionStatus.REVIEWING;
    }

    // セッション状態を更新
    const finalResult = await updateLeaderSessionStatus(deps, currentSession, finalStatus);
    if (isErr(finalResult)) {
      return finalResult;
    }
    currentSession = finalResult.val;

    console.log(`\n🏁 Leader execution loop finished`);
    console.log(`   Status: ${finalStatus}`);
    console.log(`   Completed: ${completedTaskIds.length}`);
    console.log(`   Failed: ${failedTaskIds.length}`);
    if (pendingEscalation) {
      console.log(`   Escalation: ${pendingEscalation.target} - ${pendingEscalation.reason}`);
    }

    return createOk({
      session: currentSession,
      completedTaskIds,
      failedTaskIds,
      pendingEscalation,
    });
  } catch (error) {
    return createErr(ioError(`Leader execution loop failed: ${String(error)}`));
  }
}
