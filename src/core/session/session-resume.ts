/**
 * Session Resume Context (ADR-027)
 *
 * セッション再開に必要なコンテキストを抽出する機能。
 * 中断されたセッションのログを読み取り、再開に必要な情報をまとめる。
 */

import type { Result } from 'option-t/plain_result';
import { createOk, createErr } from 'option-t/plain_result';
import type { SessionId, TaskId } from '../../types/branded.ts';
import { sessionId as toSessionId } from '../../types/branded.ts';
import type { SessionLogError } from '../../types/errors.ts';
import { sessionResumeError } from '../../types/errors.ts';
import {
  SessionLogType,
  type SessionPhase,
  type JudgeVerdict,
} from '../../types/session-log.ts';
import type { SessionPointerManager, SessionPointerInfo } from './session-logger.ts';
import {
  readSessionLog,
  getSessionBoundaries,
} from '../report/ndjson-extractor.ts';

/**
 * タスクの再開状態
 */
export interface TaskResumeState {
  /** タスクID */
  taskId: TaskId;
  /** タスクタイトル */
  title: string;
  /** 最終状態 */
  status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'needs_continuation';
  /** Worker実行回数 */
  iterations: number;
  /** 最終Judge判定 */
  lastVerdict?: JudgeVerdict;
  /** 依存タスク */
  dependencies: TaskId[];
}

/**
 * セッション再開コンテキスト
 */
export interface SessionResumeContext {
  /** セッションID */
  sessionId: SessionId;
  /** 元のタスク説明 */
  originalTask: string;
  /** セッション開始時刻 */
  startedAt: string;
  /** 最後のフェーズ */
  lastPhase: SessionPhase | null;
  /** フェーズが完了したかどうか */
  phaseCompleted: boolean;
  /** タスク状態一覧 */
  tasks: TaskResumeState[];
  /** 完了タスク数 */
  completedTaskCount: number;
  /** 未完了タスク数 */
  pendingTaskCount: number;
  /** 中断理由（あれば） */
  abortReason?: string;
  /** 最後のエラー（あれば） */
  lastError?: string;
  /** 再開可能かどうか */
  canResume: boolean;
  /** 再開推奨アクション */
  resumeAction: 'continue_phase' | 'restart_phase' | 'restart_session' | 'none';
}

/**
 * セッションが再開可能か判定
 */
export async function canResumeSession(
  _basePath: string,
  pointerManager: SessionPointerManager,
): Promise<Result<SessionPointerInfo | null, SessionLogError>> {
  const latestResult = await pointerManager.getLatest();

  if (!latestResult.ok) {
    // ポインタが存在しない場合は再開対象なし
    return createOk(null);
  }

  const latest = latestResult.val;

  // runningまたはaborted状態のセッションは再開候補
  if (latest.status === 'running' || latest.status === 'aborted') {
    return createOk(latest);
  }

  return createOk(null);
}

/**
 * セッションログから再開コンテキストを抽出
 */
export async function extractResumeContext(
  basePath: string,
  sid: string,
): Promise<Result<SessionResumeContext, SessionLogError>> {
  const sessionIdTyped = toSessionId(sid);

  try {
    // セッション境界を取得
    const boundaries = await getSessionBoundaries(basePath, sid);

    if (!boundaries.start) {
      return createErr(sessionResumeError(sid, 'Session start record not found'));
    }

    // 基本情報を初期化
    let originalTask = '';
    let startedAt = '';
    let lastPhase: SessionPhase | null = null;
    let phaseCompleted = false;
    let abortReason: string | undefined;
    let lastError: string | undefined;

    // タスク状態を追跡
    const taskStates = new Map<
      string,
      {
        taskId: TaskId;
        title: string;
        status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'needs_continuation';
        iterations: number;
        lastVerdict?: JudgeVerdict;
        dependencies: TaskId[];
      }
    >();

    // ログを順番に処理
    for await (const record of readSessionLog(basePath, sid)) {
      switch (record.type) {
        case SessionLogType.SESSION_START:
          originalTask = record.task;
          startedAt = record.timestamp;
          break;

        case SessionLogType.SESSION_ABORT:
          abortReason = record.reason;
          break;

        case SessionLogType.PHASE_START:
          lastPhase = record.phase;
          phaseCompleted = false;
          break;

        case SessionLogType.PHASE_COMPLETE:
          if (record.phase === lastPhase) {
            phaseCompleted = true;
          }
          break;

        case SessionLogType.TASK_CREATED:
          taskStates.set(String(record.taskId), {
            taskId: record.taskId,
            title: record.title,
            status: 'pending',
            iterations: 0,
            dependencies: record.dependencies ?? [],
          });
          break;

        case SessionLogType.WORKER_START: {
          const taskState = taskStates.get(String(record.taskId));
          if (taskState) {
            taskState.status = 'in_progress';
            taskState.iterations++;
          }
          break;
        }

        case SessionLogType.JUDGE_COMPLETE: {
          const taskState = taskStates.get(String(record.taskId));
          if (taskState) {
            taskState.lastVerdict = record.verdict;
            switch (record.verdict) {
              case 'done':
                taskState.status = 'done';
                break;
              case 'needs_continuation':
                taskState.status = 'needs_continuation';
                break;
              case 'blocked':
                taskState.status = 'blocked';
                break;
              default:
                taskState.status = 'pending';
            }
          }
          break;
        }

        case SessionLogType.ERROR:
          lastError = record.message;
          break;
      }
    }

    // タスク集計
    const tasks: TaskResumeState[] = Array.from(taskStates.values());
    const completedTaskCount = tasks.filter((t) => t.status === 'done').length;
    const pendingTaskCount = tasks.filter(
      (t) => t.status !== 'done' && t.status !== 'blocked',
    ).length;

    // 再開可否と推奨アクションを決定
    const canResume = !boundaries.end || boundaries.end.type === SessionLogType.SESSION_ABORT;
    let resumeAction: SessionResumeContext['resumeAction'] = 'none';

    if (canResume) {
      if (pendingTaskCount > 0) {
        if (lastPhase && !phaseCompleted) {
          resumeAction = 'continue_phase';
        } else {
          resumeAction = 'restart_phase';
        }
      } else if (completedTaskCount === 0) {
        resumeAction = 'restart_session';
      }
    }

    return createOk({
      sessionId: sessionIdTyped,
      originalTask,
      startedAt,
      lastPhase,
      phaseCompleted,
      tasks,
      completedTaskCount,
      pendingTaskCount,
      abortReason,
      lastError,
      canResume,
      resumeAction,
    });
  } catch (error) {
    return createErr(sessionResumeError(sid, error));
  }
}

