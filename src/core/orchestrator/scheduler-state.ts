/**
 * Scheduler State - 純粋関数による状態遷移
 *
 * Schedulerの状態を外部化し、イミュータブルな状態遷移を提供する。
 */

import type { WorkerId } from '../../types/branded.ts';

/**
 * Scheduler状態
 */
export interface SchedulerState {
  /** 実行中のWorker ID集合 */
  readonly runningWorkers: ReadonlySet<WorkerId>;
  /** 最大Worker並列数 */
  readonly maxWorkers: number;
}

/**
 * 初期Scheduler状態を生成
 */
export const initialSchedulerState = (maxWorkers = 3): SchedulerState => ({
  runningWorkers: new Set(),
  maxWorkers,
});

/**
 * 実行中Workerを追加（イミュータブル）
 */
export const addRunningWorker = (state: SchedulerState, wid: WorkerId): SchedulerState => ({
  ...state,
  runningWorkers: new Set([...state.runningWorkers, wid]),
});

/**
 * 実行中Workerを削除（イミュータブル）
 */
export const removeRunningWorker = (state: SchedulerState, wid: WorkerId): SchedulerState => {
  const newSet = new Set(state.runningWorkers);
  newSet.delete(wid);
  return {
    ...state,
    runningWorkers: newSet,
  };
};

/**
 * Worker容量に余裕があるか判定
 */
export const hasCapacity = (state: SchedulerState): boolean =>
  state.runningWorkers.size < state.maxWorkers;

/**
 * 空きWorkerスロット数を取得
 */
export const getAvailableSlots = (state: SchedulerState): number =>
  Math.max(0, state.maxWorkers - state.runningWorkers.size);

/**
 * 実行中Worker数を取得
 */
export const getRunningCount = (state: SchedulerState): number => state.runningWorkers.size;
