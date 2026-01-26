import type { TaskStore } from '../task-store/interface.ts';
import type { RunnerEffects } from '../runner/runner-effects.ts';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr, isErr } from 'option-t/plain_result';
import type { TaskStoreError } from '../../types/errors.ts';
import { ioError } from '../../types/errors.ts';
import {
  type LeaderSession,
  LeaderSessionStatus,
  EscalationTarget,
  type EscalationRecord,
  type MemberTaskHistory,
  createLeaderSession,
  ESCALATION_LIMITS,
} from '../../types/leader-session.ts';
import { type Task, type WorkerFeedback, ImpedimentCategory } from '../../types/task.ts';
import { type TaskId } from '../../types/branded.ts';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { LeaderSessionEffects } from './leader-session-effects.ts';

/**
 * Leader 依存関係
 */
export interface LeaderDeps {
  readonly taskStore: TaskStore;
  readonly runnerEffects: RunnerEffects;
  readonly sessionEffects: LeaderSessionEffects;
  readonly coordRepoPath: string;
  readonly agentType: 'claude' | 'codex';
  readonly model: string;
}

/**
 * Leader セッションを初期化
 *
 * 計画文書から Leader セッションを作成し、初期タスクを設定する
 *
 * @param deps Leader 依存関係
 * @param planFilePath 計画文書のファイルパス
 * @param plannerSessionId 関連する PlannerSession ID（オプショナル）
 * @returns 作成された Leader セッション
 */
export async function initializeLeaderSession(
  deps: LeaderDeps,
  planFilePath: string,
  plannerSessionId?: string,
): Promise<Result<LeaderSession, TaskStoreError>> {
  try {
    // 計画文書の存在確認
    const planFileExists = await fs
      .access(planFilePath)
      .then(() => true)
      .catch(() => false);

    if (!planFileExists) {
      return createErr(ioError(`Plan file not found: ${planFilePath}`));
    }

    // セッション ID 生成
    const sessionId = randomUUID();

    // Leader セッション作成
    const session = createLeaderSession(sessionId, planFilePath, plannerSessionId);

    // セッション保存
    const saveResult = await deps.sessionEffects.saveSession(session);
    if (isErr(saveResult)) {
      return saveResult;
    }

    return createOk(session);
  } catch (error) {
    return createErr(ioError(`Failed to initialize leader session: ${String(error)}`));
  }
}

/**
 * Worker への指示を生成
 *
 * タスクとコンテキストを元に、Worker が実行すべき指示を生成する
 *
 * @param deps Leader 依存関係
 * @param session Leader セッション
 * @param task 実行するタスク
 * @returns 生成された指示
 */
export async function assignTaskToMember(
  _deps: LeaderDeps,
  _session: LeaderSession,
  task: Task,
): Promise<Result<string, TaskStoreError>> {
  try {
    // タスクの基本情報から指示を生成
    const instruction = `
Task: ${task.summary || task.acceptance}

Context:
${task.context}

Acceptance Criteria:
${task.acceptance}

Scope:
${task.scopePaths.join('\n')}

Please complete this task according to the acceptance criteria.
`.trim();

    return createOk(instruction);
  } catch (error) {
    return createErr(ioError(`Failed to assign task to member: ${String(error)}`));
  }
}

/**
 * Member フィードバックを処理
 *
 * Worker からのフィードバックを評価し、次のアクションを決定する
 *
 * @param deps Leader 依存関係
 * @param session Leader セッション
 * @param task 実行されたタスク
 * @param feedback Worker フィードバック
 * @returns 更新された Leader セッションと次のアクション
 */
export async function processMemberFeedback(
  _deps: LeaderDeps,
  session: LeaderSession,
  task: Task,
  feedback: WorkerFeedback,
): Promise<
  Result<
    {
      session: LeaderSession;
      nextAction: 'continue' | 'replan' | 'escalate' | 'accept' | 'skip';
      reason: string;
    },
    TaskStoreError
  >
