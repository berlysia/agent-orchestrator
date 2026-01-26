/**
 * PlanningSessionEffects インターフェース
 *
 * Planning Sessionの保存・読み込みの副作用を抽象化するインターフェース。
 * すべての操作は Result<T, TaskStoreError> を返し、エラーハンドリングを統一する。
 */

import type { Result } from 'option-t/plain_result';
import type { TaskStoreError } from '../../types/errors.ts';
import type { PlanningSession } from '../../types/planning-session.ts';

/**
 * Planning Sessionの概要情報
 * WHY: セッション一覧表示時に、完全なセッションデータではなく必要最小限の情報のみを返す
 */
export interface PlanningSessionSummary {
  /** セッションID */
  sessionId: string;
  /** ユーザーからの元の指示 */
  instruction: string;
  /** 現在の状態 */
  status: string;
  /** セッション作成日時 */
  createdAt: string;
  /** 質問数 */
  questionCount: number;
  /** 決定点数 */
  decisionCount: number;
}

/**
 * PlanningSessionEffects インターフェース
 *
 * Planning Sessionの保存・読み込み操作の副作用を抽象化。
 * テスト時にはモックで置き換え可能。
 */
export interface PlanningSessionEffects {
  /**
   * planning-sessions ディレクトリが存在することを保証
   */
  ensureSessionsDir(): Promise<Result<void, TaskStoreError>>;

  /**
   * Planning Sessionを保存（updatedAt自動更新）
   * @param session PlanningSession オブジェクト
   */
  saveSession(session: PlanningSession): Promise<Result<void, TaskStoreError>>;

  /**
   * Planning Sessionを読み込み
   * @param sessionId セッションID
   * @returns PlanningSession オブジェクト（存在しない場合はエラー）
   */
  loadSession(sessionId: string): Promise<Result<PlanningSession, TaskStoreError>>;

  /**
   * セッションが存在するか確認
   * @param sessionId セッションID
   * @returns 存在する場合はtrue
   */
  sessionExists(sessionId: string): Promise<Result<boolean, TaskStoreError>>;

  /**
   * すべてのPlanning Sessionを一覧取得
   * @returns セッション概要の配列（作成日時の降順）
   */
  listSessions(): Promise<Result<PlanningSessionSummary[], TaskStoreError>>;

  /**
   * logs ディレクトリが存在することを保証
   */
  ensureLogsDir(): Promise<Result<void, TaskStoreError>>;

  /**
   * ログファイルに追記
   * @param logPath ログファイルの絶対パス
   * @param content 追記する内容
   */
  appendLog(logPath: string, content: string): Promise<Result<void, TaskStoreError>>;
}
