import type { Result } from 'option-t/plain_result';
import { createOk, createErr, isErr } from 'option-t/plain_result';
import type { TaskStoreError } from '../../types/errors.ts';
import { ioError } from '../../types/errors.ts';
import type {
  LeaderSession,
  EscalationRecord,
  EscalationTarget,
} from '../../types/leader-session.ts';
import { LeaderSessionStatus, ESCALATION_LIMITS } from '../../types/leader-session.ts';
import type { Task } from '../../types/task.ts';
import type { TaskId } from '../../types/branded.ts';
import { randomUUID } from 'node:crypto';
import type { LeaderDeps } from './leader-operations.ts';
import { escalateToUser, escalateToPlanner } from './leader-operations.ts';
import { replanFailedTask, markTaskAsReplanned } from './replanning-operations.ts';

/**
 * エスカレーション記録作成ヘルパー
 *
 * WHY: Phase 2 Task 4 - エスカレーション記録作成ロジックを共通化
 *
 * @param target エスカレーション先
 * @param reason エスカレーション理由
 * @param relatedTaskId 関連タスク ID
 * @returns エスカレーション記録
 */
export function createEscalationRecord(
  target: EscalationTarget,
  reason: string,
  relatedTaskId?: TaskId,
): EscalationRecord {
  return {
    id: randomUUID(),
    target,
    reason,
    relatedTaskId: relatedTaskId ?? null,
    escalatedAt: new Date().toISOString(),
    resolved: false,
    resolvedAt: null,
    resolution: null,
  };
}

/**
 * ユーザーエスカレーション処理
 *
 * WHY: Phase 2 Task 4 - User エスカレーション記録と停止
 *
 * Phase 2 実装範囲:
 * - エスカレーション記録を作成
 * - セッション状態を ESCALATING に更新
 * - ログ出力
 *
 * Phase 3 以降:
 * - 対話型 CLI で解決（`agent lead resolve`）
 * - セッション再開機能
 *
 * @param deps Leader 依存関係
 * @param session Leader セッション
 * @param reason エスカレーション理由
 * @param relatedTaskId 関連タスク ID
 * @returns 更新された Leader セッション
 */
export async function handleUserEscalation(
  deps: LeaderDeps,
  session: LeaderSession,
  reason: string,
  relatedTaskId?: TaskId,
): Promise<Result<LeaderSession, TaskStoreError>> {
  try {
    console.log(`\n⚠️  Escalating to User`);
    console.log(`   Reason: ${reason}`);
    if (relatedTaskId) {
      console.log(`   Related Task: ${relatedTaskId}`);
    }

    // エスカレーション記録と停止
    const escalationResult = await escalateToUser(deps, session, reason, relatedTaskId);
    if (isErr(escalationResult)) {
      return escalationResult;
    }

    console.log(`   ⏸️  Execution stopped, awaiting user resolution (Phase 3)`);
    console.log(`   Session ID: ${session.sessionId}`);
    console.log(`   Run 'agent lead resolve ${session.sessionId}' to resolve (Phase 3 feature)`);

    return escalationResult;
  } catch (error) {
    return createErr(ioError(`Failed to handle user escalation: ${String(error)}`));
  }
}

/**
 * Planner エスカレーション処理（再計画実行）
 *
 * WHY: Phase 2 Task 4 - Planner 再計画を実際に実行
 *
 * Phase 2 実装範囲:
 * - エスカレーション記録を作成
 * - `replanFailedTask()` で再計画を実行
 * - `markTaskAsReplanned()` で元タスクを REPLACED_BY_REPLAN 状態に
 * - 新タスクを TaskStore に登録
 *
 * @param deps Leader 依存関係
 * @param session Leader セッション
 * @param task 失敗したタスク
 * @param runLog Worker 実行ログ
 * @param reason エスカレーション理由
 * @returns 更新された Leader セッションと新タスク ID リスト
 */