> {
  try {
    // フィードバック種別に応じて処理
    switch (feedback.type) {
      case 'implementation': {
        // 実装タスクの結果を評価
        if (feedback.result === 'success') {
          return createOk({
            session,
            nextAction: 'accept',
            reason: 'Implementation succeeded',
          });
        } else if (feedback.result === 'partial') {
          return createOk({
            session,
            nextAction: 'continue',
            reason: 'Implementation partially succeeded, continue with remaining work',
          });
        } else {
          // 失敗回数をチェック
          const failureCount = session.memberTaskHistory.filter(
            (h) => h.taskId === task.id && h.workerFeedback?.type === 'implementation',
          ).length;

          if (failureCount >= 3) {
            return createOk({
              session,
              nextAction: 'replan',
              reason: 'Task failed 3 times, requesting replanning',
            });
          }

          return createOk({
            session,
            nextAction: 'continue',
            reason: 'Implementation failed, retry with feedback',
          });
        }
      }

      case 'exploration': {
        // 探索タスクの結果を評価
        return createOk({
          session,
          nextAction: 'accept',
          reason: `Exploration completed with ${feedback.confidence} confidence`,
        });
      }

      case 'difficulty': {
        // 困難報告を評価し、エスカレーション先を決定
        const { impediment } = feedback;

        switch (impediment.category) {
          case ImpedimentCategory.AMBIGUITY:
            return createOk({
              session,
              nextAction: 'escalate',
              reason: 'Ambiguous requirements, escalating to user for clarification',
            });

          case ImpedimentCategory.SCOPE:
            return createOk({
              session,
              nextAction: 'escalate',
              reason: 'Scope issue detected, escalating to user for approval',
            });

          case ImpedimentCategory.TECHNICAL:
            return createOk({
              session,
              nextAction: 'escalate',
              reason: 'Technical difficulty, escalating for external advice',
            });

          case ImpedimentCategory.DEPENDENCY:
            return createOk({
              session,
              nextAction: 'replan',
              reason: 'Dependency issue detected, requesting replanning',
            });

          default:
            return createOk({
              session,
              nextAction: 'continue',
              reason: 'Unknown difficulty, attempting to continue',
            });
        }
      }

      default:
        return createErr(ioError(`Unknown feedback type: ${(feedback as any).type}`));
    }
  } catch (error) {
    return createErr(ioError(`Failed to process member feedback: ${String(error)}`));
  }
}

/**
 * ユーザーへエスカレーション
 *
 * 要件の明確化やスコープの承認などをユーザーに求める
 *
 * @param deps Leader 依存関係
 * @param session Leader セッション
 * @param reason エスカレーション理由
 * @param relatedTaskId 関連タスク ID
 * @returns 更新された Leader セッション
 */
export async function escalateToUser(
  deps: LeaderDeps,
  session: LeaderSession,
  reason: string,
  relatedTaskId?: TaskId,
): Promise<Result<LeaderSession, TaskStoreError>> {
  try {
    // エスカレーション回数チェック
    if (session.escalationAttempts.user >= ESCALATION_LIMITS.user) {
      return createErr(
        ioError(`Escalation limit reached for user (${ESCALATION_LIMITS.user} times)`),
      );
    }

    // エスカレーション記録作成
    const escalationRecord: EscalationRecord = {
      id: randomUUID(),
      target: EscalationTarget.USER,
      reason,
      relatedTaskId: relatedTaskId ?? null,
      escalatedAt: new Date().toISOString(),
      resolved: false,
      resolvedAt: null,
      resolution: null,
    };

    // セッション更新
    const updatedSession: LeaderSession = {
      ...session,
      status: LeaderSessionStatus.ESCALATING,
      escalationRecords: [...session.escalationRecords, escalationRecord],
      escalationAttempts: {
        ...session.escalationAttempts,
        user: session.escalationAttempts.user + 1,
      },
      updatedAt: new Date().toISOString(),
    };

    // セッション保存
    const saveResult = await deps.sessionEffects.saveSession(updatedSession);
    if (isErr(saveResult)) {
      return saveResult;
    }

    return createOk(updatedSession);
  } catch (error) {
    return createErr(ioError(`Failed to escalate to user: ${String(error)}`));
  }
}

