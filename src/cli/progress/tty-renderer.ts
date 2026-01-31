/**
 * TTY Renderer
 *
 * ADR-012: CLI進捗表示機能
 *
 * 進捗情報をターミナルに描画するレンダラー。
 * - TTYモード: 進捗バー、スピナー、リアルタイム更新
 * - 非TTYモード: 簡易ログ形式（CI/パイプ環境向け）
 */

import type { ProgressEmitter } from '../../adapters/progress/progress-emitter.ts';
import type { ProgressEvent } from '../../types/progress.ts';
import { ProgressEventType } from '../../types/progress.ts';
import {
  ANSI,
  isAnsiEnabled,
  colorize,
  dim,
  renderProgressBar,
  getSpinnerFrame,
  formatTime,
  formatElapsed,
  truncate,
  STATUS_ICONS,
} from './ansi-utils.ts';

/**
 * レンダラー設定
 */
export interface TTYRendererOptions {
  /** 出力ストリーム（デフォルト: process.stderr） */
  stream?: NodeJS.WriteStream;
  /** 進捗バーの幅（デフォルト: 20） */
  progressBarWidth?: number;
  /** スピナー更新間隔（ms）（デフォルト: 80） */
  spinnerInterval?: number;
  /** タスク名の最大表示幅（デフォルト: 40） */
  maxTaskNameWidth?: number;
}

/**
 * TTYレンダラーインターフェース
 */
export interface TTYRenderer {
  /** レンダリングを開始 */
  start(): void;
  /** レンダリングを停止 */
  stop(): void;
}

/**
 * TTYレンダラーを作成してProgressEmitterに接続
 *
 * @param emitter ProgressEmitter
 * @param options オプション
 * @returns TTYレンダラー
 */
