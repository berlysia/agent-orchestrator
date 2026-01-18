import { promises as fs } from 'fs';
import path from 'path';
import { TaskSchema } from '../../types/task.ts';
import type { Task } from '../../types/task.ts';
import type { Run } from '../../types/run.ts';
import type { Check } from '../../types/check.ts';
import type { TaskStore } from './interface.ts';
import type { TaskId } from '../../types/branded.ts';
import { unwrapTaskId, taskId } from '../../types/branded.ts';
import { createOk, createErr } from 'option-t/plain_result';
import { tryCatchIntoResultAsync } from 'option-t/plain_result/try_catch_async';
import type { Result } from 'option-t/plain_result';
import type { TaskStoreError } from '../../types/errors.ts';
import {
  taskNotFound,
  taskAlreadyExists,
  concurrentModification,
  ioError,
} from '../../types/errors.ts';

/**
 * ファイルストアのエラー型（非推奨: 代わりにTaskStoreErrorを使用）
 *
 * Errorクラスを継承するため残しているが、新規コードでは使用しない。
 */
export class FileStoreError extends Error {
  public cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'FileStoreError';
    this.cause = cause;
  }
}

/**
 * FileStoreの設定
 */
export type FileStoreConfig = {
  readonly basePath: string;
};

// ===== ヘルパー関数 =====

const getTaskPath = (basePath: string, taskId: TaskId): string =>
  path.join(basePath, 'tasks', `${unwrapTaskId(taskId)}.json`);

const getLockPath = (basePath: string, taskId: TaskId): string =>
  path.join(basePath, '.locks', unwrapTaskId(taskId));

const getRunPath = (basePath: string, runId: string): string =>
  path.join(basePath, 'runs', `${runId}.json`);

const getCheckPath = (basePath: string, checkId: string): string =>
  path.join(basePath, 'checks', `${checkId}.json`);

// ===== Result型ヘルパー =====

/**
 * 非同期関数をResult型でラップし、エラーをTaskStoreErrorに変換する
 */
const wrapAsync = async <T>(
  operation: string,
  fn: () => Promise<T>,
  errorMapper?: (err: unknown) => TaskStoreError,
): Promise<Result<T, TaskStoreError>> => {
  const result = await tryCatchIntoResultAsync(fn);
  if (!result.ok) {
    return createErr(errorMapper ? errorMapper(result.err) : ioError(operation, result.err));
  }
  return result;
};

// ===== ロック操作 =====

/**
 * ロックを取得（mkdirベース）
 */
const acquireLock = async (basePath: string, taskId: TaskId): Promise<Result<void, TaskStoreError>> => {
  const lockPath = getLockPath(basePath, taskId);
  return wrapAsync('acquireLock', async () => {
    // 親ディレクトリ（.locks/）を作成
    const locksDir = path.dirname(lockPath);
    await fs.mkdir(locksDir, { recursive: true });

    // ロックディレクトリを作成（atomicにするためrecursive: false）
    await fs.mkdir(lockPath, { recursive: false });
  });
};

/**
 * ロックを解放
 */
const releaseLock = async (basePath: string, taskId: TaskId): Promise<Result<void, TaskStoreError>> => {
  const lockPath = getLockPath(basePath, taskId);
  return wrapAsync('releaseLock', async () => {
    await fs.rmdir(lockPath);
  });
};

// ===== Task操作 =====

/**
 * タスクを読み込む
 */
const readTask = async (basePath: string, taskId: TaskId): Promise<Result<Task, TaskStoreError>> => {
  const taskPath = getTaskPath(basePath, taskId);
  return wrapAsync(
    'readTask',
    async () => {
      const content = await fs.readFile(taskPath, 'utf-8');
      const data = JSON.parse(content);
      return TaskSchema.parse(data);
    },
    (err) => {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        return taskNotFound(taskId);
      }
      return ioError('readTask', err);
    }
  );
};

/**
 * タスクを書き込む
 */
const writeTask = async (basePath: string, task: Task): Promise<Result<void, TaskStoreError>> => {
  const taskPath = getTaskPath(basePath, task.id);
  return wrapAsync('writeTask', async () => {
    const dir = path.dirname(taskPath);
    await fs.mkdir(dir, { recursive: true });
    const content = JSON.stringify(task, null, 2);
    await fs.writeFile(taskPath, content, 'utf-8');
  });
};

/**
 * タスクを作成（新規タスクJSON作成）
 */
