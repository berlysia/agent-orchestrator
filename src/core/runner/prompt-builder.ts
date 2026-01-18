/**
 * Prompt Builder - プロンプト生成の純粋関数
 *
 * タスク情報から Agent プロンプトを生成する純粋関数群。
 * 副作用を含まないため、テストが容易。
 */

import type { Task } from '../../types/task.ts';
import type { Run } from '../../types/run.ts';
import type { TaskId } from '../../types/branded.ts';
import { runId as createRunId } from '../../types/branded.ts';
import { createInitialRun, RunStatus } from '../../types/run.ts';

/**
 * タスク情報からプロンプトを構築
 *
 * scopePaths と acceptance を含めたプロンプトを生成する。
 *
 * @param task タスク情報
 * @returns プロンプト文字列
 */
export const buildTaskPrompt = (task: Task): string => {
  // scopePaths がある場合は関連ファイルを指定
  const scopeInfo =
    task.scopePaths.length > 0 ? `\n関連ファイル: ${task.scopePaths.join(', ')}` : '';

  // 受け入れ条件がある場合は含める
  const acceptanceInfo = task.acceptance ? `\n受け入れ条件: ${task.acceptance}` : '';

  return `タスク: ${task.id}${scopeInfo}${acceptanceInfo}

実装してください。`;
};

/**
 * 初期 Run レコードを作成
 *
 * @param taskId タスクID
 * @param agentType エージェント種別
 * @returns 初期 Run レコード
 */
export const createRunRecord = (taskId: TaskId, agentType: 'claude' | 'codex'): Run => {
  const rawRunId = `${agentType}-${taskId}-${Date.now()}`;
  return createInitialRun({
    id: createRunId(rawRunId),
    taskId,
    agentType,
    logPath: `runs/${rawRunId}.log`,
  });
};

/**
 * Run を成功状態に更新
 *
 * イミュータブルな更新を行う。
 *
 * @param run 元の Run レコード
 * @returns 成功状態に更新された Run レコード
 */
export const markRunSuccess = (run: Run): Run => ({
  ...run,
  status: RunStatus.SUCCESS,
  finishedAt: new Date().toISOString(),
});

/**
 * Run を失敗状態に更新
 *
 * イミュータブルな更新を行う。
 *
 * @param run 元の Run レコード
 * @param errorMessage エラーメッセージ
 * @returns 失敗状態に更新された Run レコード
 */
export const markRunFailure = (run: Run, errorMessage: string): Run => ({
  ...run,
  status: RunStatus.FAILURE,
  finishedAt: new Date().toISOString(),
  errorMessage,
});
