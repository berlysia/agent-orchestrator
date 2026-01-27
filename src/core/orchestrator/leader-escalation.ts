import type { Result } from 'option-t/plain_result';
import { createOk, createErr, isErr } from 'option-t/plain_result';
import type { TaskStoreError } from '../../types/errors.ts';
import { ioError } from '../../types/errors.ts';
import type {
  LeaderSession,
  EscalationRecord,
} from '../../types/leader-session.ts';
import {
  LeaderSessionStatus,
  ESCALATION_LIMITS,
  EscalationTarget,
} from '../../types/leader-session.ts';
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
 * LogicValidator プロンプト生成
 *
 * WHY: Phase 3 - 技術的困難に対する論理的分析と助言を生成
 */
function buildLogicValidatorPrompt(
  reason: string,
  taskContext?: string,
): string {
  return `You are a Logic Validator assistant helping to analyze technical difficulties in a software development task.

## Technical Difficulty
${reason}

${taskContext ? `## Task Context\n${taskContext}` : ''}

## Your Role
Analyze the technical difficulty and provide:
1. Root cause analysis - What is the fundamental issue?
2. Recommended approach - How should this be addressed?
3. Confidence level - How confident are you in this advice? (high/medium/low)

## Response Format
Respond in JSON format:
{
  "rootCause": "description of the root cause",
  "recommendation": "specific actionable recommendation",
  "confidence": "high" | "medium" | "low",
  "requiresUserDecision": true | false,
  "reasoning": "explanation of your analysis"
}

If the issue requires human judgment (e.g., business decisions, unclear requirements), set requiresUserDecision to true.`;
}

/**
 * LogicValidator レスポンス型
 */
interface LogicValidatorResponse {
  rootCause: string;
  recommendation: string;
  confidence: 'high' | 'medium' | 'low';
  requiresUserDecision: boolean;
  reasoning: string;
}

/**
 * LogicValidator エスカレーション処理
 *
 * WHY: Phase 3 - LLM を使用した技術的困難の分析と助言
 *
 * @param deps Leader 依存関係
 * @param session Leader セッション
 * @param reason エスカレーション理由
 * @param relatedTaskId 関連タスク ID
 * @returns 更新された Leader セッション と LogicValidator の助言
 */
export async function handleLogicValidatorEscalation(
  deps: LeaderDeps,
  session: LeaderSession,
  reason: string,
  relatedTaskId?: TaskId,
): Promise<
  Result<
    { session: LeaderSession; advice: LogicValidatorResponse | null },
    TaskStoreError
  >
> {
  try {
    console.log(`\n🧠 Escalating to LogicValidator`);
    console.log(`   Reason: ${reason}`);

    // エスカレーション回数チェック
    if (session.escalationAttempts.logicValidator >= ESCALATION_LIMITS.logicValidator) {
      console.log(`   ⚠️  LogicValidator escalation limit reached`);
      console.log(`   ↪️  Falling back to User escalation`);
      const userResult = await handleUserEscalation(
        deps,
        session,
        `[LogicValidator limit reached] ${reason}`,
        relatedTaskId,
      );
      if (isErr(userResult)) {
        return userResult;
      }
      return createOk({ session: userResult.val, advice: null });
    }

    // タスクコンテキストを取得
    let taskContext: string | undefined;
    if (relatedTaskId) {
      const taskResult = await deps.taskStore.readTask(relatedTaskId);
      if (!isErr(taskResult)) {
        const task = taskResult.val;
        taskContext = `Task: ${task.id}\nAcceptance: ${task.acceptance}\nContext: ${task.context ?? 'N/A'}`;
      }
    }

    // LLM 呼び出し
    const prompt = buildLogicValidatorPrompt(reason, taskContext);
    console.log(`   🤖 Running LogicValidator analysis...`);

    const llmResult = await deps.runnerEffects.runClaudeAgent(
      prompt,
      deps.coordRepoPath,
      deps.model,
    );

    if (isErr(llmResult)) {
      console.log(`   ❌ LogicValidator failed: ${llmResult.err.message}`);
      console.log(`   ↪️  Falling back to User escalation`);
      const userResult = await handleUserEscalation(
        deps,
        session,
        `[LogicValidator failed] ${reason}`,
        relatedTaskId,
      );
      if (isErr(userResult)) {
        return userResult;
      }
      return createOk({ session: userResult.val, advice: null });
    }

    // レスポンスをパース
    let advice: LogicValidatorResponse;
    try {
      const responseText = llmResult.val.finalResponse;
      if (!responseText) {
        throw new Error('Empty response from LLM');
      }
      // JSON部分を抽出
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }
      advice = JSON.parse(jsonMatch[0]) as LogicValidatorResponse;
    } catch (parseError) {
      console.log(`   ⚠️  Failed to parse LogicValidator response`);
      console.log(`   ↪️  Falling back to User escalation`);
      const userResult = await handleUserEscalation(
        deps,
        session,
        `[LogicValidator parse failed] ${reason}`,
        relatedTaskId,
      );
      if (isErr(userResult)) {
        return userResult;
      }
      return createOk({ session: userResult.val, advice: null });
    }

    console.log(`   ✅ LogicValidator analysis complete`);
    console.log(`   Root Cause: ${advice.rootCause}`);
    console.log(`   Recommendation: ${advice.recommendation}`);
    console.log(`   Confidence: ${advice.confidence}`);
    console.log(`   Requires User Decision: ${advice.requiresUserDecision}`);

    // エスカレーション記録を作成
    const escalationRecord = createEscalationRecord(
      EscalationTarget.LOGIC_VALIDATOR,
      reason,
      relatedTaskId,
    );
    escalationRecord.resolved = true;
    escalationRecord.resolvedAt = new Date().toISOString();
    escalationRecord.resolution = `LogicValidator advice: ${advice.recommendation}`;

    const now = new Date().toISOString();
    let updatedSession: LeaderSession = {
      ...session,
      escalationRecords: [...session.escalationRecords, escalationRecord],
      escalationAttempts: {
        ...session.escalationAttempts,
        logicValidator: session.escalationAttempts.logicValidator + 1,
      },
      updatedAt: now,
    };

    // ユーザー判断が必要な場合は User エスカレーション
    if (advice.requiresUserDecision || advice.confidence === 'low') {
      console.log(`   ↪️  User decision required, escalating to User`);
      const userReason = `[LogicValidator recommends user decision]\n\nAnalysis: ${advice.reasoning}\n\nRecommendation: ${advice.recommendation}`;
      const userResult = await handleUserEscalation(
        deps,
        updatedSession,
        userReason,
        relatedTaskId,
      );
      if (isErr(userResult)) {
        return userResult;
      }
      return createOk({ session: userResult.val, advice });
    }

    // セッション保存
    const saveResult = await deps.sessionEffects.saveSession(updatedSession);
    if (isErr(saveResult)) {
      return saveResult;
    }

    return createOk({ session: updatedSession, advice });
  } catch (error) {
    return createErr(
      ioError(`Failed to handle logic validator escalation: ${String(error)}`),
    );
  }
}

/**
 * ExternalAdvisor エスカレーション処理
 *
 * WHY: Phase 3 - 外部アドバイザー（Codex MCP など）への統合
 *
 * 現時点では User へフォールバック。将来の拡張で Codex MCP などを統合予定。
 *
 * @param deps Leader 依存関係
 * @param session Leader セッション
 * @param reason エスカレーション理由
 * @param relatedTaskId 関連タスク ID
 * @returns 更新された Leader セッション
 */
export async function handleExternalAdvisorEscalation(
  deps: LeaderDeps,
  session: LeaderSession,
  reason: string,
  relatedTaskId?: TaskId,
): Promise<Result<LeaderSession, TaskStoreError>> {
  try {
    console.log(`\n🔗 Escalating to ExternalAdvisor`);
    console.log(`   Reason: ${reason}`);

    // エスカレーション回数チェック
    if (session.escalationAttempts.externalAdvisor >= ESCALATION_LIMITS.externalAdvisor) {
      console.log(`   ⚠️  ExternalAdvisor escalation limit reached`);
      console.log(`   ↪️  Falling back to User escalation`);
      return await handleUserEscalation(
        deps,
        session,
        `[ExternalAdvisor limit reached] ${reason}`,
        relatedTaskId,
      );
    }

    // TODO: 将来の拡張で Codex MCP などの外部アドバイザーを統合
    // 現時点では User へフォールバック
    console.log(`   ⚠️  ExternalAdvisor integration not yet implemented`);
    console.log(`   ↪️  Falling back to User escalation`);

    // エスカレーション記録を作成
    const escalationRecord = createEscalationRecord(
      EscalationTarget.EXTERNAL_ADVISOR,
      reason,
      relatedTaskId,
    );

    const now = new Date().toISOString();
    const updatedSession: LeaderSession = {
      ...session,
      escalationRecords: [...session.escalationRecords, escalationRecord],
      escalationAttempts: {
        ...session.escalationAttempts,
        externalAdvisor: session.escalationAttempts.externalAdvisor + 1,
      },
      updatedAt: now,
    };

    // User エスカレーションへフォールバック
    const fallbackReason = `[ExternalAdvisor not available] ${reason}\n\nNote: ExternalAdvisor integration (Codex MCP) will be available in a future update.`;
    return await handleUserEscalation(deps, updatedSession, fallbackReason, relatedTaskId);
  } catch (error) {
    return createErr(
      ioError(`Failed to handle external advisor escalation: ${String(error)}`),
    );
  }
}

/**
 * 技術的困難エスカレーション処理
 *
 * WHY: Phase 3 - LogicValidator を使用した技術的困難の分析
 *
 * フロー:
 * 1. LogicValidator で分析
 * 2. 高信頼度の助言 → 実行継続
 * 3. ユーザー判断が必要 or 低信頼度 → User エスカレーション
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

    // LogicValidator で分析
    const validatorResult = await handleLogicValidatorEscalation(
      deps,
      session,
      reason,
      relatedTaskId,
    );

    if (isErr(validatorResult)) {
      return validatorResult;
    }

    return createOk(validatorResult.val.session);
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

/**
 * エスカレーションを解決
 *
 * WHY: Phase 3 - ユーザー判断の適用
 *
 * @param deps Leader 依存関係
 * @param session Leader セッション
 * @param escalationId 解決するエスカレーション ID
 * @param resolution 解決内容
 * @returns 更新された Leader セッション
 */
export async function resolveEscalation(
  deps: LeaderDeps,
  session: LeaderSession,
  escalationId: string,
  resolution: string,
): Promise<Result<LeaderSession, TaskStoreError>> {
  try {
    // エスカレーション記録を検索
    const escalation = session.escalationRecords.find((e) => e.id === escalationId);
    if (!escalation) {
      return createErr(ioError(`Escalation ${escalationId} not found`));
    }

    if (escalation.resolved) {
      return createErr(ioError(`Escalation ${escalationId} is already resolved`));
    }

    // エスカレーション記録を更新
    const now = new Date().toISOString();
    const updatedEscalations = session.escalationRecords.map((e) =>
      e.id === escalationId
        ? {
            ...e,
            resolved: true,
            resolvedAt: now,
            resolution,
          }
        : e,
    );

    // 未解決エスカレーションがなくなった場合、状態を REVIEWING に変更
    const remainingPending = updatedEscalations.filter((e) => !e.resolved);
    const newStatus =
      remainingPending.length === 0 && session.status === LeaderSessionStatus.ESCALATING
        ? LeaderSessionStatus.REVIEWING
        : session.status;

    const updatedSession: LeaderSession = {
      ...session,
      escalationRecords: updatedEscalations,
      status: newStatus,
      updatedAt: now,
    };

    // セッションを保存
    const saveResult = await deps.sessionEffects.saveSession(updatedSession);
    if (isErr(saveResult)) {
      return saveResult;
    }

    console.log(`✅ Escalation ${escalationId} resolved`);
    console.log(`   Resolution: ${resolution}`);
    if (remainingPending.length === 0) {
      console.log(`   All escalations resolved. Session status: ${newStatus}`);
    } else {
      console.log(`   ${remainingPending.length} escalation(s) still pending`);
    }

    return createOk(updatedSession);
  } catch (error) {
    return createErr(ioError(`Failed to resolve escalation: ${String(error)}`));
  }
}

/**
 * エスカレーション解決後にセッションを再開
 *
 * WHY: Phase 3 - エスカレーション解決後の再開
 *
 * 前提条件:
 * - すべてのエスカレーションが解決済み
 * - セッション状態が ESCALATING または REVIEWING
 *
 * @param deps Leader 依存関係
 * @param session Leader セッション
 * @returns 更新された Leader セッション
 */
export async function resumeFromEscalation(
  deps: LeaderDeps,
  session: LeaderSession,
): Promise<Result<LeaderSession, TaskStoreError>> {
  try {
    // 未解決エスカレーションがある場合はエラー
    const pendingEscalations = getPendingEscalations(session);
    if (pendingEscalations.length > 0) {
      return createErr(
        ioError(
          `Cannot resume: ${pendingEscalations.length} escalation(s) still pending`,
        ),
      );
    }

    // セッション状態をチェック
    if (session.status === LeaderSessionStatus.COMPLETED) {
      return createErr(ioError('Session is already completed'));
    }

    if (session.status === LeaderSessionStatus.FAILED) {
      return createErr(ioError('Session has failed, cannot resume'));
    }

    if (session.status === LeaderSessionStatus.EXECUTING) {
      console.log('⚙️  Session is already executing');
      return createOk(session);
    }

    // セッション状態を EXECUTING に更新
    const now = new Date().toISOString();
    const updatedSession: LeaderSession = {
      ...session,
      status: LeaderSessionStatus.EXECUTING,
      updatedAt: now,
    };

    // セッションを保存
    const saveResult = await deps.sessionEffects.saveSession(updatedSession);
    if (isErr(saveResult)) {
      return saveResult;
    }

    console.log(`▶️  Session ${session.sessionId} resumed`);
    console.log(`   Status: EXECUTING`);
    console.log(`   Progress: ${session.completedTaskCount}/${session.totalTaskCount} tasks`);

    return createOk(updatedSession);
  } catch (error) {
    return createErr(ioError(`Failed to resume from escalation: ${String(error)}`));
  }
}
