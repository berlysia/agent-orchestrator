import { z } from 'zod';
import { TaskBreakdownSchema } from './task-breakdown.ts';

/**
 * セッション状態
 *
 * - PLANNING: タスク分解中
 * - EXECUTING: タスク実行中
 * - INTEGRATING: ブランチ統合中
 * - COMPLETED: 完了
 * - FAILED: 失敗
 */
export const SessionStatus = {
  PLANNING: 'planning',
  EXECUTING: 'executing',
  INTEGRATING: 'integrating',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

/**
 * 会話メッセージ
 * LLMとの会話履歴を保持する単位
 */
export const ConversationMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  timestamp: z.string(),
});

export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

/**
 * プランナーセッション
 * タスク分解の会話履歴と生成されたタスクを保持
 */
export const PlannerSessionSchema = z.object({
  sessionId: z.string(),
  /**
   * 親セッションID（continue時）
   *
   * WHY: `agent continue` で追加タスクを生成した場合、元のセッションを参照可能にする
   */
  parentSessionId: z.string().nullable().optional(),
  /**
   * ルートセッションID（集計単位）
   *
   * WHY: 複数のcontinueを経ても、元のセッションチェーンを追跡可能にする
   * - 親がrootSessionIdを持っていればそれを継承
   * - 持っていなければ親のsessionIdを設定
   */
  rootSessionId: z.string().nullable().optional(),
  instruction: z.string(),
  conversationHistory: z.array(ConversationMessageSchema),
  /** Plannerが生成したタスク分解情報 */
  generatedTasks: z.array(TaskBreakdownSchema),
  /**
   * 実際に生成されたタスクID（TaskStore保存後）
   *
   * WHY: TaskBreakdown.id とは異なる一意なIDが生成されるため、
   *      生成後のタスクIDを保持して参照可能にする
   */
  generatedTaskIds: z.array(z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** プランナー実行ログのパス（絶対パス、オプショナル） */
  plannerLogPath: z.string().nullable().optional(),
  /** プランナー実行メタデータのパス（絶対パス、オプショナル） */
  plannerMetadataPath: z.string().nullable().optional(),
  /**
   * 最終完了判定の結果
   * WHY: オーケストレーション終了時に自動生成される判定情報を保存し、
   *      continue コマンドで未完了の判定から再実行できるようにする
   */
  finalJudgement: z
    .object({
      isComplete: z.boolean(),
      missingAspects: z.array(z.string()),
      additionalTaskSuggestions: z.array(z.string()),
      completionScore: z.number().min(0).max(100).optional(),
      evaluatedAt: z.string(),
    })
    .nullable()
    .optional(),
  /**
   * continue コマンドでの反復実行回数
   * WHY: 無限ループを防ぐため、反復回数を追跡する
   */
  continueIterationCount: z.number().int().min(0).default(0),
  /**
   * セッション状態
   *
   * WHY: セッションの現在状態を明示的に管理し、CLIでのステータス表示を改善
   *      status未定義時は finalJudgement から推論
   */
  status: z
    .enum([
      SessionStatus.PLANNING,
      SessionStatus.EXECUTING,
      SessionStatus.INTEGRATING,
      SessionStatus.COMPLETED,
      SessionStatus.FAILED,
    ])
    .optional(),
  /**
   * Refinement履歴
   *
   * WHY: プラン生成時のrefinementループの履歴を保存し、
   *      品質改善プロセスの透明性と追跡可能性を提供する
   */
  refinementHistory: z
    .array(
      z.object({
        decision: z.enum(['accept', 'replan', 'reject']),
        reason: z.string(),
        feedback: z
          .object({
            issues: z.array(z.string()),
            suggestions: z.array(z.string()),
          })
          .optional(),
        previousScore: z.number().optional(),
        currentScore: z.number().optional(),
        attemptCount: z.number().int(),
        suggestionReplanCount: z.number().int(),
      }),
    )
    .optional(),
});

export type PlannerSession = z.infer<typeof PlannerSessionSchema>;

/**
 * Refinement configuration
 * Configuration for the plan refinement process
 */
export type RefinementConfig = {
  maxRefinementAttempts: number; // default 2
  refineSuggestionsOnSuccess: boolean; // default false
  maxSuggestionReplans: number; // default 1
  enableIndividualFallback: boolean; // default true
  deltaThreshold: number; // default 5
  deltaThresholdPercent: number; // default 5
  taskCountChangeThreshold: number; // default 0.3
  taskCountChangeMinAbsolute: number; // default 2
};

/**
 * Refinement decision type
 * Represents the decision made during plan refinement
 */
export type RefinementDecision = 'accept' | 'replan' | 'reject';

/**
 * Feedback type
 * Contains issues and suggestions for plan refinement
 */
export type Feedback = {
  issues: string[];
  suggestions: string[];
};

/**
 * Refinement result
 * Contains the result of a single refinement attempt
 */
export type RefinementResult = {
  decision: RefinementDecision;
  reason: string;
  feedback?: Feedback;
  previousScore?: number;
  currentScore?: number;
  attemptCount: number;
  suggestionReplanCount: number;
};

/**
 * Structure validation result
 * Contains validation metrics for plan structure
 */
export type StructureValidation = {
  isValid: boolean;
  taskCountChange: number;
  absoluteTaskCountDiff: number;
  hasDependencyIssues: boolean;
  hasCyclicDependency: boolean;
  details?: string;
};

/**
 * Refinement error
 * Error type for Result<T, E> pattern in refinement operations
 */
export type RefinementError = {
  reason: string;
  refinementHistory: RefinementResult[];
};

/**
 * 新しいセッションを作成するためのヘルパー関数
 */
export const createPlannerSession = (sessionId: string, instruction: string): PlannerSession => {
  const now = new Date().toISOString();
  return {
    sessionId,
    instruction,
    conversationHistory: [],
    generatedTasks: [],
    createdAt: now,
    updatedAt: now,
    finalJudgement: null,
    continueIterationCount: 0,
    status: SessionStatus.PLANNING,
  };
};

/**
 * セッション状態を取得（status 未定義時は finalJudgement から推論）
 *
 * WHY: 既存データとの互換性のため、status が未定義でも状態を取得可能にする
 *
 * @param session プランナーセッション
 * @returns セッション状態
 */
export const getSessionStatus = (session: PlannerSession): SessionStatus => {
  // status が明示的に設定されている場合はそれを使用
  if (session.status) {
    return session.status;
  }

  // finalJudgement から推論
  if (session.finalJudgement) {
    if (session.finalJudgement.isComplete) {
      return SessionStatus.COMPLETED;
    }
    // isComplete === false の場合は実行中
    return SessionStatus.EXECUTING;
  }

  // finalJudgement がない場合
  if (session.generatedTasks.length === 0) {
    return SessionStatus.PLANNING;
  }

  // タスクが生成されているが判定がない場合は実行中
  return SessionStatus.EXECUTING;
};