const createTask = async (basePath: string, task: Task): Promise<Result<void, TaskStoreError>> => {
  const taskPath = getTaskPath(basePath, task.id);

  // タスクがすでに存在するかチェック
  const accessResult = await wrapAsync(
    'createTask.access',
    async () => {
      await fs.access(taskPath);
      return true;
    },
    (err) => {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        return null as any; // ファイルが存在しない = 正常（nullを返す）
      }
      return ioError('createTask.access', err);
    }
  );

  // accessがエラーを返した場合（ENOENT以外のエラー）
  if (!accessResult.ok) {
    return accessResult;
  }

  // ファイルが存在する場合
  if (accessResult.val === true) {
    return createErr(taskAlreadyExists(task.id));
  }

  // タスクを書き込む
  return writeTask(basePath, task);
};

/**
 * 全タスクの一覧を取得
 */
const listTasks = async (basePath: string): Promise<Result<Task[], TaskStoreError>> => {
  const tasksDir = path.join(basePath, 'tasks');
  return wrapAsync('listTasks', async () => {
    await fs.mkdir(tasksDir, { recursive: true });
    const files = await fs.readdir(tasksDir);
    const taskFiles = files.filter((file) => file.endsWith('.json'));

    const tasks: Task[] = [];
    for (const file of taskFiles) {
      const taskIdStr = path.basename(file, '.json');
      const tid = taskId(taskIdStr);
      const taskResult = await readTask(basePath, tid);
      if (taskResult.ok) {
        tasks.push(taskResult.val);
      } else {
        // 個別のタスク読み込みエラーはスキップ
        console.warn(`Failed to read task ${taskIdStr}:`, taskResult.err);
      }
    }

    return tasks;
  });
};

/**
 * タスクを削除
 */
const deleteTask = async (basePath: string, taskId: TaskId): Promise<Result<void, TaskStoreError>> => {
  const taskPath = getTaskPath(basePath, taskId);
  return wrapAsync(
    'deleteTask',
    async () => {
      await fs.unlink(taskPath);
    },
    (err) => {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        return taskNotFound(taskId);
      }
      return ioError('deleteTask', err);
    }
  );
};

/**
 * CAS（Compare-And-Swap）更新
 */
const updateTaskCAS = async (
  basePath: string,
  tid: TaskId,
  expectedVersion: number,
  updateFn: (task: Task) => Task,
): Promise<Result<Task, TaskStoreError>> => {
  // 1. ロック取得
  const lockResult = await acquireLock(basePath, tid);
  if (!lockResult.ok) {
    return lockResult;
  }

  try {
    // 2. タスク読み込み
    const readResult = await readTask(basePath, tid);
    if (!readResult.ok) {
      return readResult;
    }
    const currentTask = readResult.val;

    // 3. versionチェック
    if (currentTask.version !== expectedVersion) {
      return createErr(concurrentModification(tid, expectedVersion, currentTask.version));
    }

    // 4. 更新関数実行（version++）
    const updatedTask = updateFn(currentTask);
    updatedTask.version = currentTask.version + 1;
    updatedTask.updatedAt = new Date().toISOString();

    // 5. タスク書き込み
    const writeResult = await writeTask(basePath, updatedTask);
    if (!writeResult.ok) {
      return writeResult;
    }

    return createOk(updatedTask);
  } finally {
    // 6. ロック解放（必ず実行）
    await releaseLock(basePath, tid);
  }
};

// ===== Run/Check操作 =====

/**
 * Runを書き込む
 */
const writeRun = async (basePath: string, run: Run): Promise<Result<void, TaskStoreError>> => {
  const runPath = getRunPath(basePath, String(run.id));
  return wrapAsync('writeRun', async () => {
    const dir = path.dirname(runPath);
    await fs.mkdir(dir, { recursive: true });
    const content = JSON.stringify(run, null, 2);
    await fs.writeFile(runPath, content, 'utf-8');
  });
};

/**
 * Checkを書き込む
 */
const writeCheck = async (basePath: string, check: Check): Promise<Result<void, TaskStoreError>> => {
  const checkPath = getCheckPath(basePath, String(check.id));
  return wrapAsync('writeCheck', async () => {
    const dir = path.dirname(checkPath);
    await fs.mkdir(dir, { recursive: true });
    const content = JSON.stringify(check, null, 2);
    await fs.writeFile(checkPath, content, 'utf-8');
  });
};

// ===== TaskStore生成 =====

/**
 * FileStoreを生成
 *
 * basePathを固定したTaskStoreインターフェース実装を返す
 */
export const createFileStore = (config: FileStoreConfig): TaskStore => {
  const { basePath } = config;

  return {
    createTask: (task) => createTask(basePath, task),
    readTask: (taskId) => readTask(basePath, taskId),
    listTasks: () => listTasks(basePath),
    deleteTask: (taskId) => deleteTask(basePath, taskId),
    updateTaskCAS: (taskId, expectedVersion, updateFn) =>
      updateTaskCAS(basePath, taskId, expectedVersion, updateFn),
    writeRun: (run) => writeRun(basePath, run),
    writeCheck: (check) => writeCheck(basePath, check),
  };
};
