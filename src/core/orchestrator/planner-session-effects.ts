/**
 * PlannerSessionEffects インターフェース
 *
 * プランナーセッションの保存・読み込みの副作用を抽象化するインターフェース。
 * すべての操作は Result<T, TaskStoreError> を返し、エラーハンドリングを統一する。
 */

import type { Result } from 'option-t/plain_result';
import type { TaskStoreError } from '../../types/errors.ts';
import type { PlannerSession } from '../../types/planner-session.ts';

/**
 * プランナーセッションの概要情報
 * WHY: セッション一覧表示時に、完全なセッションデータではなく必要最小限の情報のみを返す
 */
export interface PlannerSessionSummary {
  /** セッションID */
  sessionId: string;
  /** ユーザーからの元の指示 */
  instruction: string;
  /** セッション作成日時 */
  createdAt: string;
  /** 生成されたタスクの数 */
  taskCount: number;
}

/**
 * PlannerSessionEffects インターフェース
 *
 * プランナーセッションの保存・読み込み操作の副作用を抽象化。
 * テスト時にはモックで置き換え可能。
 */
export interface PlannerSessionEffects {
  /**
   * planner-sessions ディレクトリが存在することを保証
   */
  ensureSessionsDir(): Promise<Result<void, TaskStoreError>>;

  /**
   * プランナーセッションを保存
   * @param session PlannerSession オブジェクト
   */
  saveSession(session: PlannerSession): Promise<Result<void, TaskStoreError>>;

  /**
   * プランナーセッションを読み込み
   * @param sessionId セッションID
   * @returns PlannerSession オブジェクト（存在しない場合はエラー）
   */
  loadSession(sessionId: string): Promise<Result<PlannerSession, TaskStoreError>>;

  /**
   * セッションが存在するか確認
   * @param sessionId セッションID
   * @returns 存在する場合はtrue
   */
  sessionExists(sessionId: string): Promise<Result<boolean, TaskStoreError>>;

  /**
   * すべてのプランナーセッションを一覧取得
   * @returns セッション概要の配列（作成日時の降順）
   */
  listSessions(): Promise<Result<PlannerSessionSummary[], TaskStoreError>>;
}
