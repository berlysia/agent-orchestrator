/**
 * Loop Detector - ワークフローのループ検出
 *
 * ADR-033: ループ検出と無限ループ防止
 *
 * 検出パターン:
 * 1. 同一ステップ反復検出
 * 2. 応答類似度検出
 * 3. 状態遷移パターン検出
 */

import type {
  LoopDetectionConfig,
  LoopDetectionResult,
  LoopAction,
  StateTransition,
  StepIterationTracker,
  ResponseHistoryEntry,
} from '../../types/loop-detection.ts';
import { DEFAULT_LOOP_DETECTION_CONFIG } from '../../types/loop-detection.ts';

/**
 * LoopDetector インターフェース
 */
export interface LoopDetector {
  /**
   * ステップ実行を記録し、ループをチェック
   */
  recordStepExecution(stepName: string): LoopDetectionResult;

  /**
   * 応答を記録し、類似度をチェック
   */
  recordResponse(stepName: string, response: string): LoopDetectionResult;

  /**
   * 状態遷移を記録し、パターンをチェック
   */
  recordTransition(transition: StateTransition): LoopDetectionResult;

  /**
   * ループ検出結果に対するアクションを決定
   */
  determineAction(result: LoopDetectionResult): LoopAction;

  /**
   * 特定ステップのイテレーションカウントを取得
   */
  getStepIterationCount(stepName: string): number;

  /**
   * すべての状態をリセット
   */
  reset(): void;

  /**
   * 現在の状態を取得（デバッグ用）
   */
  getState(): LoopDetectorState;
}

/**
 * LoopDetectorの内部状態
 */
export interface LoopDetectorState {
  stepIterations: Map<string, StepIterationTracker>;
  responseHistory: ResponseHistoryEntry[];
  transitions: StateTransition[];
}

/**
 * Jaccard類似度を計算
 *
 * 2つの文字列をトークン化し、Jaccard係数を計算
 */
const calculateJaccardSimilarity = (a: string, b: string): number => {
  const tokenize = (s: string): Set<string> => {
    // 単語単位でトークン化（空白・改行で分割）
    return new Set(
      s
        .toLowerCase()
        .split(/\s+/)
        .filter((token) => token.length > 0),
    );
  };

  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 && setB.size === 0) {
    return 1.0; // 両方空なら完全一致
  }

  if (setA.size === 0 || setB.size === 0) {
    return 0.0; // 片方のみ空なら不一致
  }

  // 交差集合のサイズ
  let intersectionSize = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersectionSize++;
    }
  }

  // 和集合のサイズ
  const unionSize = setA.size + setB.size - intersectionSize;

  return intersectionSize / unionSize;
};

/**
 * 状態遷移パターンを検出
 *
 * 同じ遷移シーケンスが繰り返されているかチェック
 */
const detectTransitionPattern = (
  transitions: StateTransition[],
  minOccurrences: number,
): { pattern: StateTransition[]; occurrences: number } | null => {
  if (transitions.length < 2) {
    return null;
  }

  // パターン長2から開始し、最大で全体の半分まで
  const maxPatternLength = Math.floor(transitions.length / 2);

  for (let patternLength = 2; patternLength <= maxPatternLength; patternLength++) {
    // 末尾からパターンを抽出
    const pattern = transitions.slice(-patternLength);

    // パターンが何回出現するかカウント
    let occurrences = 1;
    let searchStart = transitions.length - patternLength * 2;

    while (searchStart >= 0) {
      const candidate = transitions.slice(searchStart, searchStart + patternLength);

      // パターンが一致するかチェック
      const isMatch = candidate.every((t, i) => {
        const patternItem = pattern[i];
        return patternItem !== undefined && t.from === patternItem.from && t.to === patternItem.to;
      });

      if (isMatch) {
        occurrences++;
        searchStart -= patternLength;
      } else {
        break;
      }
    }

    if (occurrences >= minOccurrences) {
      return { pattern, occurrences };
    }
  }

  return null;
};

/**
 * LoopDetector実装を作成
 */