/**
 * Planner へエスカレーション（再計画要求）
 *
 * タスクの再分解を Planner に依頼する
 *
 * @param deps Leader 依存関係
 * @param session Leader セッション
 * @param reason エスカレーション理由
 * @param relatedTaskId 関連タスク ID
 * @returns 更新された Leader セッション
 */
export async function escalateToPlanner(
  deps: LeaderDeps,
  session: LeaderSession,
  reason: string,
  relatedTaskId?: TaskId,
): Promise<Result<LeaderSession, TaskStoreError>> {
  try {
    // エスカレーション回数チェック
    if (session.escalationAttempts.planner >= ESCALATION_LIMITS.planner) {
      return createErr(
        ioError(`Escalation limit reached for planner (${ESCALATION_LIMITS.planner} times)`),
      );
    }

    // エスカレーション記録作成
    const escalationRecord: EscalationRecord = {
      id: randomUUID(),
      target: EscalationTarget.PLANNER,
      reason,
      relatedTaskId: relatedTaskId ?? null,
      escalatedAt: new Date().toISOString(),
      resolved: false,
      resolvedAt: null,
      resolution: null,
    };

    // セッション更新
    const updatedSession: LeaderSession = {
      ...session,
      status: LeaderSessionStatus.ESCALATING,
      escalationRecords: [...session.escalationRecords, escalationRecord],
      escalationAttempts: {
        ...session.escalationAttempts,
        planner: session.escalationAttempts.planner + 1,
      },
      updatedAt: new Date().toISOString(),
    };

    // セッション保存
    const saveResult = await deps.sessionEffects.saveSession(updatedSession);
    if (isErr(saveResult)) {
      return saveResult;
    }

    return createOk(updatedSession);
  } catch (error) {
    return createErr(ioError(`Failed to escalate to planner: ${String(error)}`));
  }
}

/**
 * LogicValidator への相談
 *
 * 論理整合性のチェックを LogicValidator に依頼する
 *
 * @param deps Leader 依存関係
 * @param session Leader セッション
 * @param reason 相談理由
 * @returns 更新された Leader セッション
 */
export async function consultLogicValidator(
  deps: LeaderDeps,
  session: LeaderSession,
  reason: string,
): Promise<Result<LeaderSession, TaskStoreError>> {
  try {
    // エスカレーション回数チェック
    if (session.escalationAttempts.logicValidator >= ESCALATION_LIMITS.logicValidator) {
      return createErr(
        ioError(
          `Escalation limit reached for logic validator (${ESCALATION_LIMITS.logicValidator} times)`,
        ),
      );
    }

    // エスカレーション記録作成
    const escalationRecord: EscalationRecord = {
      id: randomUUID(),
      target: EscalationTarget.LOGIC_VALIDATOR,
      reason,
      relatedTaskId: null,
      escalatedAt: new Date().toISOString(),
      resolved: false,
      resolvedAt: null,
      resolution: null,
    };

    // セッション更新
    const updatedSession: LeaderSession = {
      ...session,
      status: LeaderSessionStatus.ESCALATING,
      escalationRecords: [...session.escalationRecords, escalationRecord],
      escalationAttempts: {
        ...session.escalationAttempts,
        logicValidator: session.escalationAttempts.logicValidator + 1,
      },
      updatedAt: new Date().toISOString(),
    };

    // セッション保存
    const saveResult = await deps.sessionEffects.saveSession(updatedSession);
    if (isErr(saveResult)) {
      return saveResult;
    }

    return createOk(updatedSession);
  } catch (error) {
    return createErr(ioError(`Failed to consult logic validator: ${String(error)}`));
  }
}

