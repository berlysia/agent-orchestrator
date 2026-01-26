import type { Result } from 'option-t/plain_result';
import type { TaskStoreError } from '../../types/errors.ts';
import type { LeaderSession } from '../../types/leader-session.ts';

/**
 * Leader Session Summary
 *
 * Leader セッション一覧表示用のサマリー情報
 */
export interface LeaderSessionSummary {
  sessionId: string;
  planFilePath: string;
  status: string;
  createdAt: string;
  completedTaskCount: number;
  totalTaskCount: number;
}

/**
 * Leader Session Effects
 *
 * Leader セッションの永続化と外部通信を抽象化
 */
export interface LeaderSessionEffects {
  /**
   * Leader セッションを保存
   */
  saveSession(session: LeaderSession): Promise<Result<void, TaskStoreError>>;

  /**
   * Leader セッションを読み込み
   */
  loadSession(sessionId: string): Promise<Result<LeaderSession, TaskStoreError>>;

  /**
   * セッションが存在するか確認
   */
  sessionExists(sessionId: string): Promise<Result<boolean, TaskStoreError>>;

  /**
   * すべての Leader セッションを一覧取得
   */
  listSessions(): Promise<Result<LeaderSessionSummary[], TaskStoreError>>;
}
