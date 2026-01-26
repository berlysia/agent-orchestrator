import { promises as fs } from 'fs';
import path from 'path';
import { createErr, createOk } from 'option-t/plain_result';
import { tryCatchIntoResultAsync } from 'option-t/plain_result/try_catch_async';
import type { Result } from 'option-t/plain_result';
import type { TaskStoreError } from '../../types/errors.ts';
import { ioError } from '../../types/errors.ts';
import type {
  PlanningSessionEffects,
  PlanningSessionSummary,
} from './planning-session-effects.ts';
import {
  PlanningSessionSchema,
  type PlanningSession,
} from '../../types/planning-session.ts';

/**
 * PlanningSessionEffects の実装
 */
export class PlanningSessionEffectsImpl implements PlanningSessionEffects {
  #coordRepoPath: string;

  constructor(coordRepoPath: string) {
    this.#coordRepoPath = coordRepoPath;
  }

  private getSessionsDir(): string {
    return path.join(this.#coordRepoPath, 'planning-sessions');
  }

  private getSessionPath(sessionId: string): string {
    return path.join(this.getSessionsDir(), `${sessionId}.json`);
  }

  private getLogsDir(): string {
    return path.join(this.#coordRepoPath, 'logs');
  }

  /**
   * セッション保存失敗時のリトライ（最大3回、exponential backoff）
   *
   * WHY: ファイルシステムの一時的なエラー（ロック競合等）を回避する
   */
  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxAttempts: number = 3,
  ): Promise<Result<T, TaskStoreError>> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await tryCatchIntoResultAsync(operation);
      if (result.ok) return result;

      if (attempt < maxAttempts) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
    return createErr(ioError('retryWithBackoff', new Error('Max attempts reached')));
  }

  /**
   * planning-sessions ディレクトリが存在することを保証
   */
  async ensureSessionsDir(): Promise<Result<void, TaskStoreError>> {
    return tryCatchIntoResultAsync(async () => {
      await fs.mkdir(this.getSessionsDir(), { recursive: true });
    }).then((result) => {
      if (!result.ok) {
        return createErr(ioError('ensureSessionsDir', result.err));
      }
      return result;
    });
  }

  /**
   * Planning Sessionを保存（updatedAt自動更新、リトライ付き）
   */
  async saveSession(session: PlanningSession): Promise<Result<void, TaskStoreError>> {
    const ensureResult = await this.ensureSessionsDir();
    if (!ensureResult.ok) {
      return ensureResult;
    }

    // updatedAtを更新
    const updatedSession: PlanningSession = {
      ...session,
      updatedAt: new Date().toISOString(),
    };

    return this.retryWithBackoff(async () => {
      const sessionPath = this.getSessionPath(session.sessionId);
      await fs.writeFile(sessionPath, JSON.stringify(updatedSession, null, 2), 'utf-8');
    });
  }

  /**
   * Planning Sessionを読み込み
   */
  async loadSession(sessionId: string): Promise<Result<PlanningSession, TaskStoreError>> {
    return tryCatchIntoResultAsync(async () => {
      const sessionPath = this.getSessionPath(sessionId);
      const content = await fs.readFile(sessionPath, 'utf-8');
      const json = JSON.parse(content);

      // Zodでバリデーション
      const parseResult = PlanningSessionSchema.safeParse(json);
      if (!parseResult.success) {
        throw new Error(`Invalid session data: ${parseResult.error.message}`);
      }

      return parseResult.data;
    }).then((result) => {
      if (!result.ok) {
        return createErr(ioError('loadSession', result.err));
      }
      return result;
    });
  }

  /**
   * セッションが存在するか確認
   */
  async sessionExists(sessionId: string): Promise<Result<boolean, TaskStoreError>> {
    return tryCatchIntoResultAsync(async () => {
      const sessionPath = this.getSessionPath(sessionId);
      try {
        await fs.access(sessionPath);
        return true;
      } catch {
        return false;
      }
    }).then((result) => {
      if (!result.ok) {
        return createErr(ioError('sessionExists', result.err));
      }
      return result;
    });
  }

  /**
   * すべてのPlanning Sessionを一覧取得
   * WHY: 作成日時の降順でソートすることで、最新のセッションを先頭に表示
   */
  async listSessions(): Promise<Result<PlanningSessionSummary[], TaskStoreError>> {
    return tryCatchIntoResultAsync(async () => {
      const sessionsDir = this.getSessionsDir();

      // セッションディレクトリが存在しない場合は空配列を返す
      try {
        await fs.access(sessionsDir);
      } catch {
        return [];
      }

      // ディレクトリ内のすべてのファイルを取得
      const files = await fs.readdir(sessionsDir);
      const jsonFiles = files.filter((file) => file.endsWith('.json'));

      // 各ファイルを読み込んでサマリーに変換
      const summaries: PlanningSessionSummary[] = [];
      for (const file of jsonFiles) {
        try {
          const filePath = path.join(sessionsDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const json = JSON.parse(content);

          // Zodでバリデーション
          const parseResult = PlanningSessionSchema.safeParse(json);
          if (parseResult.success) {
            const session = parseResult.data;
            summaries.push({
              sessionId: session.sessionId,
              instruction: session.instruction,
              status: session.status,
              createdAt: session.createdAt,
              questionCount: session.questions.length,
              decisionCount: session.decisionPoints.length,
            });
          }
        } catch (error) {
          // 個別のファイル読み込み失敗は無視して続行
          console.warn(`Failed to read session file ${file}:`, error);
        }
      }

      // 作成日時の降順でソート
      summaries.sort((a, b) => {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });

      return summaries;
    }).then((result) => {
      if (!result.ok) {
        return createErr(ioError('listSessions', result.err));
      }
      return createOk(result.val);
    });
  }

  /**
   * logs ディレクトリが存在することを保証
   */
  async ensureLogsDir(): Promise<Result<void, TaskStoreError>> {
    return tryCatchIntoResultAsync(async () => {
      await fs.mkdir(this.getLogsDir(), { recursive: true });
    }).then((result) => {
      if (!result.ok) {
        return createErr(ioError('ensureLogsDir', result.err));
      }
      return result;
    });
  }

  /**
   * ログファイルに追記
   */
  async appendLog(logPath: string, content: string): Promise<Result<void, TaskStoreError>> {
    const ensureResult = await this.ensureLogsDir();
    if (!ensureResult.ok) {
      return ensureResult;
    }

    return tryCatchIntoResultAsync(async () => {
      // ログファイルのディレクトリを確保
      const logDir = path.dirname(logPath);
      await fs.mkdir(logDir, { recursive: true });

      // ログを追記
      await fs.appendFile(logPath, content, 'utf-8');
    }).then((result) => {
      if (!result.ok) {
        return createErr(ioError('appendLog', result.err));
      }
      return result;
    });
  }
}
