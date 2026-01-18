import type { TaskStore } from '../task-store/interface.ts';
import type { Task } from '../../types/task.ts';
import { TaskState } from '../../types/task.ts';
import type { TaskId } from '../../types/branded.ts';
import type { TaskStoreError } from '../../types/errors.ts';
import type { Result } from 'option-t/plain_result';

/**
 * Judgeのオプション
 */
export interface JudgeOptions {
  /** タスクストアインスタンス */
  taskStore: TaskStore;
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
 * Judge - タスク完了判定を担当
 *
 * Worker実行後のタスクを評価し、完了/継続/停止を判断
 */
export class Judge {
  private taskStore: TaskStore;

  constructor(options: JudgeOptions) {
    this.taskStore = options.taskStore;
  }

  /**
   * タスクの完了を判定
   *
   * @param taskId 判定するタスクのID
   * @returns 判定結果
   */
  async judgeTask(taskId: TaskId): Promise<JudgementResult> {
    const taskResult = await this.taskStore.readTask(taskId);

    // Result型のエラーハンドリング
    if (!taskResult.ok) {
      return {
        taskId,
        success: false,
        shouldContinue: false,
        reason: `Failed to read task: ${taskResult.err.message}`,
      };
    }

    const task = taskResult.val;

    // TODO: 実際のCI/lint実行結果を確認
    // 現時点では簡易的な判定のみ

    // タスクがRUNNING状態であることを確認
    if (task.state !== TaskState.RUNNING) {
      return {
        taskId,
        success: false,
        shouldContinue: false,
        reason: `Task is not in RUNNING state: ${task.state}`,
      };
    }

    // TODO: CI実行結果を確認（Epic 4.3の実装後）
    // if (task.check) {
    //   const checkResult = await this.taskStore.readCheck(task.check);
    //   if (!checkResult.success) {
    //     return this.handleFailure(task, checkResult.error);
    //   }
    // }

    // 簡易判定: RUNNING状態のタスクは成功とみなす
    return {
      taskId,
      success: true,
      shouldContinue: false, // MVP版では1サイクルで終了
      reason: 'Task completed successfully (simplified judgement)',
    };
  }

  // TODO: 将来の実装用 - CI統合時に使用
  // private async handleFailure(task: Task, error: string): Promise<JudgementResult> {
  //   // リトライ戦略の実装
  //   // - 自動リトライ（最大N回）
  //   // - エラー内容に応じた対処（コンパイルエラー vs テスト失敗）
  //   return {
  //     taskId: task.id,
  //     success: false,
  //     shouldContinue: false,
  //     reason: `Task failed: ${error}`,
  //   };
  // }

  /**
   * タスクを完了状態に更新
   *
   * @param taskId タスクID
   * @returns 更新後のタスク
   */
  async markTaskAsCompleted(taskId: TaskId): Promise<Result<Task, TaskStoreError>> {
    const taskResult = await this.taskStore.readTask(taskId);

    if (!taskResult.ok) {
      return taskResult;
    }

    const task = taskResult.val;

    return await this.taskStore.updateTaskCAS(taskId, task.version, (currentTask) => ({
      ...currentTask,
      state: TaskState.DONE,
      owner: null,
      updatedAt: new Date().toISOString(),
    }));
  }

  /**
   * タスクをブロック状態に更新
   *
   * @param taskId タスクID
   * @returns 更新後のタスク
   */
  async markTaskAsBlocked(taskId: TaskId): Promise<Result<Task, TaskStoreError>> {
    const taskResult = await this.taskStore.readTask(taskId);

    if (!taskResult.ok) {
      return taskResult;
    }

    const task = taskResult.val;

    return await this.taskStore.updateTaskCAS(taskId, task.version, (currentTask) => ({
      ...currentTask,
      state: TaskState.BLOCKED,
      owner: null,
      updatedAt: new Date().toISOString(),
    }));
  }
}
