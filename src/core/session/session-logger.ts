/**
 * Session Logger Interface (ADR-027)
 *
 * セッションログの書き込みインターフェース定義。
 * 具体実装（NDJSONファイル書き込み）から抽象化し、テスト容易性を確保。
 */

import type { Result } from 'option-t/plain_result';
import type { SessionId } from '../../types/branded.ts';
import type { SessionLogError } from '../../types/errors.ts';
import type { SessionLogRecord } from '../../types/session-log.ts';

/**
 * セッションロガーインターフェース
 *
 * 各セッションのイベントをNDJSON形式で記録する。
 * 書き込みは追記モードで行われ、各行が独立したJSONオブジェクトとなる。
 */
export interface SessionLogger {
  /**
   * セッションを開始し、session_startレコードを書き込む
   *
   * @param sessionId セッションID
   * @param task タスク説明
   * @param options オプション（親セッションID、ルートセッションID）
   * @returns 成功時はvoid、失敗時はSessionLogError
   */
  start(
    sessionId: SessionId,
    task: string,
    options?: {
      parentSessionId?: SessionId;
      rootSessionId?: SessionId;
    },
  ): Promise<Result<void, SessionLogError>>;

  /**
   * 任意のセッションログレコードを書き込む
   *
   * @param record 書き込むレコード
   * @returns 成功時はvoid、失敗時はSessionLogError
   */
  log(record: SessionLogRecord): Promise<Result<void, SessionLogError>>;

  /**
   * セッションを正常完了し、session_completeレコードを書き込む
   *
   * @param summary 完了サマリー
   * @param options オプション（完了タスク数、所要時間）
   * @returns 成功時はvoid、失敗時はSessionLogError
   */
  complete(
    summary: string,
    options?: {
      tasksCompleted?: number;
      duration?: number;
    },
  ): Promise<Result<void, SessionLogError>>;

  /**
   * セッションを異常終了し、session_abortレコードを書き込む
   *
   * @param reason 中断理由
   * @param errorType エラータイプ（オプション）
   * @returns 成功時はvoid、失敗時はSessionLogError
   */
  abort(reason: string, errorType?: string): Promise<Result<void, SessionLogError>>;

  /**
   * 現在のセッションIDを取得
   *
   * @returns 現在のセッションID（未開始の場合はundefined）
   */
  getCurrentSessionId(): SessionId | undefined;
}

/**
 * セッションポインタ操作インターフェース
 *
 * latest.json/previous.jsonポインタファイルを管理する。
 */
export interface SessionPointerManager {
  /**
   * 最新セッションのポインタを取得
   *
   * @returns セッション情報またはエラー
   */
  getLatest(): Promise<Result<SessionPointerInfo, SessionLogError>>;

  /**
   * 前回セッションのポインタを取得
   *
   * @returns セッション情報またはエラー
   */
  getPrevious(): Promise<Result<SessionPointerInfo, SessionLogError>>;

  /**
   * 最新セッションのポインタを更新
   * 古いlatestはpreviousにローテーションされる
   *
   * @param info 新しいセッション情報
   * @returns 成功時はvoid、失敗時はエラー
   */
  updateLatest(info: SessionPointerInfo): Promise<Result<void, SessionLogError>>;

  /**
   * セッションのステータスを更新
   *
   * @param sessionId 更新対象のセッションID
   * @param status 新しいステータス
   * @returns 成功時はvoid、失敗時はエラー
   */
  updateStatus(
    sessionId: string,
    status: 'running' | 'completed' | 'aborted',
  ): Promise<Result<void, SessionLogError>>;
}

/**
 * セッションポインタ情報
 */
export interface SessionPointerInfo {
  sessionId: string;
  startedAt: string;
  status: 'running' | 'completed' | 'aborted';
}

/**
 * セッションログ読み取りインターフェース
 *
 * 記録されたセッションログを読み取る。
 */
export interface SessionLogReader {
  /**
   * セッションログを行単位で読み取る（非同期イテレータ）
   *
   * @param sessionId 読み取るセッションID
   * @returns セッションログレコードの非同期イテレータ
   */
  readSessionLog(sessionId: string): AsyncIterable<SessionLogRecord>;

  /**
   * セッションログの存在確認
   *
   * @param sessionId セッションID
   * @returns 存在すればtrue
   */
  exists(sessionId: string): Promise<boolean>;

  /**
   * 利用可能なセッションIDの一覧を取得
   *
   * @returns セッションIDの配列
   */
  listSessions(): Promise<string[]>;
}
