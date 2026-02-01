/**
 * NDJSON Session Logger Implementation (ADR-027)
 *
 * SessionLoggerインターフェースのNDJSONファイル書き込み実装。
 * 各レコードは独立した行として追記モードで書き込まれる。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr, isErr } from 'option-t/plain_result';
import type { SessionId } from '../../types/branded.ts';
import { sessionId as createSessionId } from '../../types/branded.ts';
import type { SessionLogError } from '../../types/errors.ts';
import { sessionLogWriteError } from '../../types/errors.ts';
import type { SessionLogRecord } from '../../types/session-log.ts';
import {
  createSessionStartRecord,
  createSessionCompleteRecord,
  createSessionAbortRecord,
} from '../../types/session-log.ts';
import type { SessionLogger, SessionPointerManager, SessionPointerInfo } from './session-logger.ts';

/**
 * NDJSONファイルへのセッションロガー実装
 */
export class NdjsonSessionLogger implements SessionLogger {
  private currentSessionId: SessionId | undefined;
  private readonly basePath: string;
  private readonly pointerManager: SessionPointerManager;

  constructor(basePath: string, pointerManager: SessionPointerManager) {
    this.basePath = basePath;
    this.pointerManager = pointerManager;
  }

  /**
   * セッションログファイルのパスを取得
   */
  private getLogFilePath(sid: SessionId | string): string {
    return path.join(this.basePath, 'sessions', `${sid}.jsonl`);
  }

  /**
   * ディレクトリが存在することを確認し、なければ作成
   */
  private async ensureDirectory(): Promise<Result<void, SessionLogError>> {
    try {
      const sessionsDir = path.join(this.basePath, 'sessions');
      await fs.mkdir(sessionsDir, { recursive: true });
      return createOk(undefined);
    } catch (error) {
      return createErr(sessionLogWriteError('directory creation', error));
    }
  }

  /**
   * レコードをファイルに書き込む
   */
  private async writeRecord(
    sid: SessionId | string,
    record: SessionLogRecord,
  ): Promise<Result<void, SessionLogError>> {
    const ensureResult = await this.ensureDirectory();
    if (isErr(ensureResult)) {
      return ensureResult;
    }

    try {
      const filePath = this.getLogFilePath(sid);
      const line = JSON.stringify(record) + '\n';
      await fs.appendFile(filePath, line, 'utf-8');
      return createOk(undefined);
    } catch (error) {
      return createErr(sessionLogWriteError(String(sid), error));
    }
  }

  async start(
    sid: SessionId,
    task: string,
    options?: {
      parentSessionId?: SessionId;
      rootSessionId?: SessionId;
    },
  ): Promise<Result<void, SessionLogError>> {
    this.currentSessionId = sid;

    const record = createSessionStartRecord(sid, task, options);
    const writeResult = await this.writeRecord(sid, record);
    if (isErr(writeResult)) {
      return writeResult;
    }

    // ポインタファイルを更新
    const pointerInfo: SessionPointerInfo = {
      sessionId: String(sid),
      startedAt: record.timestamp,
      status: 'running',
    };
    const pointerResult = await this.pointerManager.updateLatest(pointerInfo);
    if (isErr(pointerResult)) {
      return pointerResult;
    }

    return createOk(undefined);
  }

  async log(record: SessionLogRecord): Promise<Result<void, SessionLogError>> {
    if (!this.currentSessionId) {
      return createErr(
        sessionLogWriteError('unknown', new Error('Session not started')),
      );
    }

    return this.writeRecord(this.currentSessionId, record);
  }

  async complete(
    summary: string,
    options?: {
      tasksCompleted?: number;
      duration?: number;
    },
  ): Promise<Result<void, SessionLogError>> {
    if (!this.currentSessionId) {
      return createErr(
        sessionLogWriteError('unknown', new Error('Session not started')),
      );
    }

    const record = createSessionCompleteRecord(this.currentSessionId, summary, options);
    const writeResult = await this.writeRecord(this.currentSessionId, record);
    if (isErr(writeResult)) {
      return writeResult;
    }

    // ポインタファイルのステータスを更新
    const statusResult = await this.pointerManager.updateStatus(
      String(this.currentSessionId),
      'completed',
    );
    if (isErr(statusResult)) {
      return statusResult;
    }

    this.currentSessionId = undefined;
    return createOk(undefined);
  }

  async abort(reason: string, errorType?: string): Promise<Result<void, SessionLogError>> {
    if (!this.currentSessionId) {
      return createErr(
        sessionLogWriteError('unknown', new Error('Session not started')),
      );
    }

    const record = createSessionAbortRecord(this.currentSessionId, reason, errorType);
    const writeResult = await this.writeRecord(this.currentSessionId, record);
    if (isErr(writeResult)) {
      return writeResult;
    }

    // ポインタファイルのステータスを更新
    const statusResult = await this.pointerManager.updateStatus(
      String(this.currentSessionId),
      'aborted',
    );
    if (isErr(statusResult)) {
      return statusResult;
    }

    this.currentSessionId = undefined;
    return createOk(undefined);
  }

  getCurrentSessionId(): SessionId | undefined {
    return this.currentSessionId;
  }
}

/**
 * セッションIDを生成
 */
export function generateSessionId(prefix: string = 'session'): SessionId {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return createSessionId(`${prefix}-${timestamp}-${random}`);
}

/**
 * NDJSONセッションロガーのファクトリ関数
 */
export function createNdjsonSessionLogger(
  basePath: string,
  pointerManager: SessionPointerManager,
): SessionLogger {
  return new NdjsonSessionLogger(basePath, pointerManager);
}
