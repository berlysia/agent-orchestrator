/**
 * Progress Event Types and State Definitions
 *
 * ADR-012: CLI進捗表示機能
 *
 * イベント駆動型の進捗表示を実現するための型定義。
 * - ProgressEvent: オーケストレーション中に発火するイベント
 * - ProgressState: 現在の進捗状態
 */

import type { TaskId } from './branded.ts';

/**
 * 進捗イベント種別
 */
export const ProgressEventType = {
  /** オーケストレーション開始 */
  ORCHESTRATION_START: 'ORCHESTRATION_START',
  /** 計画フェーズ開始 */
  PLANNING_START: 'PLANNING_START',
  /** 計画フェーズ完了 */
  PLANNING_COMPLETE: 'PLANNING_COMPLETE',
  /** タスク実行開始 */
  TASK_START: 'TASK_START',
  /** タスク判定中 */
  TASK_JUDGING: 'TASK_JUDGING',
  /** タスク完了 */
  TASK_COMPLETE: 'TASK_COMPLETE',
  /** タスク失敗 */
  TASK_FAILED: 'TASK_FAILED',
  /** タスクブロック */
  TASK_BLOCKED: 'TASK_BLOCKED',
  /** タスク継続（retry/continuation） */
  TASK_CONTINUATION: 'TASK_CONTINUATION',
  /** 統合フェーズ開始 */
  INTEGRATION_START: 'INTEGRATION_START',
  /** 統合フェーズ完了 */
  INTEGRATION_COMPLETE: 'INTEGRATION_COMPLETE',
  /** オーケストレーション完了 */
  ORCHESTRATION_COMPLETE: 'ORCHESTRATION_COMPLETE',
} as const;

export type ProgressEventType = (typeof ProgressEventType)[keyof typeof ProgressEventType];

/**
 * 進捗イベント基底インターフェース
 */
export interface BaseProgressEvent {
  /** イベント種別 */
  type: ProgressEventType;
  /** 発生時刻 */
  timestamp: Date;
}

/**
 * オーケストレーション開始イベント
 */
export interface OrchestrationStartEvent extends BaseProgressEvent {
  type: typeof ProgressEventType.ORCHESTRATION_START;
  /** ユーザー指示 */
  instruction: string;
}

/**
 * 計画開始イベント
 */
export interface PlanningStartEvent extends BaseProgressEvent {
  type: typeof ProgressEventType.PLANNING_START;
}

/**
 * 計画完了イベント
 */
export interface PlanningCompleteEvent extends BaseProgressEvent {
  type: typeof ProgressEventType.PLANNING_COMPLETE;
  /** 生成されたタスク数 */
  taskCount: number;
  /** タスクIDリスト */
  taskIds: TaskId[];
}

/**
 * タスク開始イベント
 */
export interface TaskStartEvent extends BaseProgressEvent {
  type: typeof ProgressEventType.TASK_START;
  /** タスクID */
  taskId: TaskId;
  /** タスクサマリ */
  summary?: string;
  /** ブランチ名 */
  branch: string;
}

/**
 * タスク判定中イベント
 */
export interface TaskJudgingEvent extends BaseProgressEvent {
  type: typeof ProgressEventType.TASK_JUDGING;
  /** タスクID */
  taskId: TaskId;
}

/**
 * タスク完了イベント
 */
export interface TaskCompleteEvent extends BaseProgressEvent {
  type: typeof ProgressEventType.TASK_COMPLETE;
  /** タスクID */
  taskId: TaskId;
  /** 判定スコア */
  score?: number;
}

/**
 * タスク失敗イベント
 */
export interface TaskFailedEvent extends BaseProgressEvent {
  type: typeof ProgressEventType.TASK_FAILED;
  /** タスクID */
  taskId: TaskId;
  /** 失敗理由 */
  reason: string;
}

/**
 * タスクブロックイベント
 */
export interface TaskBlockedEvent extends BaseProgressEvent {
  type: typeof ProgressEventType.TASK_BLOCKED;
  /** タスクID */
  taskId: TaskId;
  /** ブロック理由 */
  reason: string;
}

/**
 * タスク継続イベント
 */
export interface TaskContinuationEvent extends BaseProgressEvent {
  type: typeof ProgressEventType.TASK_CONTINUATION;
  /** タスクID */
  taskId: TaskId;
  /** 現在の試行回数 */
  attempt: number;
  /** 最大試行回数 */
  maxAttempts: number;
}

/**
 * 統合開始イベント
 */
export interface IntegrationStartEvent extends BaseProgressEvent {
  type: typeof ProgressEventType.INTEGRATION_START;
  /** 統合するタスク数 */
  taskCount: number;
}

/**
 * 統合完了イベント
 */
export interface IntegrationCompleteEvent extends BaseProgressEvent {
  type: typeof ProgressEventType.INTEGRATION_COMPLETE;
  /** マージ成功数 */
  mergedCount: number;
  /** コンフリクト数 */
  conflictCount: number;
  /** 統合ブランチ名 */
  integrationBranch?: string;
}

/**
 * オーケストレーション完了イベント
 */
export interface OrchestrationCompleteEvent extends BaseProgressEvent {
  type: typeof ProgressEventType.ORCHESTRATION_COMPLETE;
  /** 成功可否 */
  success: boolean;
  /** 完了タスク数 */
  completedCount: number;
  /** 失敗タスク数 */
  failedCount: number;
  /** ブロックタスク数 */
  blockedCount: number;
}

/**
 * 進捗イベント共用体型
 */
export type ProgressEvent =
  | OrchestrationStartEvent
  | PlanningStartEvent
  | PlanningCompleteEvent
  | TaskStartEvent
  | TaskJudgingEvent
  | TaskCompleteEvent
  | TaskFailedEvent
  | TaskBlockedEvent
  | TaskContinuationEvent
  | IntegrationStartEvent
  | IntegrationCompleteEvent
  | OrchestrationCompleteEvent;

/**
 * 進捗状態
 */
export interface ProgressState {
  /** 総タスク数 */
  totalTasks: number;
  /** 完了タスク数 */
  completedCount: number;
  /** 失敗タスク数 */
  failedCount: number;
  /** ブロックタスク数 */
  blockedCount: number;
  /** 現在実行中のタスクID */
  runningTasks: TaskId[];
  /** 現在のフェーズ */
  phase: 'idle' | 'planning' | 'executing' | 'integrating' | 'complete';
  /** 開始時刻 */
  startedAt?: Date;
  /** ユーザー指示 */
  instruction?: string;
}

/**
 * 進捗イベントハンドラ型
 */
export type ProgressEventHandler = (event: ProgressEvent) => void;

/**
 * 進捗イベントファクトリー関数
 */
export function createProgressEvent<T extends ProgressEvent>(
  type: T['type'],
  details: Omit<T, 'type' | 'timestamp'>,
): T {
  return {
    type,
    timestamp: new Date(),
    ...details,
  } as T;
}

/**
 * 初期状態を生成
 */
export function initialProgressState(): ProgressState {
  return {
    totalTasks: 0,
    completedCount: 0,
    failedCount: 0,
    blockedCount: 0,
    runningTasks: [],
    phase: 'idle',
  };
}
