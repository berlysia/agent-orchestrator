/**
 * Session Log Record Types (ADR-027)
 *
 * NDJSONセッションログのレコード型定義。
 * 各イベントは独立した行としてJSONL形式で記録される。
 */

import { z } from 'zod';
import type { SessionId, TaskId, WorkerId } from './branded.ts';
import { sessionId, taskId, workerId } from './branded.ts';

/**
 * セッションログのフェーズ
 */
export const SessionPhase = {
  PLANNING: 'planning',
  EXECUTION: 'execution',
  INTEGRATION: 'integration',
} as const;

export type SessionPhase = (typeof SessionPhase)[keyof typeof SessionPhase];

/**
 * Worker完了ステータス
 */
export const WorkerStatus = {
  SUCCESS: 'success',
  PARTIAL: 'partial',
  FAILED: 'failed',
} as const;

export type WorkerStatus = (typeof WorkerStatus)[keyof typeof WorkerStatus];

/**
 * Judge判定結果
 */
export const JudgeVerdict = {
  DONE: 'done',
  NEEDS_CONTINUATION: 'needs_continuation',
  BLOCKED: 'blocked',
  SKIPPED: 'skipped',
} as const;

export type JudgeVerdict = (typeof JudgeVerdict)[keyof typeof JudgeVerdict];

/**
 * セッションログレコードタイプ
 */
export const SessionLogType = {
  SESSION_START: 'session_start',
  SESSION_COMPLETE: 'session_complete',
  SESSION_ABORT: 'session_abort',
  PHASE_START: 'phase_start',
  PHASE_COMPLETE: 'phase_complete',
  TASK_CREATED: 'task_created',
  TASK_UPDATED: 'task_updated',
  WORKER_START: 'worker_start',
  WORKER_COMPLETE: 'worker_complete',
  JUDGE_START: 'judge_start',
  JUDGE_COMPLETE: 'judge_complete',
  LEADER_DECISION: 'leader_decision',
  ERROR: 'error',
} as const;

export type SessionLogType =
  (typeof SessionLogType)[keyof typeof SessionLogType];

/**
 * 基本レコードスキーマ（共通フィールド）
 */
const BaseRecordSchema = z.object({
  timestamp: z.string().datetime(),
});

/**
 * セッション開始レコード
 */
export const SessionStartRecordSchema = BaseRecordSchema.extend({
  type: z.literal(SessionLogType.SESSION_START),
  sessionId: z.string().transform(sessionId),
  task: z.string(),
  parentSessionId: z.string().transform(sessionId).optional(),
  rootSessionId: z.string().transform(sessionId).optional(),
});

export type SessionStartRecord = z.infer<typeof SessionStartRecordSchema>;

/**
 * セッション完了レコード
 */
export const SessionCompleteRecordSchema = BaseRecordSchema.extend({
  type: z.literal(SessionLogType.SESSION_COMPLETE),
  sessionId: z.string().transform(sessionId),
  summary: z.string(),
  tasksCompleted: z.number().int().nonnegative().optional(),
  duration: z.number().nonnegative().optional(),
});

export type SessionCompleteRecord = z.infer<typeof SessionCompleteRecordSchema>;

/**
 * セッション中断レコード
 */
export const SessionAbortRecordSchema = BaseRecordSchema.extend({
  type: z.literal(SessionLogType.SESSION_ABORT),
  sessionId: z.string().transform(sessionId),
  reason: z.string(),
  errorType: z.string().optional(),
});

export type SessionAbortRecord = z.infer<typeof SessionAbortRecordSchema>;

/**
 * フェーズ開始レコード
 */
export const PhaseStartRecordSchema = BaseRecordSchema.extend({
  type: z.literal(SessionLogType.PHASE_START),
  phase: z.enum([
    SessionPhase.PLANNING,
    SessionPhase.EXECUTION,
    SessionPhase.INTEGRATION,
  ]),
  sessionId: z.string().transform(sessionId).optional(),
});

export type PhaseStartRecord = z.infer<typeof PhaseStartRecordSchema>;

/**
 * フェーズ完了レコード
 */
export const PhaseCompleteRecordSchema = BaseRecordSchema.extend({
  type: z.literal(SessionLogType.PHASE_COMPLETE),
  phase: z.enum([
    SessionPhase.PLANNING,
    SessionPhase.EXECUTION,
    SessionPhase.INTEGRATION,
  ]),
  sessionId: z.string().transform(sessionId).optional(),
  duration: z.number().nonnegative().optional(),
});

export type PhaseCompleteRecord = z.infer<typeof PhaseCompleteRecordSchema>;

/**
 * タスク作成レコード
 */
