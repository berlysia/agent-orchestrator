import { promises as fs } from 'fs';
import path from 'path';
import { TaskSchema } from '../../types/task.ts';
import type { Task } from '../../types/task.ts';
import type { Run } from '../../types/run.ts';
import type { Check } from '../../types/check.ts';

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
 * JSONファイルベースのタスクストア
 *
 * agent-coord リポジトリ内に以下の構造でファイルを管理：
 * - tasks/<taskId>.json
 * - runs/<runId>.json
 * - checks/<checkId>.json
 * - .locks/<taskId>/  （mkdirベースのロック）
 */
export class FileStore {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /**
   * タスクJSONファイルのパスを取得
   */
  private getTaskPath(taskId: string): string {
    return path.join(this.basePath, 'tasks', `${taskId}.json`);
  }

  /**
   * タスクロックディレクトリのパスを取得
   */
  private getLockPath(taskId: string): string {
    return path.join(this.basePath, '.locks', taskId);
  }

  /**
   * RunJSONファイルのパスを取得
   */
  private getRunPath(runId: string): string {
    return path.join(this.basePath, 'runs', `${runId}.json`);
  }

  /**
   * CheckJSONファイルのパスを取得
   */
  private getCheckPath(checkId: string): string {
    return path.join(this.basePath, 'checks', `${checkId}.json`);
  }

  /**
   * タスクを読み込む
   *
   * @throws {FileStoreError} ファイル読み込みエラー、パースエラー、バリデーションエラー
   */
  async readTask(taskId: string): Promise<Task> {
    const taskPath = this.getTaskPath(taskId);
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
  }

  /**
   * タスクを書き込む
   *
   * @throws {FileStoreError} ファイル書き込みエラー
   */
  async writeTask(task: Task): Promise<void> {
    const taskPath = this.getTaskPath(task.id);
    try {
      const dir = path.dirname(taskPath);
      await fs.mkdir(dir, { recursive: true });
      const content = JSON.stringify(task, null, 2);
      await fs.writeFile(taskPath, content, 'utf-8');
    } catch (err) {
      throw new FileStoreError(`Failed to write task: ${task.id}`, err);
    }
  }

  /**
   * Runを書き込む
   *
   * @throws {FileStoreError} ファイル書き込みエラー
   */
  async writeRun(run: Run): Promise<void> {
    const runPath = this.getRunPath(run.id);
    try {
      const dir = path.dirname(runPath);
      await fs.mkdir(dir, { recursive: true });
      const content = JSON.stringify(run, null, 2);
      await fs.writeFile(runPath, content, 'utf-8');
    } catch (err) {
      throw new FileStoreError(`Failed to write run: ${run.id}`, err);
    }
  }

  /**
   * Checkを書き込む
   *
   * @throws {FileStoreError} ファイル書き込みエラー
   */
  async writeCheck(check: Check): Promise<void> {
    const checkPath = this.getCheckPath(check.id);
    try {
      const dir = path.dirname(checkPath);
      await fs.mkdir(dir, { recursive: true });
      const content = JSON.stringify(check, null, 2);
      await fs.writeFile(checkPath, content, 'utf-8');
    } catch (err) {
      throw new FileStoreError(`Failed to write check: ${check.id}`, err);
    }
  }

  /**
   * タスクを作成（新規タスクJSON作成）
   *
   * @throws {FileStoreError} タスクがすでに存在する、または書き込みエラー
   */
  async createTask(task: Task): Promise<void> {
    const taskPath = this.getTaskPath(task.id);
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

      await this.writeTask(task);
    } catch (err) {
      if (err instanceof FileStoreError) {
        throw err;
      }
      throw new FileStoreError(`Failed to create task: ${task.id}`, err);
    }
  }

  /**
   * 全タスクの一覧を取得
   *
   * @throws {FileStoreError} ディレクトリ読み込みエラー
   */
  async listTasks(): Promise<Task[]> {
    const tasksDir = path.join(this.basePath, 'tasks');
    try {
      await fs.mkdir(tasksDir, { recursive: true });
      const files = await fs.readdir(tasksDir);
      const taskFiles = files.filter((file) => file.endsWith('.json'));

      const tasks: Task[] = [];
      for (const file of taskFiles) {
        const taskId = path.basename(file, '.json');
        try {
          const task = await this.readTask(taskId);
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
  }

  /**
   * タスクを削除
   *
   * @throws {FileStoreError} ファイル削除エラー
   */
  async deleteTask(taskId: string): Promise<void> {
    const taskPath = this.getTaskPath(taskId);
    try {
      await fs.unlink(taskPath);
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        throw new FileStoreError(`Task not found: ${taskId}`, err);
      }
      throw new FileStoreError(`Failed to delete task: ${taskId}`, err);
    }
  }

  /**
   * ロックを取得（mkdirベース）
   *
   * @throws {FileStoreError} ロック取得失敗
   */
  async acquireLock(taskId: string): Promise<void> {
    const lockPath = this.getLockPath(taskId);
    try {
      await fs.mkdir(lockPath, { recursive: false });
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
        throw new FileStoreError(`Lock already held: ${taskId}`, err);
      }
      throw new FileStoreError(`Failed to acquire lock: ${taskId}`, err);
    }
  }

  /**
   * ロックを解放
   *
   * @throws {FileStoreError} ロック解放失敗
   */
  async releaseLock(taskId: string): Promise<void> {
    const lockPath = this.getLockPath(taskId);
    try {
      await fs.rmdir(lockPath);
    } catch (err) {
      throw new FileStoreError(`Failed to release lock: ${taskId}`, err);
    }
  }

  /**
   * CAS（Compare-And-Swap）更新
   *
   * タスクを楽観的ロックで更新。以下のフローで実行：
   * 1. ロック取得
   * 2. タスク読み込み
   * 3. versionチェック
   * 4. 更新関数実行（version++）
   * 5. タスク書き込み
   * 6. ロック解放
   *
   * @param taskId タスクID
   * @param expectedVersion 期待するバージョン番号
   * @param updateFn 更新関数（現在のタスクを受け取り、更新後のタスクを返す）
   * @returns 更新後のタスク
   * @throws {FileStoreError} バージョン不一致、ロック取得失敗、更新失敗
   */
  async updateTaskCAS(
    taskId: string,
    expectedVersion: number,
    updateFn: (task: Task) => Task,
  ): Promise<Task> {
    try {
      // 1. ロック取得
      await this.acquireLock(taskId);

      try {
        // 2. タスク読み込み
        const currentTask = await this.readTask(taskId);

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
        await this.writeTask(updatedTask);

        return updatedTask;
      } finally {
        // 6. ロック解放（必ず実行）
        await this.releaseLock(taskId);
      }
    } catch (err) {
      if (err instanceof FileStoreError) {
        throw err;
      }
      throw new FileStoreError(`Failed to update task with CAS: ${taskId}`, err);
    }
  }
}
