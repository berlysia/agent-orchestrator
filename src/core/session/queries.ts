/**
 * Session query functions
 *
 * WHY: セッション管理の問い合わせ操作を集約し、他のモジュールから利用しやすくする
 */

import type { Result } from 'option-t/plain_result';
import { createOk } from 'option-t/plain_result';
import type { TaskStoreError } from '../../types/errors.ts';
import type { PlannerSession } from '../../types/planner-session.ts';
import type { PlannerSessionEffects } from '../orchestrator/planner-session-effects.ts';

/**
 * rootSessionIdから連鎖内の全セッションを取得
 *
 * WHY: continue で追加されたセッションも含めて、元のセッションチェーン全体のセッションを取得
 *      監視レポート生成やセッション管理に必要
 *
 * 実装ロジック:
 * 1. rootSessionIdと一致するセッションを検索（rootセッション自身）
 * 2. parentSessionIdがrootSessionIdまたはその子孫のセッションを再帰的に収集
 *
 * @param rootSessionId ルートセッションID
 * @param sessionEffects セッション操作インターフェース
 * @returns ルートセッションに属する全セッションの配列（作成日時の昇順）
 */
export async function listSessionsByRootId(
  rootSessionId: string,
  sessionEffects: PlannerSessionEffects,
): Promise<Result<PlannerSession[], TaskStoreError>> {
  // すべてのセッションを取得
  const listResult = await sessionEffects.listSessions();
  if (!listResult.ok) {
    return listResult as Result<PlannerSession[], TaskStoreError>;
  }

  const sessionSummaries = listResult.val;

  // 各セッションの詳細を読み込む（並列実行）
  const loadPromises = sessionSummaries.map((summary) => sessionEffects.loadSession(summary.sessionId));
  const loadResults = await Promise.all(loadPromises);

  // 読み込み成功したセッションのみを抽出
  const allSessions: PlannerSession[] = [];
  for (const result of loadResults) {
    if (result.ok) {
      allSessions.push(result.val);
    }
  }

  // rootSessionIdに属するセッションをフィルタリング
  const chainSessions = filterSessionsByRootId(rootSessionId, allSessions);

  // 作成日時の昇順でソート（時系列順に並べる）
  chainSessions.sort((a, b) => {
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  return createOk(chainSessions);
}

/**
 * rootSessionIdに属するセッションをフィルタリング
 *
 * WHY: セッション連鎖を正しく追跡するためのヘルパー関数
 *
 * フィルタリングロジック:
 * 1. sessionId === rootSessionId（ルート自身）
 * 2. rootSessionId === rootSessionId（明示的に設定されている場合）
 * 3. parentSessionIdを辿ってrootSessionIdに到達できる（連鎖の一部）
 *
 * @param rootSessionId ルートセッションID
 * @param sessions 検索対象のセッション配列
 * @returns ルートセッションに属するセッション配列
 */
function filterSessionsByRootId(rootSessionId: string, sessions: readonly PlannerSession[]): PlannerSession[] {
  const result: PlannerSession[] = [];
  const sessionMap = new Map<string, PlannerSession>();

  // セッションマップを作成（高速検索用）
  for (const session of sessions) {
    sessionMap.set(session.sessionId, session);
  }

  // 各セッションがrootSessionIdに属するか判定
  for (const session of sessions) {
    if (belongsToRootSession(session, rootSessionId, sessionMap)) {
      result.push(session);
    }
  }

  return result;
}

/**
 * セッションがrootSessionIdに属するか判定
 *
 * WHY: parentSessionIdを再帰的に辿り、循環参照を検出しながらルートセッションへの到達を確認
 *
 * @param session 判定対象のセッション
 * @param rootSessionId ルートセッションID
 * @param sessionMap セッションマップ（高速検索用）
 * @returns rootSessionIdに属する場合はtrue
 */
function belongsToRootSession(
  session: PlannerSession,
  rootSessionId: string,
  sessionMap: Map<string, PlannerSession>,
): boolean {
  // ケース1: sessionId自体がrootSessionId（ルートセッション自身）
  if (session.sessionId === rootSessionId) {
    return true;
  }

  // ケース2: rootSessionIdフィールドが明示的に設定されている
  if (session.rootSessionId === rootSessionId) {
    return true;
  }

  // ケース3: parentSessionIdを辿ってrootSessionIdに到達できるか確認
  const visited = new Set<string>([session.sessionId]);
  let currentSession = session;

  while (currentSession.parentSessionId) {
    const parentId = currentSession.parentSessionId;

    // 親がrootSessionIdの場合
    if (parentId === rootSessionId) {
      return true;
    }

    // 循環参照を検出
    if (visited.has(parentId)) {
      console.warn(`⚠️  Circular session reference detected: ${parentId}`);
      return false;
    }

    // 親セッションを取得
    const parentSession = sessionMap.get(parentId);
    if (!parentSession) {
      // 親セッションが見つからない場合は追跡終了
      return false;
    }

    visited.add(parentId);
    currentSession = parentSession;

    // 親セッション自体がrootSessionIdの場合
    if (currentSession.sessionId === rootSessionId) {
      return true;
    }

    // 親セッションのrootSessionIdフィールドをチェック
    if (currentSession.rootSessionId === rootSessionId) {
      return true;
    }
  }

  return false;
}
