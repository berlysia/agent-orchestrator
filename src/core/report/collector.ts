/**
 * Report data collector
 *
 * WHY: セッションとタスクからレポートデータを収集・集計する
 *      監視レポート機能の中核となるデータ収集ロジック
 */

import type { Result } from 'option-t/plain_result';
import { createOk, createErr } from 'option-t/plain_result';
import { ioError, type TaskStoreError } from '../../types/errors.ts';
import type { Task } from '../../types/task.ts';
import { TaskState as TaskStateEnum, BlockReason } from '../../types/task.ts';
import type { PlannerSessionEffects } from '../orchestrator/planner-session-effects.ts';
import type { TaskStore } from '../task-store/interface.ts';
import { listSessionsByRootId } from '../session/queries.ts';
import type {
  ReportData,
  ReportPeriod,
  TaskStatistics,
  TaskSummary,
  ReportEvent,
  IntegrationInfo,
} from './types.ts';

/**
 * rootSessionIdから全セッションと全タスクを取得してレポートデータを生成
 *
 * WHY: 監視レポート生成の基礎データを提供する
 *
 * 実装手順:
 * 1. listSessionsByRootId()で全セッション取得
 * 2. listTasks()で全タスクを取得し、rootSessionIdでフィルタリング
 * 3. タスク状態をカウントして統計計算
 * 4. タスクからサマリー生成
 * 5. タスク状態からイベント検出（retryCount > 0ならRETRY、conflictフラグがあればCONFLICT）
 *
 * @param rootSessionId ルートセッションID
 * @param sessionEffects セッション操作インターフェース
 * @param taskStore タスクストア
 * @returns レポートデータまたはエラー
 */
export async function collectReportData(
  rootSessionId: string,
  sessionEffects: PlannerSessionEffects,
  taskStore: TaskStore,
  integrationInfo?: IntegrationInfo,
): Promise<Result<ReportData, TaskStoreError>> {
  // 1. listSessionsByRootId()で全セッション取得
  const sessionsResult = await listSessionsByRootId(rootSessionId, sessionEffects);
  if (!sessionsResult.ok) {
    return sessionsResult as Result<ReportData, TaskStoreError>;
  }
  const sessions = sessionsResult.val;

  if (sessions.length === 0) {
    return createErr(ioError('listSessionsByRootId', `No sessions found for rootSessionId: ${rootSessionId}`));
  }

  // 2. listTasks()で全タスクを取得し、rootSessionIdでフィルタリング
  const tasksResult = await taskStore.listTasks();
  if (!tasksResult.ok) {
    return tasksResult as Result<ReportData, TaskStoreError>;
  }

  const allTasks = tasksResult.val;
  // rootSessionIdに属するタスクのみをフィルタリング
  const tasks = allTasks.filter((task) => task.rootSessionId === rootSessionId);

  // 3. タスク状態をカウントして統計計算
  const statistics = calculateStatistics(tasks);

  // 4. タスクからサマリー生成
  const taskSummaries = tasks.map((task) => createTaskSummary(task));

  // 5. タスク状態からイベント検出
  const events = detectEvents(tasks);

  // 6. 監視期間を計算
  const period = calculatePeriod(tasks);

  return createOk({
    rootSessionId,
    period,
    statistics,
    taskSummaries,
    events,
    ...(integrationInfo && { integration: integrationInfo }),
  });
}

/**
 * タスク統計を計算
 *
 * WHY: タスク状態別の集計データを提供する
 *
 * @param tasks タスク配列
 * @returns タスク統計
 */
function calculateStatistics(tasks: Task[]): TaskStatistics {
  const statistics: TaskStatistics = {
    total: tasks.length,
    completed: 0,
    failed: 0,
    skipped: 0,
    blocked: 0,
  };

  for (const task of tasks) {
    switch (task.state) {
      case TaskStateEnum.DONE:
        statistics.completed++;
        break;
      case TaskStateEnum.BLOCKED:
        statistics.blocked++;
        break;
      case TaskStateEnum.SKIPPED:
        statistics.skipped++;
        break;
      case TaskStateEnum.CANCELLED:
        // CANCELLEDは失敗としてカウント
        statistics.failed++;
        break;
      case TaskStateEnum.REPLACED_BY_REPLAN:
        // REPLACED_BY_REPLANは失敗としてカウント
        statistics.failed++;
        break;
      // READY, RUNNING, NEEDS_CONTINUATIONは進行中なので統計に含めない
      default:
        break;
    }
  }

  return statistics;
}