export async function handlePlannerEscalation(
  deps: LeaderDeps,
  session: LeaderSession,
  task: Task,
  runLog: string,
  reason: string,
): Promise<Result<{ session: LeaderSession; newTaskIds: TaskId[] }, TaskStoreError>> {
  try {
    console.log(`\n🔄 Escalating to Planner for replanning`);
    console.log(`   Task: ${task.id}`);
    console.log(`   Reason: ${reason}`);

    // エスカレーション回数チェック
    if (session.escalationAttempts.planner >= ESCALATION_LIMITS.planner) {
      return createErr(
        ioError(
          `Escalation limit reached for planner (${ESCALATION_LIMITS.planner} times)`,
        ),
      );
    }

    // エスカレーション記録を作成
    const escalationResult = await escalateToPlanner(deps, session, reason, task.id);
    if (isErr(escalationResult)) {
      return escalationResult;
    }
    const updatedSession = escalationResult.val;

    // Judge 判定結果を取得（最新の履歴から）
    const latestHistory = updatedSession.memberTaskHistory
      .filter((h) => h.taskId === task.id)
      .sort(
        (a, b) =>
          new Date(b.assignedAt).getTime() - new Date(a.assignedAt).getTime(),
      )[0];

    if (!latestHistory?.judgementResult) {
      return createErr(
        ioError(`No judgement result found for task ${task.id}`),
      );
    }

    const judgement = {
      taskId: latestHistory.judgementResult.taskId,
      success: latestHistory.judgementResult.success,
      shouldContinue: latestHistory.judgementResult.shouldContinue,
      shouldReplan: latestHistory.judgementResult.shouldReplan,
      alreadySatisfied: latestHistory.judgementResult.alreadySatisfied,
      reason: latestHistory.judgementResult.reason,
      missingRequirements: latestHistory.judgementResult.missingRequirements ?? [],
    };

    // Planner 依存関係を構築
    // WHY: replanFailedTask() は PlannerDeps を要求するが、sessionEffects は使用しない
    //      ため、ダミーの実装を渡す
    const plannerDeps = {
      taskStore: deps.taskStore,
      runnerEffects: deps.runnerEffects,
      sessionEffects: {
        // ダミー実装（replanFailedTask は使用しない）
        ensureSessionsDir: async () => createOk(undefined),
        saveSession: async () => createOk(undefined),
        loadSession: async () => createErr(ioError('Not implemented')),
        sessionExists: async () => createOk(false),
        listSessions: async () => createOk([]),
      },
      appRepoPath: deps.coordRepoPath,
      coordRepoPath: deps.coordRepoPath,
      agentType: deps.agentType,
      model: deps.model,
      judgeModel: deps.model, // Leader には judgeModel がないため、model を使用
      userInstruction: '', // Leader セッションには元のユーザー指示がないため空文字列
    };

    // Planner 再計画を実行
    console.log(`   🤖 Running Planner replanning...`);
    const replanResult = await replanFailedTask(plannerDeps, task, runLog, judgement);
    if (isErr(replanResult)) {
      console.error(`   ❌ Replanning failed: ${replanResult.err.message}`);
      return createErr(
        ioError(`Failed to replan task: ${replanResult.err.message}`),
      );
    }

    const { taskIds: newTaskIds } = replanResult.val;
    console.log(`   ✅ Replanning completed, generated ${newTaskIds.length} new tasks`);

    // 元タスクを REPLACED_BY_REPLAN 状態にマーク
    const markResult = await markTaskAsReplanned(
      deps.taskStore,
      task.id,
      newTaskIds,
      judgement,
    );
    if (isErr(markResult)) {
      console.error(`   ⚠️  Failed to mark task as replanned: ${markResult.err.message}`);
      // エラーだがreplan自体は成功しているので継続
    } else {
      console.log(`   📝 Marked original task ${task.id} as REPLACED_BY_REPLAN`);
    }

    // セッション状態を EXECUTING に戻す（再計画後は実行続行）
    const finalSession: LeaderSession = {
      ...updatedSession,
      status: LeaderSessionStatus.EXECUTING,
      updatedAt: new Date().toISOString(),
    };

    const saveResult = await deps.sessionEffects.saveSession(finalSession);
    if (isErr(saveResult)) {
      return saveResult;
    }

    console.log(`   ▶️  Resuming execution with new tasks`);

    return createOk({ session: finalSession, newTaskIds });
  } catch (error) {
    return createErr(ioError(`Failed to handle planner escalation: ${String(error)}`));
  }
}

/**
 * 技術的困難エスカレーション処理
 *
 * WHY: Phase 2 Task 4 - LogicValidator/ExternalAdvisor が Phase 3 で実装されるまで
 *      User へフォールバック
 *
 * Phase 2 実装範囲:
 * - 技術的困難を User エスカレーションへフォールバック
 * - フォールバック理由をログ出力
 *
 * Phase 3 以降:
 * - LogicValidator への LLM 呼び出し
 * - ExternalAdvisor への通信
 *
 * @param deps Leader 依存関係
 * @param session Leader セッション
 * @param reason エスカレーション理由
 * @param relatedTaskId 関連タスク ID
 * @returns 更新された Leader セッション
 */
export async function handleTechnicalEscalation(
  deps: LeaderDeps,
  session: LeaderSession,
  reason: string,
  relatedTaskId?: TaskId,
): Promise<Result<LeaderSession, TaskStoreError>> {
  try {
    console.log(`\n🔧 Technical difficulty detected`);
    console.log(`   Reason: ${reason}`);
    console.log(`   ⚠️  LogicValidator/ExternalAdvisor not available in Phase 2`);
    console.log(`   ↪️  Falling back to User escalation`);

    // User エスカレーションへフォールバック
    const fallbackReason = `[Technical difficulty] ${reason}\n\nNote: LogicValidator/ExternalAdvisor will be available in Phase 3.`;
    return await handleUserEscalation(deps, session, fallbackReason, relatedTaskId);
  } catch (error) {
    return createErr(ioError(`Failed to handle technical escalation: ${String(error)}`));
  }
}

/**
 * エスカレーション履歴を取得
 *
 * WHY: Phase 3 以降の対話型エスカレーション解決で使用
 *
 * @param session Leader セッション
 * @param resolved 解決済みフラグ（オプショナル）
 * @returns エスカレーション記録リスト
 */
export function getEscalationHistory(
  session: LeaderSession,
  resolved?: boolean,
): EscalationRecord[] {
  if (resolved === undefined) {
    return session.escalationRecords;
  }
  return session.escalationRecords.filter((r) => r.resolved === resolved);
}

/**
 * 未解決エスカレーションを取得
 *
 * WHY: Phase 3 以降の対話型エスカレーション解決で使用
 *
 * @param session Leader セッション
 * @returns 未解決エスカレーション記録リスト
 */
export function getPendingEscalations(session: LeaderSession): EscalationRecord[] {
  return getEscalationHistory(session, false);
}
