import type { Task } from '../../types/task.ts';
import type { Run } from '../../types/run.ts';
import type { Check } from '../../types/check.ts';

/**
 * タスクストアのインターフェース
 *
 * 将来的なSQLite移行を考慮して、ストレージの実装を抽象化
 */
export interface TaskStore {
  // ===== Task CRUD =====

  /**
   * タスクを作成
   * @throws タスクがすでに存在する、または書き込みエラー
   */
  createTask(task: Task): Promise<void>;

  /**
   * タスクを読み込む
   * @throws タスクが存在しない、または読み込みエラー
   */
  readTask(taskId: string): Promise<Task>;

  /**
   * 全タスクの一覧を取得
   * @throws ディレクトリ読み込みエラー
   */
  listTasks(): Promise<Task[]>;

  /**
   * タスクを削除
   * @throws タスクが存在しない、または削除エラー
   */
  deleteTask(taskId: string): Promise<void>;

  /**
   * CAS（Compare-And-Swap）更新
   *
   * 楽観的ロックでタスクを更新
   * @param taskId タスクID
   * @param expectedVersion 期待するバージョン番号
   * @param updateFn 更新関数（現在のタスクを受け取り、更新後のタスクを返す）
   * @returns 更新後のタスク
   * @throws バージョン不一致、ロック取得失敗、更新失敗
   */
  updateTaskCAS(
    taskId: string,
    expectedVersion: number,
    updateFn: (task: Task) => Task,
  ): Promise<Task>;

  // ===== Run/Check 書き込み =====

  /**
   * Runを書き込む
   * @throws 書き込みエラー
   */
  writeRun(run: Run): Promise<void>;

  /**
   * Checkを書き込む
   * @throws 書き込みエラー
   */
  writeCheck(check: Check): Promise<void>;
}