export const TaskCreatedRecordSchema = BaseRecordSchema.extend({
  type: z.literal(SessionLogType.TASK_CREATED),
  taskId: z.string().transform(taskId),
  title: z.string(),
  taskType: z
    .enum(['implementation', 'documentation', 'investigation', 'integration'])
    .optional(),
  dependencies: z.array(z.string().transform(taskId)).optional(),
});

export type TaskCreatedRecord = z.infer<typeof TaskCreatedRecordSchema>;

/**
 * タスク更新レコード
 */
export const TaskUpdatedRecordSchema = BaseRecordSchema.extend({
  type: z.literal(SessionLogType.TASK_UPDATED),
  taskId: z.string().transform(taskId),
  previousState: z.string().optional(),
  newState: z.string(),
  reason: z.string().optional(),
});

export type TaskUpdatedRecord = z.infer<typeof TaskUpdatedRecordSchema>;

/**
 * Worker開始レコード
 */
export const WorkerStartRecordSchema = BaseRecordSchema.extend({
  type: z.literal(SessionLogType.WORKER_START),
  taskId: z.string().transform(taskId),
  workerId: z.string().transform(workerId),
  iteration: z.number().int().nonnegative().optional(),
});

export type WorkerStartRecord = z.infer<typeof WorkerStartRecordSchema>;

/**
 * Worker完了レコード
 */
export const WorkerCompleteRecordSchema = BaseRecordSchema.extend({
  type: z.literal(SessionLogType.WORKER_COMPLETE),
  taskId: z.string().transform(taskId),
  workerId: z.string().transform(workerId),
  status: z.enum([WorkerStatus.SUCCESS, WorkerStatus.PARTIAL, WorkerStatus.FAILED]),
  duration: z.number().nonnegative().optional(),
  changesCount: z.number().int().nonnegative().optional(),
});

export type WorkerCompleteRecord = z.infer<typeof WorkerCompleteRecordSchema>;

/**
 * Judge開始レコード
 */
export const JudgeStartRecordSchema = BaseRecordSchema.extend({
  type: z.literal(SessionLogType.JUDGE_START),
  taskId: z.string().transform(taskId),
  iteration: z.number().int().nonnegative().optional(),
});

export type JudgeStartRecord = z.infer<typeof JudgeStartRecordSchema>;

/**
 * Judge完了レコード
 */
export const JudgeCompleteRecordSchema = BaseRecordSchema.extend({
  type: z.literal(SessionLogType.JUDGE_COMPLETE),
  taskId: z.string().transform(taskId),
  verdict: z.enum([
    JudgeVerdict.DONE,
    JudgeVerdict.NEEDS_CONTINUATION,
    JudgeVerdict.BLOCKED,
    JudgeVerdict.SKIPPED,
  ]),
  reason: z.string().optional(),
  duration: z.number().nonnegative().optional(),
});

export type JudgeCompleteRecord = z.infer<typeof JudgeCompleteRecordSchema>;

/**
 * Leader判断レコード（ADR-024関連）
 */
export const LeaderDecisionRecordSchema = BaseRecordSchema.extend({
  type: z.literal(SessionLogType.LEADER_DECISION),
  taskId: z.string().transform(taskId).optional(),
  decision: z.string(),
  rationale: z.string(),
  action: z.string().optional(),
});

export type LeaderDecisionRecord = z.infer<typeof LeaderDecisionRecordSchema>;

/**
 * エラーレコード
 */
export const ErrorRecordSchema = BaseRecordSchema.extend({
  type: z.literal(SessionLogType.ERROR),
  message: z.string(),
  errorType: z.string().optional(),
  taskId: z.string().transform(taskId).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  stack: z.string().optional(),
});

export type ErrorRecord = z.infer<typeof ErrorRecordSchema>;

/**
 * セッションログレコード（全タイプの統合）
 */
export const SessionLogRecordSchema = z.discriminatedUnion('type', [
  SessionStartRecordSchema,
  SessionCompleteRecordSchema,
  SessionAbortRecordSchema,
  PhaseStartRecordSchema,
  PhaseCompleteRecordSchema,
  TaskCreatedRecordSchema,
  TaskUpdatedRecordSchema,
  WorkerStartRecordSchema,
  WorkerCompleteRecordSchema,
  JudgeStartRecordSchema,
  JudgeCompleteRecordSchema,
  LeaderDecisionRecordSchema,
  ErrorRecordSchema,
]);

export type SessionLogRecord = z.infer<typeof SessionLogRecordSchema>;

/**
 * セッションポインタファイルの形式
 */
export const SessionPointerSchema = z.object({
  sessionId: z.string(),
  startedAt: z.string().datetime(),
  status: z.enum(['running', 'completed', 'aborted']),
});

export type SessionPointer = z.infer<typeof SessionPointerSchema>;

/**
 * セッションログレコード作成ヘルパー
 */
