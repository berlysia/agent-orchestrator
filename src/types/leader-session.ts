import { z } from 'zod';
import { taskId } from './branded.ts';
import { ConversationMessageSchema } from './planner-session.ts';

/**
 * Leader Session Status
 *
 * - PLANNING: 計画読み込み・初期化中
 * - EXECUTING: メンバータスク実行中
 * - REVIEWING: 完了判定レビュー中
 * - ESCALATING: エスカレーション処理中
 * - COMPLETED: 完了
 * - FAILED: 失敗
 */
export const LeaderSessionStatus = {
  PLANNING: 'planning',
  EXECUTING: 'executing',
  REVIEWING: 'reviewing',
  ESCALATING: 'escalating',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type LeaderSessionStatus =
  (typeof LeaderSessionStatus)[keyof typeof LeaderSessionStatus];

/**
 * Escalation Target
 *
 * エスカレーション先の種別
 */
export const EscalationTarget = {
  USER: 'user',
  PLANNER: 'planner',
  LOGIC_VALIDATOR: 'logic_validator',
  EXTERNAL_ADVISOR: 'external_advisor',
} as const;

export type EscalationTarget =
  (typeof EscalationTarget)[keyof typeof EscalationTarget];

/**
 * Escalation Record Schema
 *
 * エスカレーション履歴の記録
 */
export const EscalationRecordSchema = z.object({
  /** エスカレーション ID */
  id: z.string(),
  /** エスカレーション先 */
  target: z.enum([
    EscalationTarget.USER,
    EscalationTarget.PLANNER,
    EscalationTarget.LOGIC_VALIDATOR,
    EscalationTarget.EXTERNAL_ADVISOR,
  ]),
  /** エスカレーション理由 */
  reason: z.string(),
  /** 関連タスク ID */
  relatedTaskId: z.string().transform(taskId).nullable().optional(),
  /** エスカレーション時刻 */
  escalatedAt: z.string().datetime(),
  /** 解決状態 */
  resolved: z.boolean().default(false),
  /** 解決時刻 */
  resolvedAt: z.string().datetime().nullable().optional(),
  /** 解決結果（ユーザー判断、再計画指示など） */
  resolution: z.string().nullable().optional(),
});

export type EscalationRecord = z.infer<typeof EscalationRecordSchema>;

/**
 * Task Candidate Source
 *
 * タスク候補の生成元
 */
export const TaskCandidateSource = {
  WORKER_RECOMMENDATION: 'worker-recommendation',
  PATTERN_DISCOVERY: 'pattern-discovery',
  EXPLORATION_FINDING: 'exploration-finding',
} as const;

export type TaskCandidateSource =
  (typeof TaskCandidateSource)[keyof typeof TaskCandidateSource];

/**
 * Task Candidate Category
 *
 * タスク候補のカテゴリ
 */
export const TaskCandidateCategory = {
  CODE_QUALITY: 'code-quality',
  SECURITY: 'security',
  PERFORMANCE: 'performance',
  MAINTAINABILITY: 'maintainability',
  ARCHITECTURE: 'architecture',
  REFACTORING: 'refactoring',
  DOCUMENTATION: 'documentation',
} as const;

export type TaskCandidateCategory =
  (typeof TaskCandidateCategory)[keyof typeof TaskCandidateCategory];

/**
 * Task Candidate Status
 *
 * タスク候補のステータス
 */
export const TaskCandidateStatus = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXECUTED: 'executed',
} as const;

export type TaskCandidateStatus =
  (typeof TaskCandidateStatus)[keyof typeof TaskCandidateStatus];

/**
 * Task Candidate Schema
 *
 * Worker のフィードバックから生成された潜在的なタスク
 *
 * WHY: Worker が発見したパターンや推奨アクションを
 *      Leader が動的にタスク化できるようにする（ADR-024）
 */
export const TaskCandidateSchema = z.object({
  /** 候補 ID */
  id: z.string(),
  /** 生成元 */
  source: z.enum([
    TaskCandidateSource.WORKER_RECOMMENDATION,
    TaskCandidateSource.PATTERN_DISCOVERY,
    TaskCandidateSource.EXPLORATION_FINDING,
  ]),
  /** 関連タスク ID */
  relatedTaskId: z.string().transform(taskId),
  /** 候補の説明 */
  description: z.string(),
  /** 優先度 */
  priority: z.enum(['low', 'medium', 'high']),
  /** 自動実行可能か（ユーザー承認不要） */
  autoExecutable: z.boolean(),
  /** カテゴリ */
  category: z.enum([
    TaskCandidateCategory.CODE_QUALITY,
    TaskCandidateCategory.SECURITY,
    TaskCandidateCategory.PERFORMANCE,
    TaskCandidateCategory.MAINTAINABILITY,
    TaskCandidateCategory.ARCHITECTURE,
    TaskCandidateCategory.REFACTORING,
    TaskCandidateCategory.DOCUMENTATION,
  ]),
  /** 生成日時 */
  createdAt: z.string().datetime(),
  /** ステータス */
  status: z.enum([
    TaskCandidateStatus.PENDING,
    TaskCandidateStatus.APPROVED,
    TaskCandidateStatus.REJECTED,
    TaskCandidateStatus.EXECUTED,
  ]),
});

export type TaskCandidate = z.infer<typeof TaskCandidateSchema>;

/**
 * Member Task History Schema
 *
 * メンバータスク実行履歴
 *
 * WHY: Phase 2 Task 2 - Worker 実行結果と Judge 判定結果を完全に記録
 */