export const createLoopDetector = (
  config: LoopDetectionConfig = DEFAULT_LOOP_DETECTION_CONFIG,
): LoopDetector => {
  // 内部状態
  const stepIterations = new Map<string, StepIterationTracker>();
  const responseHistory: ResponseHistoryEntry[] = [];
  const transitions: StateTransition[] = [];

  /**
   * ステップごとの最大イテレーション数を取得
   */
  const getMaxIterations = (stepName: string): number => {
    const normalizedName = stepName.toLowerCase();

    if (normalizedName.includes('worker')) {
      return config.maxStepIterations.worker;
    }
    if (normalizedName.includes('judge')) {
      return config.maxStepIterations.judge;
    }
    if (normalizedName.includes('replan')) {
      return config.maxStepIterations.replan;
    }

    return config.maxStepIterations.default;
  };

  /**
   * ステップ実行を記録し、ループをチェック
   */
  const recordStepExecution = (stepName: string): LoopDetectionResult => {
    if (!config.enabled) {
      return { type: 'ok' };
    }

    const tracker = stepIterations.get(stepName);
    const maxAllowed = getMaxIterations(stepName);

    if (tracker) {
      const newCount = tracker.count + 1;

      if (newCount > maxAllowed) {
        return {
          type: 'step_iteration_exceeded',
          stepName,
          count: newCount,
          max: maxAllowed,
        };
      }

      stepIterations.set(stepName, {
        ...tracker,
        count: newCount,
        lastExecutedAt: new Date().toISOString(),
      });
    } else {
      stepIterations.set(stepName, {
        stepName,
        count: 1,
        maxAllowed,
        lastExecutedAt: new Date().toISOString(),
      });
    }

    return { type: 'ok' };
  };

  /**
   * 応答を記録し、類似度をチェック
   */
  const recordResponse = (stepName: string, response: string): LoopDetectionResult => {
    if (!config.enabled || !config.similarityDetection.enabled) {
      return { type: 'ok' };
    }

    // 同じステップの過去の応答と比較
    const recentResponses = responseHistory
      .filter((entry) => entry.stepName === stepName)
      .slice(-config.similarityDetection.windowSize);

    for (const entry of recentResponses) {
      const similarity = calculateJaccardSimilarity(response, entry.response);

      if (similarity >= config.similarityDetection.threshold) {
        // 履歴には追加
        responseHistory.push({
          stepName,
          response,
          timestamp: new Date().toISOString(),
        });

        return {
          type: 'similar_response',
          stepName,
          similarity,
          threshold: config.similarityDetection.threshold,
        };
      }
    }

    // 履歴に追加
    responseHistory.push({
      stepName,
      response,
      timestamp: new Date().toISOString(),
    });

    // 履歴が大きくなりすぎないようにトリミング
    const maxHistorySize = 100;
    if (responseHistory.length > maxHistorySize) {
      responseHistory.splice(0, responseHistory.length - maxHistorySize);
    }

    return { type: 'ok' };
  };

  /**
   * 状態遷移を記録し、パターンをチェック
   */
  const recordTransition = (transition: StateTransition): LoopDetectionResult => {
    if (!config.enabled || !config.transitionPatternDetection.enabled) {
      return { type: 'ok' };
    }

    transitions.push(transition);

    // パターン検出
    const patternResult = detectTransitionPattern(
      transitions,
      config.transitionPatternDetection.minOccurrences,
    );

    if (patternResult) {
      return {
        type: 'transition_pattern',
        pattern: patternResult.pattern,
        occurrences: patternResult.occurrences,
      };
    }

    // 遷移履歴が大きくなりすぎないようにトリミング
    const maxTransitionHistory = 50;
    if (transitions.length > maxTransitionHistory) {
      transitions.splice(0, transitions.length - maxTransitionHistory);
    }

    return { type: 'ok' };
  };

  /**
   * ループ検出結果に対するアクションを決定
   */
  const determineAction = (result: LoopDetectionResult): LoopAction => {
    if (result.type === 'ok') {
      return { type: 'force_continue', warning: '' };
    }

    // デフォルトアクションを適用
    const defaultAction = config.onLoop.default;

    switch (result.type) {
      case 'step_iteration_exceeded':
        // ステップイテレーション超過はユーザーにエスカレート
        return {
          type: 'escalate',
          target: 'user',
        };

      case 'similar_response':
        // 類似応答はヒント付きリトライを最初に試す
        return {
          type: 'retry_with_hint',
          hint: `Previous response was very similar (${Math.round(result.similarity * 100)}% match). Try a different approach.`,
        };

      case 'transition_pattern':
        // 遷移パターン検出はPlannerに再計画を依頼
        return {
          type: 'escalate',
          target: 'planner',
        };

      default:
        // フォールバック
        if (defaultAction === 'abort') {
          return { type: 'abort', reason: 'Loop detected' };
        }
        return { type: 'escalate', target: 'user' };
    }
  };

  /**
   * 特定ステップのイテレーションカウントを取得
   */
  const getStepIterationCount = (stepName: string): number => {
    return stepIterations.get(stepName)?.count ?? 0;
  };

  /**
   * すべての状態をリセット
   */
  const reset = (): void => {
    stepIterations.clear();
    responseHistory.length = 0;
    transitions.length = 0;
  };

  /**
   * 現在の状態を取得（デバッグ用）
   */
  const getState = (): LoopDetectorState => ({
    stepIterations: new Map(stepIterations),
    responseHistory: [...responseHistory],
    transitions: [...transitions],
  });

  return {
    recordStepExecution,
    recordResponse,
    recordTransition,
    determineAction,
    getStepIterationCount,
    reset,
    getState,
  };
};
