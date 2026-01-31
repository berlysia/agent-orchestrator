/**
 * Exploration Session Types
 *
 * ADR-025: 自律探索モード
 *
 * コードベースを自律的に探索し、改善点を発見・提案するための型定義。
 */

import { z } from 'zod';
import { taskId } from './branded.ts';

/**
 * 探索フォーカス
 */
export const ExplorationFocus = {
  CODE_QUALITY: 'code-quality',
  SECURITY: 'security',
  PERFORMANCE: 'performance',
  MAINTAINABILITY: 'maintainability',
  ARCHITECTURE: 'architecture',
  DOCUMENTATION: 'documentation',
  TEST_COVERAGE: 'test-coverage',
} as const;

export type ExplorationFocus =
  (typeof ExplorationFocus)[keyof typeof ExplorationFocus];

/**
 * 発見事項の重要度
 */
export const FindingSeverity = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
} as const;

export type FindingSeverity =
  (typeof FindingSeverity)[keyof typeof FindingSeverity];

/**
 * 探索セッションのステータス
 */
export const ExplorationStatus = {
  EXPLORING: 'exploring',
  AWAITING_APPROVAL: 'awaiting-approval',
  EXECUTING: 'executing',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type ExplorationStatus =
  (typeof ExplorationStatus)[keyof typeof ExplorationStatus];

/**
 * 発見事項のロケーション
 */
export const FindingLocationSchema = z.object({
  file: z.string(),
  line: z.number().optional(),
  endLine: z.number().optional(),
});

export type FindingLocation = z.infer<typeof FindingLocationSchema>;

/**
 * 発見事項
 */
export const FindingSchema = z.object({
  id: z.string(),
  category: z.enum([
    'code-quality',
    'security',
    'performance',
    'maintainability',
    'architecture',
    'documentation',
    'test-coverage',
  ]),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  location: FindingLocationSchema,
  title: z.string(),
  description: z.string(),
  recommendation: z.string(),
  actionable: z.boolean(),
  codeSnippet: z.string().optional(),
});

export type Finding = z.infer<typeof FindingSchema>;

/**
 * 発見事項を作成
 */
export function createFinding(data: Omit<Finding, 'id'>): Finding {
  const id = `finding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, ...data };
}

/**
 * タスク候補
 */
export const TaskCandidateSchema = z.object({
  id: z.string(),
  findingId: z.string(),
  summary: z.string(),
  description: z.string(),
  estimatedEffort: z.enum(['small', 'medium', 'large']).optional(),
  approved: z.boolean().default(false),
  taskId: z.string().transform(taskId).optional(),
});

export type TaskCandidate = z.infer<typeof TaskCandidateSchema>;

/**
 * タスク候補を作成
 */
export function createTaskCandidate(data: Omit<TaskCandidate, 'id' | 'approved'>): TaskCandidate {
  const id = `candidate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, approved: false, ...data };
}

/**
 * 探索セッション
 */
export const ExplorationSessionSchema = z.object({
  sessionId: z.string(),
  focus: z.array(z.enum([
    'code-quality',
    'security',
    'performance',
    'maintainability',
    'architecture',
    'documentation',
    'test-coverage',
  ])),
  scope: z.array(z.string()), // ディレクトリパス
  status: z.enum([
    'exploring',
    'awaiting-approval',
    'executing',
    'completed',
    'failed',
  ]),
  findings: z.array(FindingSchema),
  taskCandidates: z.array(TaskCandidateSchema),
  approvedTaskIds: z.array(z.string()),
  executedTaskIds: z.array(z.string()),
  explorationTaskId: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
});

export type ExplorationSession = z.infer<typeof ExplorationSessionSchema>;

/**
 * 探索セッションを作成
 */
export function createExplorationSession(
  focus: ExplorationFocus[],
  scope: string[],
): ExplorationSession {
  const now = new Date().toISOString();
  const sessionId = `explore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    sessionId,
    focus: focus as ExplorationSession['focus'],
    scope,
    status: 'exploring',
    findings: [],
    taskCandidates: [],
    approvedTaskIds: [],
    executedTaskIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 探索セッションを更新
 */
export function updateExplorationSession(
  session: ExplorationSession,
  updates: Partial<Omit<ExplorationSession, 'sessionId' | 'createdAt'>>,
): ExplorationSession {
  return {
    ...session,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 発見事項のサマリーを取得
 */
export function getFindingsSummary(findings: Finding[]): {
  total: number;
  bySeverity: Record<FindingSeverity, number>;
  byCategory: Partial<Record<ExplorationFocus, number>>;
} {
  const bySeverity: Record<FindingSeverity, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };

  const byCategory: Partial<Record<ExplorationFocus, number>> = {};

  for (const finding of findings) {
    bySeverity[finding.severity]++;
    byCategory[finding.category] = (byCategory[finding.category] ?? 0) + 1;
  }

  return {
    total: findings.length,
    bySeverity,
    byCategory,
  };
}

/**
 * 発見事項をフィルタリング
 */
export function filterFindings(
  findings: Finding[],
  options: {
    severity?: FindingSeverity[];
    category?: ExplorationFocus[];
    actionable?: boolean;
  },
): Finding[] {
  return findings.filter((finding) => {
    if (options.severity && !options.severity.includes(finding.severity)) {
      return false;
    }
    if (options.category && !options.category.includes(finding.category as ExplorationFocus)) {
      return false;
    }
    if (options.actionable !== undefined && finding.actionable !== options.actionable) {
      return false;
    }
    return true;
  });
}