/**
 * タスクからサマリーを生成
 *
 * WHY: レポート表示用のタスク情報を提供する
 *
 * @param task タスク
 * @returns タスクサマリー
 */
function createTaskSummary(task: Task): TaskSummary {
  const summary: TaskSummary = {
    taskId: task.id,
    description: task.summary ?? task.acceptance.slice(0, 50),
    status: task.state,
  };

  // 実行時間を計算（createdAt から updatedAt まで）
  if (task.createdAt && task.updatedAt) {
    const createdAt = new Date(task.createdAt).getTime();
    const updatedAt = new Date(task.updatedAt).getTime();
    summary.duration = updatedAt - createdAt;
  }

  // エラーメッセージを設定
  if (task.state === TaskStateEnum.BLOCKED && task.blockMessage) {
    summary.error = task.blockMessage;
  } else if (task.state === TaskStateEnum.CANCELLED) {
    summary.error = 'Task was cancelled';
  } else if (
    task.state === TaskStateEnum.REPLACED_BY_REPLAN &&
    task.replanningInfo?.replanReason
  ) {
    summary.error = task.replanningInfo.replanReason;
  }

  return summary;
}

/**
 * タスクからイベントを検出
 *
 * WHY: タスク実行中に発生した重要なイベントを記録する
 *
 * 検出ルール:
 * - judgementFeedback.iteration > 0 ならRETRY
 * - blockReason === 'CONFLICT' ならCONFLICT
 * - pendingConflictResolution があればCONFLICT
 *
 * @param tasks タスク配列
 * @returns イベント配列
 */
function detectEvents(tasks: Task[]): ReportEvent[] {
  const events: ReportEvent[] = [];

  for (const task of tasks) {
    // RETRYイベントの検出
    if (task.judgementFeedback && task.judgementFeedback.iteration > 0) {
      events.push({
        type: 'RETRY',
        timestamp: new Date(
          task.judgementFeedback.lastJudgement.evaluatedAt,
        ),
        taskId: task.id,
        details: `Task retried ${task.judgementFeedback.iteration} time(s). Reason: ${task.judgementFeedback.lastJudgement.reason}`,
      });
    }

    // CONFLICTイベントの検出
    if (task.blockReason === BlockReason.CONFLICT) {
      events.push({
        type: 'CONFLICT',
        timestamp: new Date(task.updatedAt),
        taskId: task.id,
        details: task.blockMessage ?? 'Merge conflict detected',
      });
    }

    // pendingConflictResolutionからもCONFLICTを検出
    if (task.pendingConflictResolution) {
      events.push({
        type: 'CONFLICT',
        timestamp: new Date(task.updatedAt),
        taskId: task.id,
        details: `Waiting for conflict resolution task: ${task.pendingConflictResolution.conflictTaskId}`,
      });
    }

    // タイムアウトの検出は現在のTask型には含まれていないため省略
    // 将来的にtimeoutフラグが追加されたら実装する
  }

  // イベントを時系列順にソート
  events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  return events;
}

/**
 * 監視期間を計算
 *
 * WHY: レポート対象の時間範囲を提供する
 *
 * 計算ロジック:
 * - 開始時刻: 最も古いタスクのcreatedAt
 * - 終了時刻: 最も新しいタスクのupdatedAt
 *
 * @param tasks タスク配列
 * @returns 監視期間
 */
function calculatePeriod(tasks: Task[]): ReportPeriod {
  if (tasks.length === 0) {
    const now = new Date();
    return { start: now, end: now };
  }

  // 最も古いタスクのcreatedAtを開始時刻とする
  const startTimestamps = tasks.map((task) => new Date(task.createdAt).getTime());
  const minTimestamp = Math.min(...startTimestamps);

  // 最も新しいタスクのupdatedAtを終了時刻とする
  const endTimestamps = tasks.map((task) => new Date(task.updatedAt).getTime());
  const maxTimestamp = Math.max(...endTimestamps);

  return {
    start: new Date(minTimestamp),
    end: new Date(maxTimestamp),
  };
}