/**
 * 外部アドバイザーへの助言要求
 *
 * 技術的な助言を外部エージェント（Codex など）に求める
 *
 * @param deps Leader 依存関係
 * @param session Leader セッション
 * @param reason 助言要求理由
 * @param relatedTaskId 関連タスク ID
 * @returns 更新された Leader セッション
 */
export async function requestExternalAdvice(
  deps: LeaderDeps,
  session: LeaderSession,
  reason: string,
  relatedTaskId?: TaskId,
): Promise<Result<LeaderSession, TaskStoreError>> {
  try {
    // エスカレーション回数チェック
    if (session.escalationAttempts.externalAdvisor >= ESCALATION_LIMITS.externalAdvisor) {
      return createErr(
        ioError(
          `Escalation limit reached for external advisor (${ESCALATION_LIMITS.externalAdvisor} times)`,
        ),
      );
    }

    // エスカレーション記録作成
    const escalationRecord: EscalationRecord = {
      id: randomUUID(),
      target: EscalationTarget.EXTERNAL_ADVISOR,
      reason,
      relatedTaskId: relatedTaskId ?? null,
      escalatedAt: new Date().toISOString(),
      resolved: false,
      resolvedAt: null,
      resolution: null,
    };

    // セッション更新
    const updatedSession: LeaderSession = {
      ...session,
      status: LeaderSessionStatus.ESCALATING,
      escalationRecords: [...session.escalationRecords, escalationRecord],
      escalationAttempts: {
        ...session.escalationAttempts,
        externalAdvisor: session.escalationAttempts.externalAdvisor + 1,
      },
      updatedAt: new Date().toISOString(),
    };

    // セッション保存
    const saveResult = await deps.sessionEffects.saveSession(updatedSession);
    if (isErr(saveResult)) {
      return saveResult;
    }

    return createOk(updatedSession);
  } catch (error) {
    return createErr(ioError(`Failed to request external advice: ${String(error)}`));
  }
}

/**
 * メンバータスク履歴を追加
 *
 * @param deps Leader 依存関係
 * @param session Leader セッション
 * @param history 追加するタスク履歴
 * @returns 更新された Leader セッション
 */
export async function addMemberTaskHistory(
  deps: LeaderDeps,
  session: LeaderSession,
  history: MemberTaskHistory,
): Promise<Result<LeaderSession, TaskStoreError>> {
  try {
    const updatedSession: LeaderSession = {
      ...session,
      memberTaskHistory: [...session.memberTaskHistory, history],
      updatedAt: new Date().toISOString(),
    };

    // セッション保存
    const saveResult = await deps.sessionEffects.saveSession(updatedSession);
    if (isErr(saveResult)) {
      return saveResult;
    }

    return createOk(updatedSession);
  } catch (error) {
    return createErr(ioError(`Failed to add member task history: ${String(error)}`));
  }
}

/**
 * Leader セッション状態を更新
 *
 * @param deps Leader 依存関係
 * @param session Leader セッション
 * @param status 新しい状態
 * @returns 更新された Leader セッション
 */
export async function updateLeaderSessionStatus(
  deps: LeaderDeps,
  session: LeaderSession,
  status: LeaderSessionStatus,
): Promise<Result<LeaderSession, TaskStoreError>> {
  try {
    const updatedSession: LeaderSession = {
      ...session,
      status,
      updatedAt: new Date().toISOString(),
    };

    // セッション保存
    const saveResult = await deps.sessionEffects.saveSession(updatedSession);
    if (isErr(saveResult)) {
      return saveResult;
    }

    return createOk(updatedSession);
  } catch (error) {
    return createErr(ioError(`Failed to update leader session status: ${String(error)}`));
  }
}
