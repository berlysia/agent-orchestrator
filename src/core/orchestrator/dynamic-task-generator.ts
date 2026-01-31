import { randomUUID } from 'node:crypto';
import type { Task } from '../../types/task.ts';
import type { WorkerFeedback } from '../../types/task.ts';
import {
  type TaskCandidate,
  type TaskCandidateCategory,
  TaskCandidateCategory as CategoryEnum,
  TaskCandidateStatus,
  TaskCandidateSource,
} from '../../types/leader-session.ts';
import { taskId } from '../../types/branded.ts';
import {
  extractRecommendations,
  extractPatterns,
  extractFindings,
} from './worker-feedback-extractor.ts';

/**
 * フィードバックからタスク候補を生成
 *
 * WHY: Worker が発見したパターンや推奨アクションを
 *      Leader が動的にタスク化できるようにする（ADR-024）
 *
 * @param feedback Worker フィードバック
 * @param task 元タスク
 * @returns タスク候補配列
 */
export function generateTaskCandidates(
  feedback: WorkerFeedback,
  task: Task,
): TaskCandidate[] {
  const candidates: TaskCandidate[] = [];

  // 推奨アクションからタスク候補を生成
  const recommendations = extractRecommendations(feedback);
  for (const rec of recommendations) {
    candidates.push({
      id: `candidate-${randomUUID()}`,
      source: TaskCandidateSource.WORKER_RECOMMENDATION,
      relatedTaskId: taskId(task.id),
      description: rec,
      priority: determinePriority(rec),
      autoExecutable: isAutoExecutable(rec, task),
      category: categorizeRecommendation(rec),
      createdAt: new Date().toISOString(),
      status: TaskCandidateStatus.PENDING,
    });
  }

  // パターン発見からタスク候補を生成
  const patterns = extractPatterns(feedback);
  for (const pattern of patterns) {
    candidates.push({
      id: `candidate-${randomUUID()}`,
      source: TaskCandidateSource.PATTERN_DISCOVERY,
      relatedTaskId: taskId(task.id),
      description: `Refactor: ${pattern}`,
      priority: 'low', // パターン系は低優先度
      autoExecutable: false, // パターン系は承認必須
      category: CategoryEnum.REFACTORING,
      createdAt: new Date().toISOString(),
      status: TaskCandidateStatus.PENDING,
    });
  }

  // 発見事項からタスク候補を生成（exploration タイプの場合）
  const findings = extractFindings(feedback);
  for (const finding of findings) {
    // セキュリティ関連の発見事項は高優先度で候補化
    if (isSecurityRelated(finding)) {
      candidates.push({
        id: `candidate-${randomUUID()}`,
        source: TaskCandidateSource.EXPLORATION_FINDING,
        relatedTaskId: taskId(task.id),
        description: `Security: ${finding}`,
        priority: 'high',
        autoExecutable: false, // セキュリティ関連は承認必須
        category: CategoryEnum.SECURITY,
        createdAt: new Date().toISOString(),
        status: TaskCandidateStatus.PENDING,
      });
    }
  }

  return candidates;
}

/**
 * 推奨アクションの優先度を判定
 *
 * WHY: キーワードベースの簡易判定。将来的に LLM による分類に置き換え可能
 */
function determinePriority(recommendation: string): 'low' | 'medium' | 'high' {
  const lower = recommendation.toLowerCase();

  // 高優先度キーワード
  if (
    lower.includes('security') ||
    lower.includes('vulnerability') ||
    lower.includes('critical') ||
    lower.includes('urgent') ||
    lower.includes('bug') ||
    lower.includes('error')
  ) {
    return 'high';
  }

  // 中優先度キーワード
  if (
    lower.includes('performance') ||
    lower.includes('optimize') ||
    lower.includes('improve') ||
    lower.includes('fix')
  ) {
    return 'medium';
  }

  // デフォルトは低優先度
  return 'low';
}

/**
 * 自動実行可能か判定
 *
 * 初期は保守的に、スコープ内の小規模変更のみ自動実行可能とする
 *
 * WHY: ADR-024 の設計方針「初期実装では全て承認必須」に従う
 *      将来的に以下のような条件で自動実行を許可:
 *      - 元タスクと同じスコープ内
 *      - リスク低（命名規則、コメント追加など）
 *      - セキュリティ関連でない
 */
function isAutoExecutable(_recommendation: string, _task: Task): boolean {
  // 初期実装では全て承認必須
  return false;
}

/**
 * 推奨アクションをカテゴリに分類
 *
 * WHY: キーワードベースの簡易分類。将来的に LLM による分類に置き換え可能
 */
function categorizeRecommendation(recommendation: string): TaskCandidateCategory {
  const lower = recommendation.toLowerCase();

  if (
    lower.includes('security') ||
    lower.includes('vulnerability') ||
    lower.includes('auth') ||
    lower.includes('encrypt')
  ) {
    return CategoryEnum.SECURITY;
  }

  if (
    lower.includes('performance') ||
    lower.includes('optimize') ||
    lower.includes('cache') ||
    lower.includes('speed')
  ) {
    return CategoryEnum.PERFORMANCE;
  }

  if (
    lower.includes('refactor') ||
    lower.includes('extract') ||
    lower.includes('consolidate') ||
    lower.includes('deduplicate')
  ) {
    return CategoryEnum.REFACTORING;
  }

  if (
    lower.includes('architect') ||
    lower.includes('structure') ||
    lower.includes('design') ||
    lower.includes('pattern')
  ) {
    return CategoryEnum.ARCHITECTURE;
  }

  if (
    lower.includes('maintain') ||
    lower.includes('readable') ||
    lower.includes('clean') ||
    lower.includes('simplify')
  ) {
    return CategoryEnum.MAINTAINABILITY;
  }

  if (
    lower.includes('document') ||
    lower.includes('comment') ||
    lower.includes('readme') ||
    lower.includes('jsdoc')
  ) {
    return CategoryEnum.DOCUMENTATION;
  }

  // デフォルトはコード品質
  return CategoryEnum.CODE_QUALITY;
}

/**
 * セキュリティ関連の発見事項か判定
 */
function isSecurityRelated(finding: string): boolean {
  const lower = finding.toLowerCase();
  return (
    lower.includes('security') ||
    lower.includes('vulnerability') ||
    lower.includes('injection') ||
    lower.includes('xss') ||
    lower.includes('csrf') ||
    lower.includes('auth') ||
    lower.includes('password') ||
    lower.includes('credential') ||
    lower.includes('sensitive')
  );
}
