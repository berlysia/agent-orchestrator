/**
 * ProgressEmitter Implementation
 *
 * ADR-012: CLI進捗表示機能
 *
 * イベント発火・状態管理・購読機能の実装。
 * - スロットリング: 100msで高頻度イベントを間引く
 * - 状態管理: イベントに応じて内部状態を更新
 */

import type { ProgressEmitter } from './progress-emitter.ts';
import type {
  ProgressEvent,
  ProgressState,
  ProgressEventHandler,
} from '../../types/progress.ts';
import {
  ProgressEventType,
  initialProgressState,
} from '../../types/progress.ts';
import type { TaskId } from '../../types/branded.ts';

/**
 * スロットリング設定
 */
const THROTTLE_MS = 100;

/**
 * ProgressEmitter ファクトリー関数
 *
 * @returns ProgressEmitter インスタンス
 */
export function createProgressEmitter(): ProgressEmitter {
  let state: ProgressState = initialProgressState();
  const handlers: Set<ProgressEventHandler> = new Set();
  let lastEmitTime = 0;
  let pendingEvent: ProgressEvent | null = null;
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * イベントに応じて状態を更新
   */
  const updateState = (event: ProgressEvent): void => {
    switch (event.type) {
      case ProgressEventType.ORCHESTRATION_START:
        state = {
          ...initialProgressState(),
          phase: 'planning',
          startedAt: event.timestamp,
          instruction: event.instruction,
        };
        break;

      case ProgressEventType.PLANNING_START:
        state = { ...state, phase: 'planning' };
        break;

      case ProgressEventType.PLANNING_COMPLETE:
        state = {
          ...state,
          phase: 'executing',
          totalTasks: event.taskCount,
        };
        break;

      case ProgressEventType.TASK_START:
        state = {
          ...state,
          runningTasks: [...state.runningTasks, event.taskId],
        };
        break;

      case ProgressEventType.TASK_JUDGING:
        // 判定中は特に状態変更なし（UIでは「判定中」を表示する用途）
        break;

      case ProgressEventType.TASK_COMPLETE:
        state = {
          ...state,
          completedCount: state.completedCount + 1,
          runningTasks: removeTaskId(state.runningTasks, event.taskId),
        };
        break;

      case ProgressEventType.TASK_FAILED:
        state = {
          ...state,
          failedCount: state.failedCount + 1,
          runningTasks: removeTaskId(state.runningTasks, event.taskId),
        };
        break;

      case ProgressEventType.TASK_BLOCKED:
        state = {
          ...state,
          blockedCount: state.blockedCount + 1,
          runningTasks: removeTaskId(state.runningTasks, event.taskId),
        };
        break;

      case ProgressEventType.TASK_CONTINUATION:
        // 継続中は特に状態変更なし
        break;

      case ProgressEventType.INTEGRATION_START:
        state = { ...state, phase: 'integrating' };
        break;

      case ProgressEventType.INTEGRATION_COMPLETE:
        // 統合完了は特に状態変更なし（phase は ORCHESTRATION_COMPLETE で変更）
        break;

      case ProgressEventType.ORCHESTRATION_COMPLETE:
        state = { ...state, phase: 'complete' };
        break;
    }
  };

  /**
   * ハンドラにイベントを配信
   */
  const dispatchToHandlers = (event: ProgressEvent): void => {
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (err) {
        // ハンドラのエラーは握りつぶす（進捗表示のエラーでオーケストレーションを止めない）
        console.error('[ProgressEmitter] Handler error:', err);
      }
    }
  };

  /**
   * スロットリング付きでイベントを発火
   */
  const throttledEmit = (event: ProgressEvent): void => {
    const now = Date.now();
    const elapsed = now - lastEmitTime;

    if (elapsed >= THROTTLE_MS) {
      // スロットル時間経過: 即座に発火
      lastEmitTime = now;
      dispatchToHandlers(event);
    } else {
      // スロットル時間未経過: 保留して後で発火
      pendingEvent = event;

      if (!throttleTimer) {
        throttleTimer = setTimeout(() => {
          if (pendingEvent) {
            lastEmitTime = Date.now();
            dispatchToHandlers(pendingEvent);
            pendingEvent = null;
          }
          throttleTimer = null;
        }, THROTTLE_MS - elapsed);
      }
    }
  };

  return {
    emit(event: ProgressEvent): void {
      // 状態更新は常に即座に行う
      updateState(event);

      // イベント配信はスロットリング
      // ただし、重要なイベントは即座に配信
      const isImportantEvent =
        event.type === ProgressEventType.ORCHESTRATION_START ||
        event.type === ProgressEventType.ORCHESTRATION_COMPLETE ||
        event.type === ProgressEventType.TASK_COMPLETE ||
        event.type === ProgressEventType.TASK_FAILED ||
        event.type === ProgressEventType.TASK_BLOCKED;

      if (isImportantEvent) {
        // 保留中のイベントをクリア
        if (throttleTimer) {
          clearTimeout(throttleTimer);
          throttleTimer = null;
        }
        pendingEvent = null;
        lastEmitTime = Date.now();
        dispatchToHandlers(event);
      } else {
        throttledEmit(event);
      }
    },

    getState(): ProgressState {
      return { ...state };
    },

    subscribe(handler: ProgressEventHandler): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    reset(): void {
      state = initialProgressState();
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      pendingEvent = null;
      lastEmitTime = 0;
    },
  };
}

/**
 * TaskIdを配列から削除するヘルパー
 */
function removeTaskId(taskIds: TaskId[], targetId: TaskId): TaskId[] {
  return taskIds.filter((id) => String(id) !== String(targetId));
}