/**
 * 再開コンテキストを人間が読みやすい形式にフォーマット
 */
export function formatResumeContext(context: SessionResumeContext): string {
  const lines: string[] = [];

  lines.push('='.repeat(60));
  lines.push('Session Resume Context');
  lines.push('='.repeat(60));
  lines.push('');
  lines.push(`Session ID: ${context.sessionId}`);
  lines.push(`Original Task: ${context.originalTask}`);
  lines.push(`Started At: ${context.startedAt}`);
  lines.push('');

  // フェーズ情報
  lines.push('--- Phase Status ---');
  if (context.lastPhase) {
    lines.push(`Last Phase: ${context.lastPhase}`);
    lines.push(`Phase Completed: ${context.phaseCompleted ? 'Yes' : 'No'}`);
  } else {
    lines.push('No phase started');
  }
  lines.push('');

  // タスク情報
  lines.push('--- Task Status ---');
  lines.push(`Completed: ${context.completedTaskCount}`);
  lines.push(`Pending: ${context.pendingTaskCount}`);
  lines.push('');

  if (context.tasks.length > 0) {
    lines.push('Tasks:');
    for (const task of context.tasks) {
      const statusIcon = getStatusIcon(task.status);
      lines.push(`  ${statusIcon} [${task.taskId}] ${task.title}`);
      lines.push(`     Status: ${task.status}, Iterations: ${task.iterations}`);
      if (task.lastVerdict) {
        lines.push(`     Last Verdict: ${task.lastVerdict}`);
      }
    }
    lines.push('');
  }

  // エラー情報
  if (context.abortReason) {
    lines.push('--- Abort Info ---');
    lines.push(`Reason: ${context.abortReason}`);
    lines.push('');
  }

  if (context.lastError) {
    lines.push('--- Last Error ---');
    lines.push(context.lastError);
    lines.push('');
  }

  // 推奨アクション
  lines.push('--- Resume Recommendation ---');
  lines.push(`Can Resume: ${context.canResume ? 'Yes' : 'No'}`);
  lines.push(`Recommended Action: ${formatResumeAction(context.resumeAction)}`);

  return lines.join('\n');
}

/**
 * ステータスアイコンを取得
 */
function getStatusIcon(
  status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'needs_continuation',
): string {
  switch (status) {
    case 'done':
      return '✅';
    case 'in_progress':
      return '🔄';
    case 'blocked':
      return '🚫';
    case 'needs_continuation':
      return '⏳';
    case 'pending':
    default:
      return '⏸️';
  }
}

/**
 * 推奨アクションをフォーマット
 */
function formatResumeAction(action: SessionResumeContext['resumeAction']): string {
  switch (action) {
    case 'continue_phase':
      return 'Continue from last phase (use `agent resume`)';
    case 'restart_phase':
      return 'Restart current phase (use `agent resume --restart-phase`)';
    case 'restart_session':
      return 'Start a new session (use `agent run`)';
    case 'none':
      return 'No action needed';
  }
}

/**
 * 未完了タスクを取得
 */
export function getPendingTasks(context: SessionResumeContext): TaskResumeState[] {
  return context.tasks.filter(
    (t) => t.status !== 'done' && t.status !== 'blocked',
  );
}

/**
 * 完了タスクを取得
 */
export function getCompletedTasks(context: SessionResumeContext): TaskResumeState[] {
  return context.tasks.filter((t) => t.status === 'done');
}

/**
 * 次に実行すべきタスクを決定
 *
 * 依存関係を考慮して、実行可能なタスクを返す
 */
export function getNextExecutableTasks(context: SessionResumeContext): TaskResumeState[] {
  const completedIds = new Set(
    context.tasks.filter((t) => t.status === 'done').map((t) => String(t.taskId)),
  );

  return context.tasks.filter((task) => {
    // 完了済み、ブロック済み以外
    if (task.status === 'done' || task.status === 'blocked') {
      return false;
    }

    // 依存タスクがすべて完了しているか確認
    const allDependenciesMet = task.dependencies.every((dep) =>
      completedIds.has(String(dep)),
    );

    return allDependenciesMet;
  });
}
