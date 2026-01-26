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
import type { GitEffects } from '../../adapters/vcs/git-effects.ts';
import type { Config } from '../../types/config.ts';
import { createWorkerOperations } from './worker-operations.ts';
import { createJudgeOperations } from './judge-operations.ts';
import { createBaseBranchResolver } from './base-branch-resolver.ts';

/**
 * Leader 依存関係
 *
 * WHY: Phase 2 Task 2 - Worker/Judge/BaseBranchResolver を追加して実際の実行を可能にする
 */
export interface LeaderDeps {
  readonly taskStore: TaskStore;
  readonly runnerEffects: RunnerEffects;
  readonly sessionEffects: LeaderSessionEffects;
  readonly coordRepoPath: string;
  readonly agentType: 'claude' | 'codex';
  readonly model: string;
  readonly gitEffects: GitEffects;
  readonly config: Config;
  readonly workerOps: ReturnType<typeof createWorkerOperations>;
  readonly judgeOps: ReturnType<typeof createJudgeOperations>;
  readonly baseBranchResolver: ReturnType<typeof createBaseBranchResolver>;
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
 * Worker へのタスク割り当て結果
 *
 * WHY: Phase 2 Task 2 - Worker 実行結果と Judge 判定結果を返す
 */
export interface AssignTaskResult {
  /** Worker 実行結果 */
  readonly workerResult: {
    readonly runId: string;
    readonly checkFixRunIds?: readonly string[];
    readonly success: boolean;
    readonly error?: string;
  };
  /** Judge 判定結果 */
  readonly judgementResult: {
    readonly taskId: TaskId;
    readonly success: boolean;
    readonly shouldContinue: boolean;
    readonly shouldReplan: boolean;
    readonly alreadySatisfied: boolean;
    readonly reason: string;
    readonly missingRequirements?: string[];
  };
}

/**
 * Worker へのタスク割り当て
 *
 * Phase 2 Task 2: 実際に Worker を実行し、Judge 判定を行う
 *
 * @param deps Leader 依存関係
 * @param session Leader セッション
 * @param task 実行するタスク
 * @returns Worker 実行結果と Judge 判定結果
 */
export async function assignTaskToMember(
  deps: LeaderDeps,
  session: LeaderSession,
  task: Task,
): Promise<Result<AssignTaskResult, TaskStoreError>> {
  try {
    console.log(`  👤 Leader: Assigning task ${task.id} to member`);

    // 1. 依存関係を解決
    const resolutionResult = await deps.baseBranchResolver.resolveBaseBranch(task);
    if (isErr(resolutionResult)) {
      return createErr(
        ioError(`Failed to resolve base branch: ${resolutionResult.err.message}`),
      );
    }

    const resolution = resolutionResult.val;
    console.log(`  📋 Dependency resolution: ${resolution.type}`);

    // 2. Worker を実行
    console.log(`  🔨 Executing task with Worker...`);
    const workerResult = await deps.workerOps.executeTaskWithWorktree(task, resolution);
    if (isErr(workerResult)) {
      return createErr(ioError(`Worker execution failed: ${workerResult.err.message}`));
    }

    const worker = workerResult.val;
    console.log(`  ${worker.success ? '✅' : '❌'} Worker execution: ${worker.success ? 'success' : 'failed'}`);

    // 3. Judge 判定
    console.log(`  ⚖️  Evaluating task with Judge...`);
    const judgementResult = await deps.judgeOps.judgeTask(task.id, worker.runId);
    if (isErr(judgementResult)) {
      return createErr(ioError(`Judge evaluation failed: ${judgementResult.err.message}`));
    }

    const judgement = judgementResult.val;
    console.log(`  ${judgement.success ? '✅' : '⚠️'} Judge evaluation: ${judgement.success ? 'success' : 'needs work'}`);
    console.log(`     Reason: ${judgement.reason}`);

    // 4. MemberTaskHistory に記録
    const history: MemberTaskHistory = {
      taskId: task.id,
      assignedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      workerResult: {
        runId: worker.runId,
        checkFixRunIds: worker.checkFixRunIds ? [...worker.checkFixRunIds] : undefined,
        success: worker.success,
        error: worker.error,
      },
      judgementResult: {
        taskId: judgement.taskId,
        success: judgement.success,
        shouldContinue: judgement.shouldContinue,
        shouldReplan: judgement.shouldReplan,
        alreadySatisfied: judgement.alreadySatisfied,
        reason: judgement.reason,
        missingRequirements: judgement.missingRequirements ?? [],
      },
      workerFeedback: null, // Phase 2 では null（Phase 3 で実装）
    };

    const addHistoryResult = await addMemberTaskHistory(deps, session, history);
    if (isErr(addHistoryResult)) {
      return addHistoryResult;
    }

    return createOk({
      workerResult: {
        runId: worker.runId,
        checkFixRunIds: worker.checkFixRunIds,
        success: worker.success,
        error: worker.error,
      },
      judgementResult: {
        taskId: judgement.taskId,
        success: judgement.success,
        shouldContinue: judgement.shouldContinue,
        shouldReplan: judgement.shouldReplan,
        alreadySatisfied: judgement.alreadySatisfied,
        reason: judgement.reason,
        missingRequirements: judgement.missingRequirements,
      },
    });
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
