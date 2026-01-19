import { promises as fs } from 'fs';
import path from 'path';
import { createErr, createOk } from 'option-t/plain_result';
import { tryCatchIntoResultAsync } from 'option-t/plain_result/try_catch_async';
import type { Result } from 'option-t/plain_result';
import type { TaskStoreError } from '../../types/errors.ts';
import { ioError } from '../../types/errors.ts';
import type { PlannerSessionEffects, PlannerSessionSummary } from './planner-session-effects.ts';
import { PlannerSessionSchema, type PlannerSession } from '../../types/planner-session.ts';

/**
 * PlannerSessionEffects の実装
 */
export class PlannerSessionEffectsImpl implements PlannerSessionEffects {
  #coordRepoPath: string;

  constructor(coordRepoPath: string) {
    this.#coordRepoPath = coordRepoPath;
  }

  private getSessionsDir(): string {
    return path.join(this.#coordRepoPath, 'planner-sessions');
  }

  private getSessionPath(sessionId: string): string {
    return path.join(this.getSessionsDir(), `${sessionId}.json`);
  }

  /**
   * planner-sessions ディレクトリが存在することを保証
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
   * プランナーセッションを保存
   */
  async saveSession(session: PlannerSession): Promise<Result<void, TaskStoreError>> {
    const ensureResult = await this.ensureSessionsDir();
    if (!ensureResult.ok) {
      return ensureResult;
    }

    // updatedAtを更新
    const updatedSession: PlannerSession = {
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
   * プランナーセッションを読み込み
   */
  async loadSession(sessionId: string): Promise<Result<PlannerSession, TaskStoreError>> {
    return tryCatchIntoResultAsync(async () => {
      const sessionPath = this.getSessionPath(sessionId);
      const content = await fs.readFile(sessionPath, 'utf-8');
      const json = JSON.parse(content);

      // Zodでバリデーション
      const parseResult = PlannerSessionSchema.safeParse(json);
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
   * すべてのプランナーセッションを一覧取得
   * WHY: 作成日時の降順でソートすることで、最新のセッションを先頭に表示
   */
  async listSessions(): Promise<Result<PlannerSessionSummary[], TaskStoreError>> {
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
      const summaries: PlannerSessionSummary[] = [];
      for (const file of jsonFiles) {
        try {
          const filePath = path.join(sessionsDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const json = JSON.parse(content);

          // Zodでバリデーション
          const parseResult = PlannerSessionSchema.safeParse(json);
          if (parseResult.success) {
            const session = parseResult.data;
            summaries.push({
              sessionId: session.sessionId,
              instruction: session.instruction,
              createdAt: session.createdAt,
              taskCount: session.generatedTasks.length,
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
}
