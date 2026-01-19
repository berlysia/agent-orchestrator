import type { TaskStore } from '../task-store/interface.ts';
import type { Task } from '../../types/task.ts';
import { TaskState } from '../../types/task.ts';
import type { TaskId } from '../../types/branded.ts';
import { taskId, workerId } from '../../types/branded.ts';
import type { TaskStoreError } from '../../types/errors.ts';
import { validationError } from '../../types/errors.ts';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr } from 'option-t/plain_result';
import { mapForResult } from 'option-t/plain_result/map';
import type { SchedulerState } from './scheduler-state.ts';
import { addRunningWorker, hasCapacity } from './scheduler-state.ts';

/**
 * Scheduler依存関係
 */
export interface SchedulerDeps {
  readonly taskStore: TaskStore;
}

/**
 * タスククレーム結果
 */
export interface ClaimTaskResult {
  /** 更新後のタスク */
  task: Task;
  /** 新しいScheduler状態 */
  newState: SchedulerState;
}

/**
 * Scheduler操作を提供するファクトリ関数
 *
 * @param deps Scheduler依存関係
 * @returns Scheduler操作オブジェクト
 */
export const createSchedulerOperations = (deps: SchedulerDeps) => {
  /**
   * READY状態のタスクを取得
   *
   * @returns READY状態のタスク配列（Result型）
   */
  const getReadyTasks = async (): Promise<Result<Task[], TaskStoreError>> => {
    const allTasksResult = await deps.taskStore.listTasks();
    return mapForResult(allTasksResult, (tasks) =>
      tasks.filter((task) => task.state === TaskState.READY),
    );
  };

  /**
   * タスクをWorkerに割り当て
   *
   * CAS更新でownerを設定し、stateをRUNNINGに変更
   * Scheduler状態も更新して返す
   *
   * @param state 現在のScheduler状態
   * @param rawTaskId 割り当てるタスクのID（文字列）
   * @param rawWorkerId WorkerのID（文字列）
   * @returns タスクと新しい状態（Result型）
   */
  const claimTask = async (
    state: SchedulerState,
    rawTaskId: string,
    rawWorkerId: string,
  ): Promise<Result<ClaimTaskResult, TaskStoreError>> => {
    // キャパシティチェック
    if (!hasCapacity(state)) {
      return createErr(validationError('No available worker slots'));
    }

    const tid = taskId(rawTaskId);
    const wid = workerId(rawWorkerId);

    // タスク読み込み
    const taskResult = await deps.taskStore.readTask(tid);
    if (!taskResult.ok) {
      return createErr(taskResult.err);
    }

    const task = taskResult.val;

    // タスクがREADY状態でない場合は割り当て不可
    if (task.state !== TaskState.READY) {
      return createErr(validationError(`Task ${rawTaskId} is not in READY state: ${task.state}`));
    }

    // CAS更新: owner設定 + state変更
    const updatedTaskResult = await deps.taskStore.updateTaskCAS(
      tid,
      task.version,
      (currentTask) => ({
        ...currentTask,
        state: TaskState.RUNNING,
        owner: wid,
        updatedAt: new Date().toISOString(),
      }),
    );

    if (!updatedTaskResult.ok) {
      return createErr(updatedTaskResult.err);
    }

    // 状態更新: Worker追加
    const newState = addRunningWorker(state, wid);

    return createOk({
      task: updatedTaskResult.val,
      newState,
    });
  };

  /**
   * タスクを完了状態に更新
   *
   * @param tid タスクID
   * @returns 更新後のタスク（Result型）
   */
  const completeTask = async (tid: TaskId): Promise<Result<Task, TaskStoreError>> => {
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
   * タスクをBLOCKED状態に更新（エラー時）
   *
   * @param tid タスクID
   * @returns 更新後のタスク（Result型）
   */
  const blockTask = async (tid: TaskId): Promise<Result<Task, TaskStoreError>> => {
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

  /**
   * タスクをREADY状態にリセット
   *
   * WHY: 失敗タスクをリトライする際、BLOCKED/CANCELLED状態からREADYに戻す必要がある
   *
   * @param tid タスクID
   * @returns 更新後のタスク（Result型）
   */
  const resetTaskToReady = async (tid: TaskId): Promise<Result<Task, TaskStoreError>> => {
    const taskResult = await deps.taskStore.readTask(tid);
    if (!taskResult.ok) {
      return taskResult;
    }

    const task = taskResult.val;

    return await deps.taskStore.updateTaskCAS(tid, task.version, (currentTask) => ({
      ...currentTask,
      state: TaskState.READY,
      owner: null,
      updatedAt: new Date().toISOString(),
    }));
  };

  return {
    getReadyTasks,
    claimTask,
    completeTask,
    blockTask,
    resetTaskToReady,
  };
};

/**
 * Scheduler操作型
 */
export type SchedulerOperations = ReturnType<typeof createSchedulerOperations>;