export function createTTYRenderer(
  emitter: ProgressEmitter,
  options: TTYRendererOptions = {},
): TTYRenderer {
  const stream = options.stream ?? process.stderr;
  const progressBarWidth = options.progressBarWidth ?? 20;
  const spinnerIntervalMs = options.spinnerInterval ?? 80;
  const maxTaskNameWidth = options.maxTaskNameWidth ?? 40;
  const useAnsi = isAnsiEnabled(stream);

  let spinnerFrame = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let lastRenderedLines = 0;
  let isRendering = false;

  /**
   * ストリームに書き込み
   */
  const write = (text: string): void => {
    stream.write(text);
  };

  /**
   * ストリームに行を書き込み
   */
  const writeLine = (text: string): void => {
    stream.write(text + '\n');
  };

  /**
   * 進捗表示をクリア
   */
  const clearProgressDisplay = (): void => {
    if (lastRenderedLines > 0) {
      // カーソルを上に移動してクリア
      for (let i = 0; i < lastRenderedLines; i++) {
        write(ANSI.CURSOR_UP(1) + ANSI.CLEAR_LINE);
      }
      lastRenderedLines = 0;
    }
  };

  /**
   * 進捗表示を描画（TTYモード）
   */
  const renderProgress = (): void => {
    if (!useAnsi || isRendering) {
      return;
    }

    isRendering = true;

    try {
      const state = emitter.getState();

      if (state.phase === 'idle' || state.phase === 'complete') {
        clearProgressDisplay();
        return;
      }

      // 前回の表示をクリア
      clearProgressDisplay();

      // 進捗バー行
      const lines: string[] = [];

      if (state.phase === 'executing' && state.totalTasks > 0) {
        const completed = state.completedCount + state.failedCount + state.blockedCount;
        const progress = completed / state.totalTasks;
        const percentage = Math.round(progress * 100);

        const spinner = getSpinnerFrame(spinnerFrame);
        const progressBar = renderProgressBar(progress, progressBarWidth, true);

        lines.push(
          `${spinner} Executing [${completed}/${state.totalTasks}] ${progressBar} ${percentage}%`,
        );

        // 実行中タスクの表示
        if (state.runningTasks.length > 0) {
          const taskNames = state.runningTasks
            .slice(0, 3) // 最大3つまで表示
            .map((id) => truncate(String(id), maxTaskNameWidth))
            .join(', ');
          const suffix =
            state.runningTasks.length > 3
              ? ` (+${state.runningTasks.length - 3} more)`
              : '';
          lines.push(dim(`  Running: ${taskNames}${suffix}`, true));
        }
      } else if (state.phase === 'planning') {
        const spinner = getSpinnerFrame(spinnerFrame);
        lines.push(`${spinner} Planning tasks...`);
      } else if (state.phase === 'integrating') {
        const spinner = getSpinnerFrame(spinnerFrame);
        lines.push(`${spinner} Integrating tasks...`);
      }

      // 経過時間
      if (state.startedAt) {
        lines.push(dim(`  Elapsed: ${formatElapsed(state.startedAt)}`, true));
      }

      // 描画
      for (const line of lines) {
        write(line + '\n');
      }

      lastRenderedLines = lines.length;
    } finally {
      isRendering = false;
    }
  };

  /**
   * ログ行を出力（進捗表示を一時的にクリアしてからログを出力し、再描画）
   */
  const logLine = (text: string): void => {
    if (useAnsi) {
      clearProgressDisplay();
      writeLine(text);
      // 次のrenderProgress()で再描画される
    } else {
      writeLine(text);
    }
  };

  /**
   * スピナータイマーを開始
   */
  const startSpinner = (): void => {
    if (spinnerTimer) {
      return;
    }

    spinnerTimer = setInterval(() => {
      spinnerFrame++;
      const state = emitter.getState();
      if (state.phase !== 'idle' && state.phase !== 'complete') {
        renderProgress();
      }
    }, spinnerIntervalMs);
  };

  /**
   * スピナータイマーを停止
   */
  const stopSpinner = (): void => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  };

  /**
   * TTYモードでイベントを処理
   */
  const handleEventTTY = (event: ProgressEvent): void => {
    switch (event.type) {
      case ProgressEventType.ORCHESTRATION_START:
        logLine(`${STATUS_ICONS.RUNNING} Starting orchestration...`);
        break;

      case ProgressEventType.PLANNING_COMPLETE:
        logLine(`${STATUS_ICONS.SUCCESS} Generated ${event.taskCount} tasks`);
        break;

      case ProgressEventType.TASK_COMPLETE:
        // 進捗表示が更新されるので特別なログは不要
        break;

      case ProgressEventType.TASK_FAILED:
        logLine(
          colorize(
            `${STATUS_ICONS.FAILURE} Task failed: ${event.taskId}`,
            ANSI.RED,
            true,
          ),
        );
        break;

      case ProgressEventType.TASK_BLOCKED:
        logLine(
          colorize(
            `${STATUS_ICONS.BLOCKED} Task blocked: ${event.taskId}`,
            ANSI.YELLOW,
            true,
          ),
        );
        break;

      case ProgressEventType.INTEGRATION_START:
        logLine(`${STATUS_ICONS.RUNNING} Integrating ${event.taskCount} tasks...`);
        break;

      case ProgressEventType.INTEGRATION_COMPLETE:
        if (event.conflictCount > 0) {
          logLine(
            colorize(
              `${STATUS_ICONS.WARNING} Merged ${event.mergedCount} tasks (${event.conflictCount} conflicts)`,
              ANSI.YELLOW,
              true,
            ),
          );
        } else {
          logLine(`${STATUS_ICONS.SUCCESS} Merged ${event.mergedCount} tasks`);
        }
        break;

      case ProgressEventType.ORCHESTRATION_COMPLETE:
        if (event.success) {
          logLine(
            colorize(
              `${STATUS_ICONS.SUCCESS} Orchestration completed successfully`,
              ANSI.GREEN,
              true,
            ),
          );
        } else {
          logLine(
            colorize(
              `${STATUS_ICONS.WARNING} Orchestration finished with errors`,
              ANSI.YELLOW,
              true,
            ),
          );
        }
        logLine(
          dim(
            `  Completed: ${event.completedCount}, Failed: ${event.failedCount}, Blocked: ${event.blockedCount}`,
            true,
          ),
        );
        break;
    }

    // 進捗表示を更新
    renderProgress();
  };

  /**
   * 非TTYモードでイベントを処理（簡易ログ形式）
   */
  const handleEventNonTTY = (event: ProgressEvent): void => {
    const timestamp = formatTime(event.timestamp);

    switch (event.type) {
      case ProgressEventType.ORCHESTRATION_START:
        writeLine(`[${timestamp}] Starting orchestration`);
        break;

      case ProgressEventType.PLANNING_START:
        writeLine(`[${timestamp}] Planning tasks...`);
        break;

      case ProgressEventType.PLANNING_COMPLETE:
        writeLine(`[${timestamp}] Generated ${event.taskCount} tasks`);
        break;

      case ProgressEventType.TASK_START:
        writeLine(
          `[${timestamp}] Starting task ${event.taskId}: ${event.summary || event.branch}`,
        );
        break;

      case ProgressEventType.TASK_COMPLETE:
        writeLine(`[${timestamp}] Completed task ${event.taskId}`);
        break;

      case ProgressEventType.TASK_FAILED:
        writeLine(`[${timestamp}] Failed task ${event.taskId}: ${event.reason}`);
        break;

      case ProgressEventType.TASK_BLOCKED:
        writeLine(`[${timestamp}] Blocked task ${event.taskId}: ${event.reason}`);
        break;

      case ProgressEventType.TASK_CONTINUATION:
        writeLine(
          `[${timestamp}] Retrying task ${event.taskId} (attempt ${event.attempt}/${event.maxAttempts})`,
        );
        break;

      case ProgressEventType.INTEGRATION_START:
        writeLine(`[${timestamp}] Integrating ${event.taskCount} tasks...`);
        break;

      case ProgressEventType.INTEGRATION_COMPLETE:
        writeLine(
          `[${timestamp}] Integration complete: ${event.mergedCount} merged, ${event.conflictCount} conflicts`,
        );
        break;

      case ProgressEventType.ORCHESTRATION_COMPLETE: {
        const status = event.success ? 'SUCCESS' : 'FINISHED WITH ERRORS';
        writeLine(
          `[${timestamp}] Orchestration ${status}: ${event.completedCount} completed, ${event.failedCount} failed, ${event.blockedCount} blocked`,
        );
        break;
      }
    }
  };

  /**
   * イベントを処理
   */
  const handleEvent = (event: ProgressEvent): void => {
    if (useAnsi) {
      handleEventTTY(event);
    } else {
      handleEventNonTTY(event);
    }
  };

  return {
    start(): void {
      if (unsubscribe) {
        return; // 既に開始済み
      }

      // イベント購読
      unsubscribe = emitter.subscribe((event) => {
        handleEvent(event);
      });

      // TTYモードの場合、スピナー更新タイマーを開始
      if (useAnsi) {
        startSpinner();
        // カーソルを非表示
        write(ANSI.HIDE_CURSOR);
      }
    },

    stop(): void {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }

      stopSpinner();

      if (useAnsi) {
        // 進捗表示をクリアして改行
        clearProgressDisplay();
        // カーソルを表示
        write(ANSI.SHOW_CURSOR);
      }
    },
  };
}
