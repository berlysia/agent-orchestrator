/**
 * Session Pointer Manager Implementation (ADR-027)
 *
 * latest.json/previous.jsonポインタファイルの管理実装。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr } from 'option-t/plain_result';
import type { SessionLogError } from '../../types/errors.ts';
import { sessionPointerError } from '../../types/errors.ts';
import { SessionPointerSchema } from '../../types/session-log.ts';
import type { SessionPointerManager, SessionPointerInfo } from './session-logger.ts';

/**
 * ファイルベースのセッションポインタ管理実装
 */
export class FileSessionPointerManager implements SessionPointerManager {
  private readonly basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /**
   * ポインタファイルのパスを取得
   */
  private getPointerPath(type: 'latest' | 'previous'): string {
    return path.join(this.basePath, 'sessions', `${type}.json`);
  }

  /**
   * ディレクトリが存在することを確認し、なければ作成
   */
  private async ensureDirectory(): Promise<void> {
    const sessionsDir = path.join(this.basePath, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
  }

  /**
   * ポインタファイルを読み込む
   */
  private async readPointer(
    type: 'latest' | 'previous',
  ): Promise<Result<SessionPointerInfo, SessionLogError>> {
    try {
      const filePath = this.getPointerPath(type);
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      const validated = SessionPointerSchema.parse(parsed);
      return createOk(validated);
    } catch (error) {
      return createErr(sessionPointerError(type, error));
    }
  }

  /**
   * ポインタファイルを書き込む
   */
  private async writePointer(
    type: 'latest' | 'previous',
    info: SessionPointerInfo,
  ): Promise<Result<void, SessionLogError>> {
    try {
      await this.ensureDirectory();
      const filePath = this.getPointerPath(type);
      const content = JSON.stringify(info, null, 2);
      await fs.writeFile(filePath, content, 'utf-8');
      return createOk(undefined);
    } catch (error) {
      return createErr(sessionPointerError(type, error));
    }
  }

  async getLatest(): Promise<Result<SessionPointerInfo, SessionLogError>> {
    return this.readPointer('latest');
  }

  async getPrevious(): Promise<Result<SessionPointerInfo, SessionLogError>> {
    return this.readPointer('previous');
  }

  async updateLatest(info: SessionPointerInfo): Promise<Result<void, SessionLogError>> {
    // 現在のlatestをpreviousにローテーション
    const currentLatest = await this.readPointer('latest');
    if (currentLatest.ok) {
      const rotateResult = await this.writePointer('previous', currentLatest.val);
      if (!rotateResult.ok) {
        // ローテーション失敗は警告のみ（新しいlatest書き込みは続行）
        console.warn('Failed to rotate previous pointer:', rotateResult.err);
      }
    }

    // 新しいlatestを書き込む
    return this.writePointer('latest', info);
  }

  async updateStatus(
    sessionId: string,
    status: 'running' | 'completed' | 'aborted',
  ): Promise<Result<void, SessionLogError>> {
    // latestポインタを読み込んで、該当セッションなら更新
    const latestResult = await this.readPointer('latest');
    if (latestResult.ok && latestResult.val.sessionId === sessionId) {
      const updated: SessionPointerInfo = {
        ...latestResult.val,
        status,
      };
      return this.writePointer('latest', updated);
    }

    // previousにある場合も更新
    const previousResult = await this.readPointer('previous');
    if (previousResult.ok && previousResult.val.sessionId === sessionId) {
      const updated: SessionPointerInfo = {
        ...previousResult.val,
        status,
      };
      return this.writePointer('previous', updated);
    }

    // 該当セッションが見つからない場合はエラーにしない（成功とする）
    return createOk(undefined);
  }

  /**
   * ポインタファイルが存在するか確認
   */
  async exists(type: 'latest' | 'previous'): Promise<boolean> {
    try {
      const filePath = this.getPointerPath(type);
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * セッションポインタマネージャのファクトリ関数
 */
export function createSessionPointerManager(basePath: string): SessionPointerManager {
  return new FileSessionPointerManager(basePath);
}
