import type { TaskStore } from '../task-store/interface.ts';
import type { Task } from '../../types/task.ts';
import { TaskState } from '../../types/task.ts';
import type { TaskId } from '../../types/branded.ts';
import type { TaskStoreError } from '../../types/errors.ts';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr } from 'option-t/plain_result';

/**
 * Judge依存関係
 */
export interface JudgeDeps {
  readonly taskStore: TaskStore;
}

/**
 * Judge判定結果
 */
export interface JudgementResult {
  /** タスクID */
  taskId: TaskId;
  /** 判定結果（true=成功、false=失敗） */
  success: boolean;
  /** 継続の可否（true=次イテレーション実行、false=停止） */
  shouldContinue: boolean;
  /** 理由メッセージ */
  reason: string;
}

/**
 * Judge操作を提供するファクトリ関数
 *
 * @param deps Judge依存関係
 * @returns Judge操作オブジェクト
 */
export const createJudgeOperations = (deps: JudgeDeps) => {
  /**
   * タスクの完了を判定
   *
   * WHY: Worker実行後のタスクを評価し、完了/継続/停止を判断
   * TODO: CI実行結果の確認機能追加（Epic 4.3）
   *
   * @param tid 判定するタスクのID
   * @returns 判定結果（Result型）
   */
  const judgeTask = async (tid: TaskId): Promise<Result<JudgementResult, TaskStoreError>> => {
    const taskResult = await deps.taskStore.readTask(tid);

    // Result型のエラーハンドリング
    if (!taskResult.ok) {
      return createErr(taskResult.err);
    }

    const task = taskResult.val;

    // タスクがRUNNING状態であることを確認
    if (task.state !== TaskState.RUNNING) {
      return createOk({
        taskId: tid,
        success: false,
        shouldContinue: false,
        reason: `Task is not in RUNNING state: ${task.state}`,
      });
    }

    // TODO: CI実行結果を確認（Epic 4.3の実装後）
    // if (task.check) {
    //   const checkResult = await deps.taskStore.readCheck(task.check);
    //   if (!checkResult.ok || !checkResult.val.success) {
    //     return handleFailure(task, checkResult);
    //   }
    // }

    // 簡易判定: RUNNING状態のタスクは成功とみなす
    return createOk({
      taskId: tid,
      success: true,
      shouldContinue: false, // MVP版では1サイクルで終了
      reason: 'Task completed successfully (simplified judgement)',
    });
  };

  /**
   * タスクを完了状態に更新
   *
   * @param tid タスクID
   * @returns 更新後のタスク（Result型）
   */
  const markTaskAsCompleted = async (tid: TaskId): Promise<Result<Task, TaskStoreError>> => {
    const taskResult = await deps.taskStore.readTask(tid);
    if (!taskResult.ok) {
      return taskResult;
    }

    const task = taskResult.val;

    return await deps.taskStore.updateTaskCAS(tid, task.version, (currentTask) => ({
      ...currentTask,
      state: TaskState.DONE,
      owner: null,
      updatedAt: new Date().toISOString(),
    }));
  };

  /**
   * タスクをブロック状態に更新
   *
   * @param tid タスクID
   * @returns 更新後のタスク（Result型）
   */
  const markTaskAsBlocked = async (tid: TaskId): Promise<Result<Task, TaskStoreError>> => {
    const taskResult = await deps.taskStore.readTask(tid);
    if (!taskResult.ok) {
      return taskResult;
    }

    const task = taskResult.val;

    return await deps.taskStore.updateTaskCAS(tid, task.version, (currentTask) => ({
      ...currentTask,
      state: TaskState.BLOCKED,
      owner: null,
      updatedAt: new Date().toISOString(),
    }));
  };

  return {
    judgeTask,
    markTaskAsCompleted,
    markTaskAsBlocked,
  };
};

/**
 * Judge操作型
 */
export type JudgeOperations = ReturnType<typeof createJudgeOperations>;

// TODO: 将来の実装用 - CI統合時に追加
// const handleFailure = async (
//   task: Task,
//   checkResult: Result<Check, TaskStoreError>
// ): Promise<Result<JudgementResult, TaskStoreError>> => {
//   // リトライ戦略の実装
//   // - 自動リトライ（最大N回）
//   // - エラー内容に応じた対処（コンパイルエラー vs テスト失敗）
//   return createOk({
//     taskId: task.id,
//     success: false,
//     shouldContinue: false,
//     reason: `Task failed: ${checkResult.err.message}`,
//   });
// };
