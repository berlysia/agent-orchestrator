/**
 * Exploration Session Effects
 *
 * ADR-025: 自律探索モード
 *
 * 探索セッションの永続化操作を抽象化するインターフェース。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr, isErr } from 'option-t/plain_result';
import {
  type ExplorationSession,
  ExplorationSessionSchema,
} from '../../types/exploration-session.ts';

/**
 * 探索セッションエラー
 */
export interface ExplorationSessionError {
  message: string;
  cause?: unknown;
}

/**
 * 探索セッション操作インターフェース
 */
export interface ExplorationSessionEffects {
  /**
   * セッションを保存
   */
  save(session: ExplorationSession): Promise<Result<void, ExplorationSessionError>>;

  /**
   * セッションを読み込み
   */
  load(sessionId: string): Promise<Result<ExplorationSession, ExplorationSessionError>>;

  /**
   * 全セッション一覧を取得
   */
  list(): Promise<Result<ExplorationSession[], ExplorationSessionError>>;

  /**
   * 最新のセッションを取得
   */
  getLatest(): Promise<Result<ExplorationSession | null, ExplorationSessionError>>;

  /**
   * セッションを削除
   */
  delete(sessionId: string): Promise<Result<void, ExplorationSessionError>>;
}

/**
 * ファイルベースの探索セッション永続化実装
 */
export function createExplorationSessionEffects(
  coordRepoPath: string,
): ExplorationSessionEffects {
  const explorationDir = path.join(coordRepoPath, 'explorations');

  /**
   * ディレクトリを確保
   */
  const ensureDir = async (): Promise<Result<void, ExplorationSessionError>> => {
    try {
      await fs.mkdir(explorationDir, { recursive: true });
      return createOk(undefined);
    } catch (error) {
      return createErr({
        message: `Failed to create exploration directory: ${error}`,
        cause: error,
      });
    }
  };

  /**
   * セッションファイルパスを取得
   */
  const getSessionPath = (sessionId: string): string => {
    return path.join(explorationDir, `${sessionId}.json`);
  };

  return {
    async save(session: ExplorationSession): Promise<Result<void, ExplorationSessionError>> {
      const ensureResult = await ensureDir();
      if (isErr(ensureResult)) {
        return ensureResult;
      }

      try {
        const filePath = getSessionPath(session.sessionId);
        await fs.writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
        return createOk(undefined);
      } catch (error) {
        return createErr({
          message: `Failed to save exploration session: ${error}`,
          cause: error,
        });
      }
    },

    async load(sessionId: string): Promise<Result<ExplorationSession, ExplorationSessionError>> {
      try {
        const filePath = getSessionPath(sessionId);
        const content = await fs.readFile(filePath, 'utf-8');
        const data = JSON.parse(content);
        const parsed = ExplorationSessionSchema.safeParse(data);

        if (!parsed.success) {
          return createErr({
            message: `Invalid session data: ${parsed.error.message}`,
          });
        }

        return createOk(parsed.data);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return createErr({
            message: `Session not found: ${sessionId}`,
          });
        }
        return createErr({
          message: `Failed to load exploration session: ${error}`,
          cause: error,
        });
      }
    },

    async list(): Promise<Result<ExplorationSession[], ExplorationSessionError>> {
      const ensureResult = await ensureDir();
      if (isErr(ensureResult)) {
        return ensureResult;
      }

      try {
        const files = await fs.readdir(explorationDir);
        const sessions: ExplorationSession[] = [];

        for (const file of files) {
          if (!file.endsWith('.json')) {
            continue;
          }

          const sessionId = file.replace('.json', '');
          const loadResult = await this.load(sessionId);
          if (loadResult.ok) {
            sessions.push(loadResult.val);
          }
        }

        // 作成日時でソート（新しい順）
        sessions.sort((a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );

        return createOk(sessions);
      } catch (error) {
        return createErr({
          message: `Failed to list exploration sessions: ${error}`,
          cause: error,
        });
      }
    },

    async getLatest(): Promise<Result<ExplorationSession | null, ExplorationSessionError>> {
      const listResult = await this.list();
      if (isErr(listResult)) {
        return listResult;
      }

      const sessions = listResult.val;
      if (sessions.length === 0) {
        return createOk(null);
      }

      return createOk(sessions[0] ?? null);
    },

    async delete(sessionId: string): Promise<Result<void, ExplorationSessionError>> {
      try {
        const filePath = getSessionPath(sessionId);
        await fs.unlink(filePath);
        return createOk(undefined);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          // ファイルが存在しない場合は成功とみなす
          return createOk(undefined);
        }
        return createErr({
          message: `Failed to delete exploration session: ${error}`,
          cause: error,
        });
      }
    },
  };
}
