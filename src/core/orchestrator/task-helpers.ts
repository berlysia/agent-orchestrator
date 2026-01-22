import type { Task } from '../../types/task.ts';
import type { TaskStore } from '../task-store/interface.ts';
import type { RunnerEffects } from '../runner/runner-effects.ts';
import { taskId } from '../../types/branded.ts';
import type { TaskBreakdown } from '../../types/task-breakdown.ts';
import type { PlannerSession } from '../../types/planner-session.ts';

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

/**
 * セッションIDから短縮版を抽出
 *
 * WHY: タスクIDを一意にするため、セッションIDの一部を使用
 *
 * @param runId プランナー実行ID（"planner-xxx", "planner-additional-xxx", "planner-replanning-xxx"）
 * @returns 短縮版ID（8文字）
 */
export const extractSessionShort = (runId: string): string => {
  // 各プレフィックスの後の8文字を取得
  if (runId.startsWith('planner-additional-')) {
    return runId.substring(19, 27);
  }
  if (runId.startsWith('planner-replanning-')) {
    return runId.substring(19, 27);
  }
  return runId.substring(8, 16);
};

/**
 * ルートセッションに属する全タスクを取得
 *
 * WHY: continue で追加されたタスクも含めて、元のセッションチェーン全体のタスクを取得
 *
 * @param rootSessionId ルートセッションID
 * @param tasks 検索対象のタスク配列
 * @returns ルートセッションに属するタスク配列
 */
export const getTasksByRootSession = (rootSessionId: string, tasks: readonly Task[]): Task[] => {
  return tasks.filter(
    (task) =>
      task.rootSessionId === rootSessionId ||
      task.sessionId === rootSessionId, // ルート自身のタスクも含む
  );
};

/**
 * セッションの親子チェーンを取得（同期版、タスクから取得）
 *
 * WHY: タスクの parentSessionId を辿って、セッションの階層構造を取得
 *
 * @param sessionId 開始セッションID
 * @param tasks 検索対象のタスク配列
 * @returns セッションIDチェーン（ルートから開始セッションまで）
 */
export const getSessionChainFromTasks = (
  sessionId: string,
  tasks: readonly Task[],
): string[] => {
  const chain: string[] = [sessionId];
  const visited = new Set<string>([sessionId]);

  let currentSessionId = sessionId;

  // タスクから親セッションIDを見つける
  while (true) {
    const taskWithParent = tasks.find(
      (t) => t.sessionId === currentSessionId && t.parentSessionId,
    );

    if (!taskWithParent || !taskWithParent.parentSessionId) {
      break;
    }

    const parentId = taskWithParent.parentSessionId;

    // 循環検出
    if (visited.has(parentId)) {
      console.warn(`⚠️  Circular session reference detected: ${parentId}`);
      break;
    }

    visited.add(parentId);
    chain.unshift(parentId);
    currentSessionId = parentId;
  }

  return chain;
};

/**
 * タスクIDからセッション短縮IDとタスク番号を抽出
 *
 * WHY: TaskBreakdown.id（"task-1"）とTask.id（"task-xxxx-1"）の対応を取得
 *
 * @param fullTaskId フルタスクID（"task-xxxx-1"など）
 * @returns {sessionShort, taskNumber} または null（フォーマットが不正な場合）
 */
export const parseTaskId = (fullTaskId: string): { sessionShort: string; taskNumber: string } | null => {
  // フォーマット: task-{sessionShort}-{number}
  const match = fullTaskId.match(/^task-([a-f0-9]{8})-(.+)$/);
  if (!match) {
    return null;
  }
  return {
    sessionShort: match[1]!,
    taskNumber: match[2]!,
  };
};

/**
 * タスクに対応するTaskBreakdownをセッションから取得
 *
 * WHY: Session側で管理されているTaskBreakdown情報（description, estimatedDuration等）を
 *      Task経由で参照可能にする（Single Source of Truth）
 *
 * @param task タスク
 * @param session タスクが属するプランナーセッション
 * @returns TaskBreakdown または null（見つからない場合）
 */
export const getTaskBreakdown = (task: Task, session: PlannerSession): TaskBreakdown | null => {
  const parsed = parseTaskId(String(task.id));
  if (!parsed) {
    return null;
  }

  // TaskBreakdown.id は "task-N" 形式
  const breakdownId = `task-${parsed.taskNumber}`;

  return session.generatedTasks.find((tb) => tb.id === breakdownId) ?? null;
};

/**
 * タスク情報の詳細を取得（TaskBreakdown情報を含む）
 *
 * WHY: CLI表示やログ出力で、TaskBreakdownに含まれる詳細情報（description, estimatedDuration等）を
 *      タスクと一緒に表示できるようにする
 *
 * @param task タスク
 * @param session タスクが属するプランナーセッション
 * @returns タスク詳細情報
 */
export const getTaskDetails = (
  task: Task,
  session: PlannerSession,
): {
  task: Task;
  breakdown: TaskBreakdown | null;
  description: string | null;
  estimatedDuration: number | null;
} => {
  const breakdown = getTaskBreakdown(task, session);
  return {
    task,
    breakdown,
    description: breakdown?.description ?? null,
    estimatedDuration: breakdown?.estimatedDuration ?? null,
  };
};
