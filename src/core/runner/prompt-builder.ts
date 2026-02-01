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
 * Worker実行時のコンテキスト（ADR-032）
 */
export interface WorkerExecutionContext {
  /** Planning Sessionからのコンテキスト */
  planningContext?: string;
  /** タスク分解情報 */
  taskBreakdownContext?: string;
  /** 前回のレビュー結果（継続実行時） */
  previousReviewContext?: string;
  /** 関連タスクの完了状況 */
  relatedTasksContext?: string;
}

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

/**
 * レポートコンテキストを含むタスクプロンプトを構築（ADR-032）
 *
 * Planning Session、タスク分解、レビュー結果などのコンテキストを
 * プロンプトに統合する。
 *
 * @param task タスク情報
 * @param context 実行コンテキスト
 * @returns コンテキストを含むプロンプト文字列
 */
export const buildContextAwarePrompt = (task: Task, context: WorkerExecutionContext): string => {
  const sections: string[] = [];

  // Planning Sessionコンテキスト
  if (context.planningContext) {
    sections.push(`## Planning Sessionからのコンテキスト\n${context.planningContext}`);
  }

  // タスク分解コンテキスト
  if (context.taskBreakdownContext) {
    sections.push(`## タスク分解情報\n${context.taskBreakdownContext}`);
  }

  // 関連タスクの状況
  if (context.relatedTasksContext) {
    sections.push(`## 関連タスクの状況\n${context.relatedTasksContext}`);
  }

  // 前回レビュー結果（継続実行時）
  if (context.previousReviewContext) {
    sections.push(`## 前回のレビュー結果\n${context.previousReviewContext}`);
  }

  // 基本タスクプロンプト
  const basePrompt = buildTaskPrompt(task);

  if (sections.length === 0) {
    return basePrompt;
  }

  return `${sections.join('\n\n')}\n\n---\n\n${basePrompt}`;
};

/**
 * 依存タスクの完了状況からコンテキストを生成
 *
 * @param completedTasks 完了したタスクの情報
 * @returns 関連タスクコンテキスト文字列
 */
export const buildRelatedTasksContext = (
  completedTasks: Array<{ id: string; summary: string; deliverables?: string[] }>,
): string => {
  if (completedTasks.length === 0) {
    return '依存タスクはありません。';
  }

  const taskLines = completedTasks.map((t) => {
    const deliverables = t.deliverables?.length
      ? `\n  成果物: ${t.deliverables.join(', ')}`
      : '';
    return `- ${t.id}: ${t.summary}${deliverables}`;
  });

  return `以下のタスクが完了しています：\n${taskLines.join('\n')}`;
};

/**
 * 継続実行用のレビューコンテキストを生成
 *
 * @param verdict 前回の判定結果
 * @param feedback フィードバック内容
 * @param issues 指摘された問題点
 * @returns レビューコンテキスト文字列
 */
export const buildReviewContext = (
  verdict: string,
  feedback: string,
  issues?: Array<{ severity: string; location: string; description: string }>,
): string => {
  const sections: string[] = [`前回の判定: ${verdict}`, `フィードバック: ${feedback}`];

  if (issues && issues.length > 0) {
    const issueLines = issues.map(
      (i) => `- [${i.severity}] ${i.location}: ${i.description}`,
    );
    sections.push(`指摘事項:\n${issueLines.join('\n')}`);
  }

  return sections.join('\n\n');
};
