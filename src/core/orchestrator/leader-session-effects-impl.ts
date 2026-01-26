import { promises as fs } from 'fs';
import path from 'path';
import { createErr } from 'option-t/plain_result';
import { tryCatchIntoResultAsync } from 'option-t/plain_result/try_catch_async';
import type { Result } from 'option-t/plain_result';
import type { TaskStoreError } from '../../types/errors.ts';
import { ioError } from '../../types/errors.ts';
import type { LeaderSessionEffects, LeaderSessionSummary } from './leader-session-effects.ts';
import { LeaderSessionSchema, type LeaderSession } from '../../types/leader-session.ts';

/**
 * LeaderSessionEffects の実装
 */
export class LeaderSessionEffectsImpl implements LeaderSessionEffects {
  #coordRepoPath: string;

  constructor(coordRepoPath: string) {
    this.#coordRepoPath = coordRepoPath;
  }

  private getSessionsDir(): string {
    return path.join(this.#coordRepoPath, 'leader-sessions');
  }

  private getSessionPath(sessionId: string): string {
    return path.join(this.getSessionsDir(), `${sessionId}.json`);
  }

  /**
   * leader-sessions ディレクトリが存在することを保証
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
   * Leader セッションを保存
   */
  async saveSession(session: LeaderSession): Promise<Result<void, TaskStoreError>> {
    const ensureResult = await this.ensureSessionsDir();
    if (!ensureResult.ok) {
      return ensureResult;
    }

    // updatedAt を更新
    const updatedSession: LeaderSession = {
      ...session,
      updatedAt: new Date().toISOString(),
    };

    return tryCatchIntoResultAsync(async () => {
      const sessionPath = this.getSessionPath(session.sessionId);
      await fs.writeFile(sessionPath, JSON.stringify(updatedSession, null, 2), 'utf-8');
    }).then((result) => {
      if (!result.ok) {
        return createErr(ioError('saveSession', result.err));
      }
      return result;
    });
  }

  /**
   * Leader セッションを読み込み
   */
  async loadSession(sessionId: string): Promise<Result<LeaderSession, TaskStoreError>> {
    return tryCatchIntoResultAsync(async () => {
      const sessionPath = this.getSessionPath(sessionId);
      const content = await fs.readFile(sessionPath, 'utf-8');
      const json = JSON.parse(content);

      // Zod でバリデーション
      const parseResult = LeaderSessionSchema.safeParse(json);
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
   * すべての Leader セッションを一覧取得
   *
   * WHY: 作成日時の降順でソートすることで、最新のセッションを先頭に表示
   */
  async listSessions(): Promise<Result<LeaderSessionSummary[], TaskStoreError>> {
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
      const summaries: LeaderSessionSummary[] = [];
      for (const file of jsonFiles) {
        try {
          const filePath = path.join(sessionsDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const json = JSON.parse(content);

          // Zod でバリデーション
          const parseResult = LeaderSessionSchema.safeParse(json);
          if (parseResult.success) {
            const session = parseResult.data;
            summaries.push({
              sessionId: session.sessionId,
              planFilePath: session.planFilePath,
              status: session.status,
              createdAt: session.createdAt,
              completedTaskCount: session.completedTaskCount,
              totalTaskCount: session.totalTaskCount,
            });
          }
        } catch (error) {
          // 個別ファイルの読み込みエラーは無視してスキップ
          console.warn(`Failed to load session file ${file}:`, error);
        }
      }

      // 作成日時の降順でソート
      summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      return summaries;
    }).then((result) => {
      if (!result.ok) {
        return createErr(ioError('listSessions', result.err));
      }
      return result;
    });
  }
}
