import type { Task } from '../../types/task.ts';
import type { Run } from '../../types/run.ts';
import type { Check } from '../../types/check.ts';
import type { TaskId } from '../../types/branded.ts';
import type { Result } from 'option-t/plain_result';
import type { TaskStoreError } from '../../types/errors.ts';

/**
 * タスクストアのインターフェース
 *
 * option-tのResult型を使用してエラーハンドリングを統一。
 * 将来的なSQLite移行を考慮して、ストレージの実装を抽象化。
 */
export interface TaskStore {
  // ===== Task CRUD =====

  /**
   * タスクを作成
   * @returns 成功時はOk<void>、失敗時はErr<TaskStoreError>
   */
  createTask(task: Task): Promise<Result<void, TaskStoreError>>;

  /**
   * タスクを読み込む
   * @returns 成功時はOk<Task>、失敗時はErr<TaskStoreError>
   */
  readTask(taskId: TaskId): Promise<Result<Task, TaskStoreError>>;

  /**
   * 全タスクの一覧を取得
   * @returns 成功時はOk<Task[]>、失敗時はErr<TaskStoreError>
   */
  listTasks(): Promise<Result<Task[], TaskStoreError>>;

  /**
   * タスクを削除
   * @returns 成功時はOk<void>、失敗時はErr<TaskStoreError>
   */
  deleteTask(taskId: TaskId): Promise<Result<void, TaskStoreError>>;

  /**
   * CAS（Compare-And-Swap）更新
   *
   * 楽観的ロックでタスクを更新
   * @param taskId タスクID
   * @param expectedVersion 期待するバージョン番号
   * @param updateFn 更新関数（現在のタスクを受け取り、更新後のタスクを返す）
   * @returns 成功時はOk<Task>、失敗時はErr<TaskStoreError>
   */
  updateTaskCAS(
    taskId: TaskId,
    expectedVersion: number,
    updateFn: (task: Task) => Task,
  ): Promise<Result<Task, TaskStoreError>>;

  // ===== Run/Check 書き込み =====

  /**
   * Runを書き込む
   * @returns 成功時はOk<void>、失敗時はErr<TaskStoreError>
   */
  writeRun(run: Run): Promise<Result<void, TaskStoreError>>;

  /**
   * Checkを書き込む
   * @returns 成功時はOk<void>、失敗時はErr<TaskStoreError>
   */
  writeCheck(check: Check): Promise<Result<void, TaskStoreError>>;
}
