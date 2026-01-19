import { z } from 'zod';

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
 *
 * WHY: generatedTasksの型を`z.any()`にしているのは、TaskBreakdownSchemaをインポートすると
 *      循環依存が発生するため。実行時には正しいTaskBreakdown[]として扱われる。
 */
export const PlannerSessionSchema = z.object({
  sessionId: z.string(),
  instruction: z.string(),
  conversationHistory: z.array(ConversationMessageSchema),
  generatedTasks: z.array(z.any()),
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
});

export type PlannerSession = z.infer<typeof PlannerSessionSchema>;

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
  };
};
