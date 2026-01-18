import { promises as fs } from 'fs';
import path from 'path';
import { TaskSchema } from '../../types/task.ts';
import type { Task } from '../../types/task.ts';
import type { Run } from '../../types/run.ts';
import type { Check } from '../../types/check.ts';
import type { TaskStore } from './interface.ts';

/**
 * ファイルストアのエラー型
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

const getTaskPath = (basePath: string, taskId: string): string =>
  path.join(basePath, 'tasks', `${taskId}.json`);

const getLockPath = (basePath: string, taskId: string): string =>
  path.join(basePath, '.locks', taskId);

const getRunPath = (basePath: string, runId: string): string =>
  path.join(basePath, 'runs', `${runId}.json`);

const getCheckPath = (basePath: string, checkId: string): string =>
  path.join(basePath, 'checks', `${checkId}.json`);

// ===== ロック操作 =====

/**
 * ロックを取得（mkdirベース）
 */
const acquireLock = async (basePath: string, taskId: string): Promise<void> => {
  const lockPath = getLockPath(basePath, taskId);
  try {
    await fs.mkdir(lockPath, { recursive: false });
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
      throw new FileStoreError(`Lock already held: ${taskId}`, err);
    }
    throw new FileStoreError(`Failed to acquire lock: ${taskId}`, err);
  }
};

/**
 * ロックを解放
 */
const releaseLock = async (basePath: string, taskId: string): Promise<void> => {
  const lockPath = getLockPath(basePath, taskId);
  try {
    await fs.rmdir(lockPath);
  } catch (err) {
    throw new FileStoreError(`Failed to release lock: ${taskId}`, err);
  }
};

// ===== Task操作 =====

/**
 * タスクを読み込む
 */
const readTask = async (basePath: string, taskId: string): Promise<Task> => {
  const taskPath = getTaskPath(basePath, taskId);
  try {
    const content = await fs.readFile(taskPath, 'utf-8');
    const data = JSON.parse(content);
    return TaskSchema.parse(data);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      throw new FileStoreError(`Task not found: ${taskId}`, err);
    }
    throw new FileStoreError(`Failed to read task: ${taskId}`, err);
  }
};

/**
 * タスクを書き込む
 */
const writeTask = async (basePath: string, task: Task): Promise<void> => {
  const taskPath = getTaskPath(basePath, task.id);
  try {
    const dir = path.dirname(taskPath);
    await fs.mkdir(dir, { recursive: true });
    const content = JSON.stringify(task, null, 2);
    await fs.writeFile(taskPath, content, 'utf-8');
  } catch (err) {
    throw new FileStoreError(`Failed to write task: ${task.id}`, err);
  }
};

/**
 * タスクを作成（新規タスクJSON作成）
 */
const createTask = async (basePath: string, task: Task): Promise<void> => {
  const taskPath = getTaskPath(basePath, task.id);
  try {
    // タスクがすでに存在するかチェック
    try {
      await fs.access(taskPath);
      throw new FileStoreError(`Task already exists: ${task.id}`);
    } catch (accessErr) {
      // ファイルが存在しない場合は正常（続行）
      if (
        !(
          accessErr &&
          typeof accessErr === 'object' &&
          'code' in accessErr &&
          accessErr.code === 'ENOENT'
        )
      ) {
        throw accessErr;
      }
    }

    await writeTask(basePath, task);
  } catch (err) {
    if (err instanceof FileStoreError) {
      throw err;
    }
    throw new FileStoreError(`Failed to create task: ${task.id}`, err);
  }
};

/**
 * 全タスクの一覧を取得
 */
const listTasks = async (basePath: string): Promise<Task[]> => {
  const tasksDir = path.join(basePath, 'tasks');
  try {
    await fs.mkdir(tasksDir, { recursive: true });
    const files = await fs.readdir(tasksDir);
    const taskFiles = files.filter((file) => file.endsWith('.json'));

    const tasks: Task[] = [];
    for (const file of taskFiles) {
      const taskId = path.basename(file, '.json');
      try {
        const task = await readTask(basePath, taskId);
        tasks.push(task);
      } catch (err) {
        // 個別のタスク読み込みエラーはスキップ
        console.warn(`Failed to read task ${taskId}:`, err);
      }
    }

    return tasks;
  } catch (err) {
    throw new FileStoreError('Failed to list tasks', err);
  }
};

/**
 * タスクを削除
 */
const deleteTask = async (basePath: string, taskId: string): Promise<void> => {
  const taskPath = getTaskPath(basePath, taskId);
  try {
    await fs.unlink(taskPath);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      throw new FileStoreError(`Task not found: ${taskId}`, err);
    }
    throw new FileStoreError(`Failed to delete task: ${taskId}`, err);
  }
};

/**
 * CAS（Compare-And-Swap）更新
 */
const updateTaskCAS = async (
  basePath: string,
  taskId: string,
  expectedVersion: number,
  updateFn: (task: Task) => Task,
): Promise<Task> => {
  try {
    // 1. ロック取得
    await acquireLock(basePath, taskId);

    try {
      // 2. タスク読み込み
      const currentTask = await readTask(basePath, taskId);

      // 3. versionチェック
      if (currentTask.version !== expectedVersion) {
        throw new FileStoreError(
          `Version mismatch: expected ${expectedVersion}, got ${currentTask.version} for task ${taskId}`,
        );
      }

      // 4. 更新関数実行（version++）
      const updatedTask = updateFn(currentTask);
      updatedTask.version = currentTask.version + 1;
      updatedTask.updatedAt = new Date().toISOString();

      // 5. タスク書き込み
      await writeTask(basePath, updatedTask);

      return updatedTask;
    } finally {
      // 6. ロック解放（必ず実行）
      await releaseLock(basePath, taskId);
    }
  } catch (err) {
    if (err instanceof FileStoreError) {
      throw err;
    }
    throw new FileStoreError(`Failed to update task with CAS: ${taskId}`, err);
  }
};

// ===== Run/Check操作 =====

/**
 * Runを書き込む
 */
const writeRun = async (basePath: string, run: Run): Promise<void> => {
  const runPath = getRunPath(basePath, run.id);
  try {
    const dir = path.dirname(runPath);
    await fs.mkdir(dir, { recursive: true });
    const content = JSON.stringify(run, null, 2);
    await fs.writeFile(runPath, content, 'utf-8');
  } catch (err) {
    throw new FileStoreError(`Failed to write run: ${run.id}`, err);
  }
};

/**
 * Checkを書き込む
 */
const writeCheck = async (basePath: string, check: Check): Promise<void> => {
  const checkPath = getCheckPath(basePath, check.id);
  try {
    const dir = path.dirname(checkPath);
    await fs.mkdir(dir, { recursive: true });
    const content = JSON.stringify(check, null, 2);
    await fs.writeFile(checkPath, content, 'utf-8');
  } catch (err) {
    throw new FileStoreError(`Failed to write check: ${check.id}`, err);
  }
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
