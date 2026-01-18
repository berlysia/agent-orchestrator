import fs from 'node:fs/promises';
import path from 'node:path';
import type { Run } from '../../types/run.ts';

/**
 * ログ書き込みオプション
 */
export interface LogWriterOptions {
  /** agent-coord repoのベースパス */
  coordRepoPath: string;
}

/**
 * ログ書き込みクラス
 *
 * runs/<runId>.log と runs/<runId>.json にログとメタデータを保存する。
 */
export class LogWriter {
  private coordRepoPath: string;
  private runsDir: string;

  constructor(options: LogWriterOptions) {
    this.coordRepoPath = options.coordRepoPath;
    this.runsDir = path.join(this.coordRepoPath, 'runs');
  }

  /**
   * runs/ディレクトリを初期化（存在しない場合作成）
   */
  async ensureRunsDir(): Promise<void> {
    await fs.mkdir(this.runsDir, { recursive: true });
  }

  /**
   * ログファイルパスを取得
   *
   * @param runId 実行ID
   * @returns ログファイルの絶対パス
   */
  getLogFilePath(runId: string): string {
    return path.join(this.runsDir, `${runId}.log`);
  }

  /**
   * Runメタデータファイルパスを取得
   *
   * @param runId 実行ID
   * @returns Runメタデータファイルの絶対パス
   */
  getRunMetadataPath(runId: string): string {
    return path.join(this.runsDir, `${runId}.json`);
  }

  /**
   * ログを追記
   *
   * @param runId 実行ID
   * @param content ログ内容
   */
  async appendLog(runId: string, content: string): Promise<void> {
    const logPath = this.getLogFilePath(runId);
    await fs.appendFile(logPath, content, 'utf-8');
  }

  /**
   * Runメタデータを保存
   *
   * @param run Run情報
   */
  async saveRunMetadata(run: Run): Promise<void> {
    const metadataPath = this.getRunMetadataPath(run.id);
    const json = JSON.stringify(run, null, 2);
    await fs.writeFile(metadataPath, json, 'utf-8');
  }

  /**
   * Runメタデータを読み込み
   *
   * @param runId 実行ID
   * @returns Run情報、存在しない場合null
   */
  async loadRunMetadata(runId: string): Promise<Run | null> {
    const metadataPath = this.getRunMetadataPath(runId);
    try {
      const json = await fs.readFile(metadataPath, 'utf-8');
      return JSON.parse(json) as Run;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * ログファイル全体を読み込み
   *
   * @param runId 実行ID
   * @returns ログ内容、存在しない場合null
   */
  async readLog(runId: string): Promise<string | null> {
    const logPath = this.getLogFilePath(runId);
    try {
      return await fs.readFile(logPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
}
