import {
  WorkerFeedbackSchema,
  type WorkerFeedback,
} from '../../types/task.ts';

/**
 * Worker 実行ログから構造化フィードバックを抽出
 *
 * WHY: Worker エージェントの出力から JSON フィードバックを抽出し、
 *      Leader が動的タスク生成に活用できる形にする（ADR-024）
 *
 * @param runLog Worker 実行ログの全文
 * @returns 抽出・検証済みのフィードバック、または null（抽出/検証失敗時）
 */
export function extractWorkerFeedback(runLog: string): WorkerFeedback | null {
  // ## Feedback セクション内の JSON を抽出
  const feedbackMatch = runLog.match(
    /## Feedback[\s\S]*?```json\s*([\s\S]*?)```/,
  );
  if (!feedbackMatch || feedbackMatch[1] === undefined) {
    return null;
  }

  try {
    const rawFeedback = JSON.parse(feedbackMatch[1]);
    // WorkerFeedback スキーマでバリデーション
    return validateWorkerFeedback(rawFeedback);
  } catch {
    return null;
  }
}

/**
 * フィードバックオブジェクトを WorkerFeedback スキーマで検証
 *
 * @param feedback 未検証のフィードバックオブジェクト
 * @returns 検証済みの WorkerFeedback、または null（検証失敗時）
 */
export function validateWorkerFeedback(
  feedback: unknown,
): WorkerFeedback | null {
  const result = WorkerFeedbackSchema.safeParse(feedback);
  if (result.success) {
    return result.data;
  }
  return null;
}

/**
 * フィードバックから推奨アクションを抽出
 *
 * @param feedback Worker フィードバック
 * @returns 推奨アクションの配列（空配列の場合もあり）
 */
export function extractRecommendations(feedback: WorkerFeedback): string[] {
  if (feedback.type === 'exploration') {
    return feedback.recommendations;
  }
  if (feedback.type === 'implementation' && feedback.recommendations) {
    return feedback.recommendations;
  }
  return [];
}

/**
 * フィードバックから発見パターンを抽出
 *
 * @param feedback Worker フィードバック
 * @returns 発見パターンの配列（空配列の場合もあり）
 */
export function extractPatterns(feedback: WorkerFeedback): string[] {
  if ('patterns' in feedback && Array.isArray(feedback.patterns)) {
    return feedback.patterns;
  }
  return [];
}

/**
 * フィードバックから発見事項を抽出
 *
 * @param feedback Worker フィードバック
 * @returns 発見事項の配列（空配列の場合もあり）
 */
export function extractFindings(feedback: WorkerFeedback): string[] {
  if (feedback.type === 'implementation' && feedback.findings) {
    return feedback.findings;
  }
  if (feedback.type === 'exploration') {
    // exploration の findings は string なので配列に変換
    return [feedback.findings];
  }
  return [];
}