export function createSessionStartRecord(
  sid: SessionId,
  task: string,
  options?: {
    parentSessionId?: SessionId;
    rootSessionId?: SessionId;
  },
): SessionStartRecord {
  return {
    type: SessionLogType.SESSION_START,
    sessionId: sid,
    task,
    timestamp: new Date().toISOString(),
    parentSessionId: options?.parentSessionId,
    rootSessionId: options?.rootSessionId,
  };
}

export function createSessionCompleteRecord(
  sid: SessionId,
  summary: string,
  options?: {
    tasksCompleted?: number;
    duration?: number;
  },
): SessionCompleteRecord {
  return {
    type: SessionLogType.SESSION_COMPLETE,
    sessionId: sid,
    summary,
    timestamp: new Date().toISOString(),
    tasksCompleted: options?.tasksCompleted,
    duration: options?.duration,
  };
}

export function createSessionAbortRecord(
  sid: SessionId,
  reason: string,
  errorType?: string,
): SessionAbortRecord {
  return {
    type: SessionLogType.SESSION_ABORT,
    sessionId: sid,
    reason,
    timestamp: new Date().toISOString(),
    errorType,
  };
}

export function createPhaseStartRecord(
  phase: SessionPhase,
  sid?: SessionId,
): PhaseStartRecord {
  return {
    type: SessionLogType.PHASE_START,
    phase,
    timestamp: new Date().toISOString(),
    sessionId: sid,
  };
}

export function createPhaseCompleteRecord(
  phase: SessionPhase,
  options?: {
    sessionId?: SessionId;
    duration?: number;
  },
): PhaseCompleteRecord {
  return {
    type: SessionLogType.PHASE_COMPLETE,
    phase,
    timestamp: new Date().toISOString(),
    sessionId: options?.sessionId,
    duration: options?.duration,
  };
}

export function createTaskCreatedRecord(
  tid: TaskId,
  title: string,
  options?: {
    taskType?: 'implementation' | 'documentation' | 'investigation' | 'integration';
    dependencies?: TaskId[];
  },
): TaskCreatedRecord {
  return {
    type: SessionLogType.TASK_CREATED,
    taskId: tid,
    title,
    timestamp: new Date().toISOString(),
    taskType: options?.taskType,
    dependencies: options?.dependencies,
  };
}

export function createTaskUpdatedRecord(
  tid: TaskId,
  newState: string,
  options?: {
    previousState?: string;
    reason?: string;
  },
): TaskUpdatedRecord {
  return {
    type: SessionLogType.TASK_UPDATED,
    taskId: tid,
    newState,
    timestamp: new Date().toISOString(),
    previousState: options?.previousState,
    reason: options?.reason,
  };
}

export function createWorkerStartRecord(
  tid: TaskId,
  wid: WorkerId,
  iteration?: number,
): WorkerStartRecord {
  return {
    type: SessionLogType.WORKER_START,
    taskId: tid,
    workerId: wid,
    timestamp: new Date().toISOString(),
    iteration,
  };
}

export function createWorkerCompleteRecord(
  tid: TaskId,
  wid: WorkerId,
  status: WorkerStatus,
  options?: {
    duration?: number;
    changesCount?: number;
  },
): WorkerCompleteRecord {
  return {
    type: SessionLogType.WORKER_COMPLETE,
    taskId: tid,
    workerId: wid,
    status,
    timestamp: new Date().toISOString(),
    duration: options?.duration,
    changesCount: options?.changesCount,
  };
}

export function createJudgeStartRecord(
  tid: TaskId,
  iteration?: number,
): JudgeStartRecord {
  return {
    type: SessionLogType.JUDGE_START,
    taskId: tid,
    timestamp: new Date().toISOString(),
    iteration,
  };
}

export function createJudgeCompleteRecord(
  tid: TaskId,
  verdict: JudgeVerdict,
  options?: {
    reason?: string;
    duration?: number;
  },
): JudgeCompleteRecord {
  return {
    type: SessionLogType.JUDGE_COMPLETE,
    taskId: tid,
    verdict,
    timestamp: new Date().toISOString(),
    reason: options?.reason,
    duration: options?.duration,
  };
}

export function createLeaderDecisionRecord(
  decision: string,
  rationale: string,
  options?: {
    taskId?: TaskId;
    action?: string;
  },
): LeaderDecisionRecord {
  return {
    type: SessionLogType.LEADER_DECISION,
    decision,
    rationale,
    timestamp: new Date().toISOString(),
    taskId: options?.taskId,
    action: options?.action,
  };
}

export function createErrorRecord(
  message: string,
  options?: {
    errorType?: string;
    taskId?: TaskId;
    context?: Record<string, unknown>;
    stack?: string;
  },
): ErrorRecord {
  return {
    type: SessionLogType.ERROR,
    message,
    timestamp: new Date().toISOString(),
    errorType: options?.errorType,
    taskId: options?.taskId,
    context: options?.context,
    stack: options?.stack,
  };
}
