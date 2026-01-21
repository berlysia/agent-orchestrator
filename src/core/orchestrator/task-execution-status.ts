import type { TaskId } from '../../types/branded.ts';

/**
 * タスク実行ステータス
 *
 * WHY: タスク実行結果の種類を明示的に定義し、一貫性を保つため
 */
export const TaskExecutionStatus = {
  /** タスク完了 */
  COMPLETED: 'completed',
  /** タスク失敗 */
  FAILED: 'failed',
  /** タスク継続（NEEDS_CONTINUATION状態） */
  CONTINUE: 'continue',
  /** タスク再計画（shouldReplan=trueで新タスクに置き換えられた） */
  REPLANNED: 'replanned',
} as const;

export type TaskExecutionStatusType = (typeof TaskExecutionStatus)[keyof typeof TaskExecutionStatus];

/**
 * タスク実行結果
 */
export interface TaskExecutionResult {
  taskId: TaskId;
  status: TaskExecutionStatusType;
  workerId: string;
}
