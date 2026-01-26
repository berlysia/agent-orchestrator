import { z } from 'zod';
import { ConversationMessageSchema } from './planner-session.ts';

/**
 * Planning Session Status
 *
 * - DISCOVERY: 要件明確化フェーズ（質問収集）
 * - DESIGN: 設計決定フェーズ（選択肢提示・決定記録）
 * - REVIEW: レビューフェーズ（承認待ち）
 * - APPROVED: 承認済み（PlannerSession作成完了）
 * - CANCELLED: キャンセル済み（3回拒否）
 * - FAILED: 失敗（LLM呼び出しエラー等）
 */
export const PlanningSessionStatus = {
  DISCOVERY: 'discovery',
  DESIGN: 'design',
  REVIEW: 'review',
  APPROVED: 'approved',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
} as const;

export type PlanningSessionStatus =
  (typeof PlanningSessionStatus)[keyof typeof PlanningSessionStatus];

/**
 * Question Type
 *
 * 質問の種類を分類し、PlannerSessionへの連携時に優先度を判定する
 */
export const QuestionType = {
  CLARIFICATION: 'clarification', // 要件の明確化
  SCOPE: 'scope', // スコープの確認
  TECHNICAL: 'technical', // 技術的詳細
  PRIORITY: 'priority', // 優先順位
  CONSTRAINT: 'constraint', // 制約条件
} as const;

export type QuestionType = (typeof QuestionType)[keyof typeof QuestionType];

/**
 * Question Schema
 *
 * Discovery Phaseで収集される質問とその回答
 */
export const QuestionSchema = z.object({
  id: z.string(),
  type: z.enum([
    QuestionType.CLARIFICATION,
    QuestionType.SCOPE,
    QuestionType.TECHNICAL,
    QuestionType.PRIORITY,
    QuestionType.CONSTRAINT,
  ]),
  question: z.string(),
  /** 選択肢（オプショナル、自由入力の場合はnull） */
  options: z.array(z.string()).nullable().optional(),
  /** ユーザーの回答（未回答時はnull） */
  answer: z.string().nullable().optional(),
  timestamp: z.string(),
});

export type Question = z.infer<typeof QuestionSchema>;

/**
 * Decision Point Schema
 *
 * Design Phaseで収集される設計決定と選択肢
 */
export const DecisionPointSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  options: z.array(
    z.object({
      label: z.string(),
      pros: z.array(z.string()),
      cons: z.array(z.string()),
    }),
  ),
  /** ユーザーの選択（未選択時はnull） */
  selectedOption: z.string().nullable().optional(),
  /** 選択理由（オプショナル） */
  rationale: z.string().nullable().optional(),
  timestamp: z.string(),
});

export type DecisionPoint = z.infer<typeof DecisionPointSchema>;

/**
 * Planning Session Schema
 *
 * 対話的プランニングセッションの状態管理
 */
export const PlanningSessionSchema = z.object({
  sessionId: z.string(),
  /** ユーザーからの元の指示 */
  instruction: z.string(),
  /** 現在の状態 */
  status: z.enum([
    PlanningSessionStatus.DISCOVERY,
    PlanningSessionStatus.DESIGN,
    PlanningSessionStatus.REVIEW,
    PlanningSessionStatus.APPROVED,
    PlanningSessionStatus.CANCELLED,
    PlanningSessionStatus.FAILED,
  ]),
  /** Discovery Phaseの質問リスト */
  questions: z.array(QuestionSchema),
  /** 現在の質問インデックス（セッション再開位置） */
  currentQuestionIndex: z.number().int().min(0),
  /** Design Phaseの決定点リスト */
  decisionPoints: z.array(DecisionPointSchema),
  /** 現在の決定点インデックス（セッション再開位置） */
  currentDecisionIndex: z.number().int().min(0),
  /** LLMとの会話履歴 */
  conversationHistory: z.array(ConversationMessageSchema),
  /** 拒否回数（最大3回でCANCELLED） */
  rejectCount: z.number().int().min(0).default(0),
  /** FAILED状態時のエラーメッセージ */
  errorMessage: z.string().nullable().optional(),
  /** 作成されたPlannerSessionのID（APPROVED時） */
  plannerSessionId: z.string().nullable().optional(),
  /** Discovery Phase実行ログのパス（絶対パス） */
  discoveryLogPath: z.string().nullable().optional(),
  /** Design Phase実行ログのパス（絶対パス） */
  designLogPath: z.string().nullable().optional(),
  /** Review Phase実行ログのパス（絶対パス） */
  reviewLogPath: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type PlanningSession = z.infer<typeof PlanningSessionSchema>;

/**
 * 新しいPlanning Sessionを作成するヘルパー関数
 */
export const createPlanningSession = (
  sessionId: string,
  instruction: string,
): PlanningSession => {
  const now = new Date().toISOString();
  return {
    sessionId,
    instruction,
    status: PlanningSessionStatus.DISCOVERY,
    questions: [],
    currentQuestionIndex: 0,
    decisionPoints: [],
    currentDecisionIndex: 0,
    conversationHistory: [],
    rejectCount: 0,
    errorMessage: null,
    plannerSessionId: null,
    discoveryLogPath: null,
    designLogPath: null,
    reviewLogPath: null,
    createdAt: now,
    updatedAt: now,
  };
};
