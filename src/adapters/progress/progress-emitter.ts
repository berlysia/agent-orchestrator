/**
 * ProgressEmitter Interface
 *
 * ADR-012: CLI進捗表示機能
 *
 * 進捗イベントを発火・購読するためのインターフェース定義。
 *
 * WHY: 既存の *Effects パターン（RunnerEffects等）は非同期I/O抽象化だが、
 * ProgressEmitter は同期的なイベント通知機構。目的が異なるため別概念として設計。
 */

import type {
  ProgressEvent,
  ProgressState,
  ProgressEventHandler,
} from '../../types/progress.ts';

/**
 * ProgressEmitter インターフェース
 *
 * イベント発火・状態管理・購読機能を提供
 */
export interface ProgressEmitter {
  /**
   * 進捗イベントを発火
   *
   * @param event 発火するイベント
   */
  emit(event: ProgressEvent): void;

  /**
   * 現在の進捗状態を取得
   *
   * @returns 現在の進捗状態
   */
  getState(): ProgressState;

  /**
   * イベントハンドラを購読
   *
   * @param handler イベントハンドラ
   * @returns 購読解除関数
   */
  subscribe(handler: ProgressEventHandler): () => void;

  /**
   * 状態をリセット
   */
  reset(): void;
}
