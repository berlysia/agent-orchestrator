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
}
