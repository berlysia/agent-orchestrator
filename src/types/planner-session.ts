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
});

export type PlannerSession = z.infer<typeof PlannerSessionSchema>;

/**
 * 新しいセッションを作成するためのヘルパー関数
 */
export const createPlannerSession = (
  sessionId: string,
  instruction: string,
): PlannerSession => {
  const now = new Date().toISOString();
  return {
    sessionId,
    instruction,
    conversationHistory: [],
    generatedTasks: [],
    createdAt: now,
    updatedAt: now,
  };
};
