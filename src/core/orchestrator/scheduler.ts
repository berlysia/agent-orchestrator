import type { TaskStore } from '../task-store/interface.ts';
import type { Task } from '../../types/task.ts';
import { TaskState } from '../../types/task.ts';

/**
 * Schedulerのオプション
 */
export interface SchedulerOptions {
  /** タスクストアインスタンス */
  taskStore: TaskStore;
  /** 最大Worker並列数（デフォルト: 3） */
  maxWorkers?: number;
}

/**
 * タスクスケジューラ
 *
 * タスクキューからREADY状態のタスクを取得し、Workerに割り当てる
 * CAS更新による楽観的並行制御を使用
 */
export class Scheduler {
  private taskStore: TaskStore;
  private maxWorkers: number;
  private runningWorkers: Set<string>;

  constructor(options: SchedulerOptions) {
    this.taskStore = options.taskStore;
    this.maxWorkers = options.maxWorkers ?? 3;
    this.runningWorkers = new Set();
  }

  /**
   * READY状態のタスクを取得
   *
   * @returns READY状態のタスク配列
   */
  async getReadyTasks(): Promise<Task[]> {
    const allTasks = await this.taskStore.listTasks();
    return allTasks.filter((task) => task.state === TaskState.READY);
  }

  /**
   * タスクをWorkerに割り当て
   *
   * CAS更新でownerを設定し、stateをRUNNINGに変更
   *
   * @param taskId 割り当てるタスクのID
   * @param workerId WorkerのID（例: "worker-1"）
   * @returns 更新後のタスク。割り当てに失敗した場合はnull
   */
  async claimTask(taskId: string, workerId: string): Promise<Task | null> {
    try {
      const task = await this.taskStore.readTask(taskId);

      // タスクがREADY状態でない場合は割り当て不可
      if (task.state !== TaskState.READY) {
        return null;
      }

      // CAS更新: owner設定 + state変更
      const updatedTask = await this.taskStore.updateTaskCAS(
        taskId,
        task.version,
        (currentTask) => ({
          ...currentTask,
          state: TaskState.RUNNING,
          owner: workerId,
          updatedAt: new Date().toISOString(),
        }),
      );

      this.runningWorkers.add(workerId);
      return updatedTask;
    } catch (error) {
      // CAS競合やその他のエラーの場合はnullを返す
      console.error(`Failed to claim task ${taskId} for ${workerId}:`, error);
      return null;
    }
  }

  /**
   * 空きWorkerスロット数を取得
   *
   * @returns 空きスロット数
   */
  getAvailableWorkerSlots(): number {
    return Math.max(0, this.maxWorkers - this.runningWorkers.size);
  }

  /**
   * 実行中のWorker数を取得
   *
   * @returns 実行中のWorker数
   */
  getRunningWorkerCount(): number {
    return this.runningWorkers.size;
  }

  /**
   * Workerを完了としてマーク
   *
   * @param workerId 完了したWorkerのID
   */
  completeWorker(workerId: string): void {
    this.runningWorkers.delete(workerId);
  }

  /**
   * タスクを完了状態に更新
   *
   * @param taskId 完了したタスクのID
   * @returns 更新後のタスク
   */
  async completeTask(taskId: string): Promise<Task> {
    const task = await this.taskStore.readTask(taskId);

    const updatedTask = await this.taskStore.updateTaskCAS(
      taskId,
      task.version,
      (currentTask) => ({
        ...currentTask,
        state: TaskState.DONE,
        owner: null,
        updatedAt: new Date().toISOString(),
      }),
    );

    // Workerスロットを解放
    if (task.owner) {
      this.completeWorker(task.owner);
    }

    return updatedTask;
  }

  /**
   * タスクをBLOCKED状態に更新（エラー時）
   *
   * @param taskId ブロックされたタスクのID
   * @returns 更新後のタスク
   */
  async blockTask(taskId: string): Promise<Task> {
    const task = await this.taskStore.readTask(taskId);

    const updatedTask = await this.taskStore.updateTaskCAS(
      taskId,
      task.version,
      (currentTask) => ({
        ...currentTask,
        state: TaskState.BLOCKED,
        owner: null,
        updatedAt: new Date().toISOString(),
      }),
    );

    // Workerスロットを解放
    if (task.owner) {
      this.completeWorker(task.owner);
    }

    return updatedTask;
  }
}
