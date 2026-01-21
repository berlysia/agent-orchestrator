import type { Task } from '../../types/task.ts';
import type { TaskStore } from '../task-store/interface.ts';
import type { RunnerEffects } from '../runner/runner-effects.ts';
import { taskId } from '../../types/branded.ts';

/**
 * タスク読み込み結果
 */
export interface LoadTasksResult {
  /** 正常に読み込めたタスク */
  readonly tasks: Task[];
  /** 読み込みに失敗したタスクID */
  readonly failedTaskIds: string[];
}

/**
 * タスクを一括読み込み
 *
 * WHY: 複数の関数で重複していたタスク読み込みロジックを共通化
 *
 * @param taskIds 読み込むタスクIDの配列
 * @param taskStore タスクストア
 * @returns 読み込み結果（成功タスクと失敗タスクID）
 */
export async function loadTasks(
  taskIds: readonly string[],
  taskStore: TaskStore,
): Promise<LoadTasksResult> {
  const tasks: Task[] = [];
  const failedTaskIds: string[] = [];

  for (const rawTaskId of taskIds) {
    const taskResult = await taskStore.readTask(taskId(rawTaskId));
    if (!taskResult.ok) {
      console.warn(`⚠️  Failed to load task ${rawTaskId}: ${taskResult.err.message}`);
      failedTaskIds.push(rawTaskId);
      continue;
    }
    tasks.push(taskResult.val);
  }

  return { tasks, failedTaskIds };
}

/**
 * タスク結果サマリ
 */
export interface TaskResultSummary {
  /** タスクの説明（acceptance または branch） */
  readonly descriptions: string[];
  /** 実行ログのサマリ */
  readonly runSummaries: string[];
}

/**
 * 完了タスクのサマリを収集
 *
 * WHY: 複数の関数で重複していた完了タスク情報収集ロジックを共通化
 *
 * @param taskIds 収集対象のタスクID配列
 * @param taskStore タスクストア
 * @param runnerEffects Runner操作（実行ログ取得用）
 * @returns タスク結果サマリ
 */
export async function collectCompletedTaskSummaries(
  taskIds: readonly string[],
  taskStore: TaskStore,
  runnerEffects: RunnerEffects,
): Promise<TaskResultSummary> {
  const descriptions: string[] = [];
  const runSummaries: string[] = [];

  for (const rawTaskId of taskIds) {
    const taskResult = await taskStore.readTask(taskId(rawTaskId));
    if (taskResult.ok) {
      // タスク説明を追加
      descriptions.push(`[${rawTaskId}] ${taskResult.val.acceptance || taskResult.val.branch}`);

      // 実行ログサマリーを取得（DONE状態のタスクのみ考慮）
      const latestRunId = taskResult.val.latestRunId;
      if (latestRunId) {
        const runMetadataResult = await runnerEffects.loadRunMetadata(latestRunId);
        if (runMetadataResult.ok) {
          const run = runMetadataResult.val;
          const summary = `[${rawTaskId}] Status: ${run.status}${run.errorMessage ? `, Error: ${run.errorMessage}` : ''}`;
          runSummaries.push(summary);
        }
      }
    }
  }

  return { descriptions, runSummaries };
}

/**
 * 失敗タスクの説明を収集
 *
 * WHY: 複数の関数で重複していた失敗タスク情報収集ロジックを共通化
 *
 * @param taskIds 収集対象のタスクID配列
 * @param taskStore タスクストア
 * @returns 失敗タスクの説明配列
 */
export async function collectFailedTaskDescriptions(
  taskIds: readonly string[],
  taskStore: TaskStore,
): Promise<string[]> {
  const descriptions: string[] = [];

  for (const rawTaskId of taskIds) {
    const taskResult = await taskStore.readTask(taskId(rawTaskId));
    if (taskResult.ok) {
      descriptions.push(`[${rawTaskId}] ${taskResult.val.acceptance || taskResult.val.branch}`);
    }
  }

  return descriptions;
}
