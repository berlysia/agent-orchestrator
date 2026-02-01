/**
 * Report Reader Implementation (ADR-032)
 *
 * 生成済みレポートを読み込むためのインターフェースと実装。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr } from 'option-t/plain_result';
import type { ReportError } from '../../types/errors.ts';
import { reportReadError, reportNotFound } from '../../types/errors.ts';
import type { ReportType, ReportMetadata } from './types.ts';

/**
 * レポート読み取りインターフェース
 */
export interface ReportReader {
  /**
   * セッションレポートを読み込む
   *
   * @param sessionId セッションID
   * @param reportPath レポートファイル名（例: '00-planning.md'）
   * @returns レポート内容またはエラー
   */
  readReport(sessionId: string, reportPath: string): Promise<Result<string, ReportError>>;

  /**
   * タスクレポートを読み込む
   *
   * @param sessionId セッションID
   * @param taskId タスクID
   * @param reportType レポートタイプ（例: '00-scope.md'）
   * @returns レポート内容またはエラー
   */
  readTaskReport(
    sessionId: string,
    taskId: string,
    reportType: string,
  ): Promise<Result<string, ReportError>>;

  /**
   * セッションのレポート一覧を取得
   *
   * @param sessionId セッションID
   * @returns レポートファイル名の配列またはエラー
   */
  listReports(sessionId: string): Promise<Result<string[], ReportError>>;

  /**
   * タスクのレポート一覧を取得
   *
   * @param sessionId セッションID
   * @param taskId タスクID
   * @returns レポートファイル名の配列またはエラー
   */
  listTaskReports(sessionId: string, taskId: string): Promise<Result<string[], ReportError>>;

  /**
   * レポートのメタデータを取得
   *
   * @param sessionId セッションID
   * @param reportPath レポートファイルパス
   * @returns メタデータまたはエラー
   */
  getReportMetadata(
    sessionId: string,
    reportPath: string,
  ): Promise<Result<ReportMetadata, ReportError>>;
}

/**
 * ファイルベースのレポート読み取り実装
 */
export class FileReportReader implements ReportReader {
  private readonly basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /**
   * レポートディレクトリのパスを取得
   */
  private getReportsDir(sessionId: string): string {
    return path.join(this.basePath, 'reports', sessionId);
  }

  /**
   * タスクレポートディレクトリのパスを取得
   */
  private getTaskReportsDir(sessionId: string, taskId: string): string {
    return path.join(this.basePath, 'reports', sessionId, 'tasks', taskId);
  }

  async readReport(
    sessionId: string,
    reportPath: string,
  ): Promise<Result<string, ReportError>> {
    const filePath = path.join(this.getReportsDir(sessionId), reportPath);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return createOk(content);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return createErr(reportNotFound(filePath));
      }
      return createErr(reportReadError(filePath, error));
    }
  }

  async readTaskReport(
    sessionId: string,
    taskId: string,
    reportType: string,
  ): Promise<Result<string, ReportError>> {
    const filePath = path.join(this.getTaskReportsDir(sessionId, taskId), reportType);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return createOk(content);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return createErr(reportNotFound(filePath));
      }
      return createErr(reportReadError(filePath, error));
    }
  }

  async listReports(sessionId: string): Promise<Result<string[], ReportError>> {
    const dir = this.getReportsDir(sessionId);

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const reports = entries
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => e.name)
        .sort();
      return createOk(reports);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return createOk([]); // ディレクトリが存在しない場合は空配列
      }
      return createErr(reportReadError(dir, error));
    }
  }

  async listTaskReports(
    sessionId: string,
    taskId: string,
  ): Promise<Result<string[], ReportError>> {
    const dir = this.getTaskReportsDir(sessionId, taskId);

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const reports = entries
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => e.name)
        .sort();
      return createOk(reports);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return createOk([]); // ディレクトリが存在しない場合は空配列
      }
      return createErr(reportReadError(dir, error));
    }
  }

  async getReportMetadata(
    sessionId: string,
    reportPath: string,
  ): Promise<Result<ReportMetadata, ReportError>> {
    const filePath = path.join(this.getReportsDir(sessionId), reportPath);

    try {
      const stat = await fs.stat(filePath);
      const type = inferReportType(reportPath);

      // タスクIDを抽出（tasks/task-001/00-scope.md のようなパスから）
      const taskIdMatch = reportPath.match(/tasks\/([^/]+)\//);
      const taskId = taskIdMatch?.[1];

      return createOk({
        type,
        sessionId,
        taskId,
        createdAt: stat.birthtime.toISOString(),
        filePath,
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return createErr(reportNotFound(filePath));
      }
      return createErr(reportReadError(filePath, error));
    }
  }
}

/**
 * ファイル名からレポートタイプを推測
 */
function inferReportType(filename: string): ReportType {
  const base = path.basename(filename);

  if (base.startsWith('00-planning')) return 'planning';
  if (base.startsWith('01-task-breakdown')) return 'task-breakdown';
  if (base.startsWith('00-scope')) return 'scope';
  if (base.startsWith('01-execution')) return 'execution';
  if (base.startsWith('02-review')) return 'review';
  if (base === 'summary.md') return 'summary';

  // デフォルト
  return 'summary';
}

/**
 * ReportReaderのファクトリ関数
 */
export function createReportReader(basePath: string): ReportReader {
  return new FileReportReader(basePath);
}
