import { createOk, createErr, type Ok, type Err } from 'option-t/plain_result';
import type { Result } from 'option-t/plain_result';
import type { TaskStore } from '../../src/core/task-store/interface.ts';
import type { Task } from '../../src/types/task.ts';
import type { Run } from '../../src/types/run.ts';
import type { Check } from '../../src/types/check.ts';
import type { TaskId } from '../../src/types/branded.ts';
import type { TaskStoreError } from '../../src/types/errors.ts';
import { taskNotFound, taskAlreadyExists, concurrentModification } from '../../src/types/errors.ts';

/**
 * テスト用のモックTaskStore
 *
 * Result型を正しく返すインメモリ実装
 */
export const createMockTaskStore = (initialTasks: Map<TaskId, Task> = new Map()): TaskStore => {
  const tasks = new Map(initialTasks);
  const runs = new Map<string, Run>();
  const checks = new Map<string, Check>();

  return {
    createTask: async (task: Task): Promise<Result<void, TaskStoreError>> => {
      if (tasks.has(task.id)) {
        return createErr(taskAlreadyExists(task.id));
      }
      tasks.set(task.id, task);
      return createOk(undefined);
    },

    readTask: async (taskId: TaskId): Promise<Result<Task, TaskStoreError>> => {
      const task = tasks.get(taskId);
      if (!task) {
        return createErr(taskNotFound(taskId));
      }
      return createOk(task);
    },

    listTasks: async (): Promise<Result<Task[], TaskStoreError>> => {
      return createOk(Array.from(tasks.values()));
    },

    deleteTask: async (taskId: TaskId): Promise<Result<void, TaskStoreError>> => {
      if (!tasks.has(taskId)) {
        return createErr(taskNotFound(taskId));
      }
      tasks.delete(taskId);
      return createOk(undefined);
    },

    updateTaskCAS: async (
      taskId: TaskId,
      expectedVersion: number,
      updateFn: (task: Task) => Task,
    ): Promise<Result<Task, TaskStoreError>> => {
      const task = tasks.get(taskId);
      if (!task) {
        return createErr(taskNotFound(taskId));
      }

      if (task.version !== expectedVersion) {
        return createErr(concurrentModification(taskId, expectedVersion, task.version));
      }

      const updatedTask = updateFn(task);
      updatedTask.version = task.version + 1;
      updatedTask.updatedAt = new Date().toISOString();

      tasks.set(taskId, updatedTask);
      return createOk(updatedTask);
    },

    writeRun: async (run: Run): Promise<Result<void, TaskStoreError>> => {
      runs.set(String(run.id), run);
      return createOk(undefined);
    },

    writeCheck: async (check: Check): Promise<Result<void, TaskStoreError>> => {
      checks.set(String(check.id), check);
      return createOk(undefined);
    },
  };
};

/**
 * Result型のアサーション補助関数
 */
export const assertOk = <T, E>(result: Result<T, E>): asserts result is Ok<T> => {
  if (!result.ok) {
    const errStr =
      result.err && typeof result.err === 'object'
        ? JSON.stringify(result.err, null, 2)
        : String(result.err);
    throw new Error(`Expected Ok, got Err: ${errStr}`);
  }
};

export const assertErr = <T, E>(result: Result<T, E>): asserts result is Err<E> => {
  if (result.ok) {
    throw new Error(`Expected Err, got Ok: ${JSON.stringify(result.val)}`);
  }
};
