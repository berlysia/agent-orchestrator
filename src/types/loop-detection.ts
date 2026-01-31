/**
 * Loop Detection Types - ループ検出のための型定義
 *
 * ADR-033: ループ検出と無限ループ防止
 */

import { z } from 'zod';

/**
 * 状態遷移
 */
export interface StateTransition {
  /** 遷移元ステップ名 */
  from: string;
  /** 遷移先ステップ名 */
  to: string;
  /** 遷移理由 */
  reason: string;
  /** 遷移時刻 */
  timestamp: string;
}

/**
 * ループ検出結果の種類
 */
export const LoopDetectionResultType = {
  OK: 'ok',
  STEP_ITERATION_EXCEEDED: 'step_iteration_exceeded',
  SIMILAR_RESPONSE: 'similar_response',
  TRANSITION_PATTERN: 'transition_pattern',
} as const;

export type LoopDetectionResultType =
  (typeof LoopDetectionResultType)[keyof typeof LoopDetectionResultType];

/**
 * ループ検出結果
 */
export type LoopDetectionResult =
  | { type: 'ok' }
  | {
      type: 'step_iteration_exceeded';
      stepName: string;
      count: number;
      max: number;
    }
  | {
      type: 'similar_response';
      stepName: string;
      similarity: number;
      threshold: number;
    }
  | {
      type: 'transition_pattern';
      pattern: StateTransition[];
      occurrences: number;
    };

/**
 * ループ検出時のアクションタイプ
 */
export const LoopActionType = {
  ABORT: 'abort',
  ESCALATE: 'escalate',
  FORCE_CONTINUE: 'force_continue',
  RETRY_WITH_HINT: 'retry_with_hint',
} as const;

export type LoopActionType = (typeof LoopActionType)[keyof typeof LoopActionType];

/**
 * ループ検出時のアクション
 */
export type LoopAction =
  | { type: 'abort'; reason: string }
  | { type: 'escalate'; target: 'user' | 'planner' | 'leader' }
  | { type: 'force_continue'; warning: string }
  | { type: 'retry_with_hint'; hint: string };

/**
 * ステップイテレーショントラッカー
 */
export interface StepIterationTracker {
  stepName: string;
  count: number;
  maxAllowed: number;
  lastExecutedAt: string;
}

/**
 * 応答履歴エントリ
 */
export interface ResponseHistoryEntry {
  stepName: string;
  response: string;
  timestamp: string;
}

/**
 * ループ検出設定スキーマ
 */
export const LoopDetectionConfigSchema = z
  .object({
    /** ループ検出を有効化 */
    enabled: z.boolean().default(true),

    /** ステップごとの最大イテレーション設定 */
    maxStepIterations: z
      .object({
        default: z.number().int().min(1).default(5),
        worker: z.number().int().min(1).default(3),
        judge: z.number().int().min(1).default(3),
        replan: z.number().int().min(1).default(2),
      })
      .default({
        default: 5,
        worker: 3,
        judge: 3,
        replan: 2,
      }),

    /** 類似度検出設定 */
    similarityDetection: z
      .object({
        enabled: z.boolean().default(true),
        /** 類似度閾値（0-1、この値以上で類似と判定） */
        threshold: z.number().min(0).max(1).default(0.8),
        /** 比較ウィンドウサイズ（直近N回の応答と比較） */
        windowSize: z.number().int().min(1).default(3),
      })
      .default({
        enabled: true,
        threshold: 0.8,
        windowSize: 3,
      }),

    /** 状態遷移パターン検出設定 */
    transitionPatternDetection: z
      .object({
        enabled: z.boolean().default(true),
        /** パターンとして検出する最小出現回数 */
        minOccurrences: z.number().int().min(2).default(2),
      })
      .default({
        enabled: true,
        minOccurrences: 2,
      }),

    /** ループ検出時のデフォルトアクション */
    onLoop: z
      .object({
        default: z.enum(['abort', 'escalate', 'force_continue', 'retry_with_hint']).default('escalate'),
      })
      .default({
        default: 'escalate',
      }),
  })
  .default({
    enabled: true,
    maxStepIterations: {
      default: 5,
      worker: 3,
      judge: 3,
      replan: 2,
    },
    similarityDetection: {
      enabled: true,
      threshold: 0.8,
      windowSize: 3,
    },
    transitionPatternDetection: {
      enabled: true,
      minOccurrences: 2,
    },
    onLoop: {
      default: 'escalate',
    },
  });

export type LoopDetectionConfig = z.infer<typeof LoopDetectionConfigSchema>;

/**
 * デフォルトループ検出設定
 */
export const DEFAULT_LOOP_DETECTION_CONFIG: LoopDetectionConfig = {
  enabled: true,
  maxStepIterations: {
    default: 5,
    worker: 3,
    judge: 3,
    replan: 2,
  },
  similarityDetection: {
    enabled: true,
    threshold: 0.8,
    windowSize: 3,
  },
  transitionPatternDetection: {
    enabled: true,
    minOccurrences: 2,
  },
  onLoop: {
    default: 'escalate',
  },
};