export const MemberTaskHistorySchema = z.object({
  /** タスク ID */
  taskId: z.string().transform(taskId),
  /** タスク割り当て時刻 */
  assignedAt: z.string().datetime(),
  /** タスク完了時刻 */
  completedAt: z.string().datetime().nullable().optional(),
  /** Worker 実行結果（Phase 2 Task 2+） */
  workerResult: z
    .object({
      runId: z.string(),
      checkFixRunIds: z.array(z.string()).optional(),
      success: z.boolean(),
      error: z.string().optional(),
    })
    .nullable()
    .optional(),
  /** Worker フィードバック（Phase 3 で実装） */
  workerFeedback: z.any().nullable().optional(),
  /** Judge 判定結果（Phase 2 Task 2 - 完全な JudgementResult 構造） */
  judgementResult: z
    .object({
      taskId: z.string().transform(taskId),
      success: z.boolean(),
      shouldContinue: z.boolean(),
      shouldReplan: z.boolean(),
      alreadySatisfied: z.boolean(),
      reason: z.string(),
      missingRequirements: z.array(z.string()),
    })
    .nullable()
    .optional(),
  /** Leader の判断（継続、再計画、エスカレーションなど） */
  leaderDecision: z
    .object({
      decision: z.enum(['continue', 'replan', 'escalate', 'accept', 'skip']),
      reason: z.string(),
      nextAction: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

export type MemberTaskHistory = z.infer<typeof MemberTaskHistorySchema>;

/**
 * Leader Session Schema
 *
 * リーダーセッションの状態管理
 */
export const LeaderSessionSchema = z.object({
  /** セッション ID */
  sessionId: z.string(),
  /** 計画文書ファイルパス（絶対パス） */
  planFilePath: z.string(),
  /**
   * 関連する PlannerSession ID（オプショナル）
   *
   * WHY: PlanningSession (ADR-021) から移行した場合、元のセッションを参照可能にする
   */
  plannerSessionId: z.string().nullable().optional(),
  /** 現在の状態 */
  status: z.enum([
    LeaderSessionStatus.PLANNING,
    LeaderSessionStatus.EXECUTING,
    LeaderSessionStatus.REVIEWING,
    LeaderSessionStatus.ESCALATING,
    LeaderSessionStatus.COMPLETED,
    LeaderSessionStatus.FAILED,
  ]),
  /** メンバータスク履歴 */
  memberTaskHistory: z.array(MemberTaskHistorySchema).default([]),
  /** エスカレーション記録 */
  escalationRecords: z.array(EscalationRecordSchema).default([]),
  /** Leader の会話履歴（LLM とのやり取り） */
  conversationHistory: z.array(ConversationMessageSchema).default([]),
  /**
   * 現在実行中のタスク ID リスト
   *
   * WHY: 並列実行時に複数タスクを追跡
   */
  activeTaskIds: z.array(z.string().transform(taskId)).default([]),
  /**
   * 完了済みタスク数
   *
   * WHY: 進捗表示用
   */
  completedTaskCount: z.number().int().min(0).default(0),
  /**
   * 総タスク数
   *
   * WHY: 進捗表示用
   */
  totalTaskCount: z.number().int().min(0).default(0),
  /**
   * エスカレーション試行回数（種別ごと）
   *
   * WHY: 無限ループ防止のため、各エスカレーション先への試行回数を制限
   */
  escalationAttempts: z
    .object({
      user: z.number().int().min(0).default(0),
      planner: z.number().int().min(0).default(0),
      logicValidator: z.number().int().min(0).default(0),
      externalAdvisor: z.number().int().min(0).default(0),
    })
    .default({
      user: 0,
      planner: 0,
      logicValidator: 0,
      externalAdvisor: 0,
    }),
  /** FAILED 状態時のエラーメッセージ */
  errorMessage: z.string().nullable().optional(),
  /**
   * タスク候補リスト（ADR-024）
   *
   * WHY: Worker フィードバックから生成された動的タスク候補を管理
   */
  taskCandidates: z.array(TaskCandidateSchema).default([]),
  /** 作成日時 */
  createdAt: z.string().datetime(),
  /** 更新日時 */
  updatedAt: z.string().datetime(),
  /** Leader 実行ログのパス（絶対パス、オプショナル） */
  leaderLogPath: z.string().nullable().optional(),
});

export type LeaderSession = z.infer<typeof LeaderSessionSchema>;

/**
 * 新しい Leader Session を作成するヘルパー関数
 */
export const createLeaderSession = (
  sessionId: string,
  planFilePath: string,
  plannerSessionId?: string | null,
): LeaderSession => {
  const now = new Date().toISOString();
  return {
    sessionId,
    planFilePath,
    plannerSessionId: plannerSessionId ?? null,
    status: LeaderSessionStatus.PLANNING,
    memberTaskHistory: [],
    escalationRecords: [],
    conversationHistory: [],
    activeTaskIds: [],
    completedTaskCount: 0,
    totalTaskCount: 0,
    escalationAttempts: {
      user: 0,
      planner: 0,
      logicValidator: 0,
      externalAdvisor: 0,
    },
    errorMessage: null,
    taskCandidates: [],
    createdAt: now,
    updatedAt: now,
    leaderLogPath: null,
  };
};

/**
 * エスカレーション制限値（デフォルト）
 *
 * WHY: 無限ループ防止のため、各エスカレーション先への最大試行回数を定義
 */
export const ESCALATION_LIMITS = {
  user: 10, // ユーザーへのエスカレーションは比較的多く許可
  planner: 3, // 再計画は計算コストが高いため制限
  logicValidator: 5, // 論理検証は中程度
  externalAdvisor: 5, // 外部助言も中程度
} as const;
