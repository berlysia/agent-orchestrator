/**
 * Orchestrator Loop Detection Integration
 *
 * ADR-033: ループ検出をOrchestratorに統合するためのヘルパー
 *
 * このモジュールは、Orchestrator内でLoopDetectorを使用するための
 * 統合ポイントを提供します。
 */

import type {
  LoopDetectionConfig,
  LoopDetectionResult,
  LoopAction,
  StateTransition,
} from '../../types/loop-detection.ts';
import { DEFAULT_LOOP_DETECTION_CONFIG } from '../../types/loop-detection.ts';
import { createLoopDetector, type LoopDetector } from './loop-detector.ts';

/**
 * Orchestratorループ統合のコンテキスト
 */
export interface OrchestratorLoopContext {
  /** セッションID */
  sessionId: string;
  /** 現在のタスクID */
  currentTaskId?: string;
  /** 現在のステップ名 */
  currentStep: string;
}

/**
 * ループ検出統合インターフェース
 */
export interface LoopDetectionIntegration {
  /**
   * ステップ実行前にループをチェック
   *
   * @param stepName ステップ名
   * @returns ループ検出結果とアクション
   */
  checkBeforeStep(stepName: string): {
    result: LoopDetectionResult;
    action: LoopAction;
    shouldProceed: boolean;
  };

  /**
   * ステップ実行後に応答を記録
   *
   * @param stepName ステップ名
   * @param response 応答内容
   * @returns ループ検出結果とアクション
   */
  recordStepResponse(
    stepName: string,
    response: string,
  ): {
    result: LoopDetectionResult;
    action: LoopAction;
    shouldProceed: boolean;
  };

  /**
   * 状態遷移を記録
   *
   * @param from 遷移元
   * @param to 遷移先
   * @param reason 遷移理由
   * @returns ループ検出結果とアクション
   */
  recordTransition(
    from: string,
    to: string,
    reason: string,
  ): {
    result: LoopDetectionResult;
    action: LoopAction;
    shouldProceed: boolean;
  };

  /**
   * 特定ステップのイテレーションカウントを取得
   */
  getStepCount(stepName: string): number;

  /**
   * 検出器をリセット
   */
  reset(): void;

  /**
   * 内部のLoopDetectorを取得（高度な操作用）
   */
  getDetector(): LoopDetector;
}

/**
 * LoopDetectionIntegration実装を作成
 *
 * @param config ループ検出設定
 * @returns LoopDetectionIntegration実装
 */
export const createLoopDetectionIntegration = (
  config: LoopDetectionConfig = DEFAULT_LOOP_DETECTION_CONFIG,
): LoopDetectionIntegration => {
  const detector = createLoopDetector(config);

  /**
   * 結果からアクションを決定し、続行可否を判定
   */
  const processResult = (result: LoopDetectionResult): {
    result: LoopDetectionResult;
    action: LoopAction;
    shouldProceed: boolean;
  } => {
    const action = detector.determineAction(result);
    const shouldProceed = result.type === 'ok' || action.type === 'force_continue' || action.type === 'retry_with_hint';

    return { result, action, shouldProceed };
  };

  const checkBeforeStep = (stepName: string) => {
    const result = detector.recordStepExecution(stepName);
    return processResult(result);
  };

  const recordStepResponse = (stepName: string, response: string) => {
    const result = detector.recordResponse(stepName, response);
    return processResult(result);
  };

  const recordTransition = (from: string, to: string, reason: string) => {
    const transition: StateTransition = {
      from,
      to,
      reason,
      timestamp: new Date().toISOString(),
    };
    const result = detector.recordTransition(transition);
    return processResult(result);
  };

  const getStepCount = (stepName: string): number => {
    return detector.getStepIterationCount(stepName);
  };

  const reset = (): void => {
    detector.reset();
  };

  const getDetector = (): LoopDetector => {
    return detector;
  };

  return {
    checkBeforeStep,
    recordStepResponse,
    recordTransition,
    getStepCount,
    reset,
    getDetector,
  };
};

/**
 * ループアクションをログメッセージに変換
 *
 * @param action ループアクション
 * @param result ループ検出結果
 * @returns ログメッセージ
 */
export const formatLoopActionMessage = (
  action: LoopAction,
  result: LoopDetectionResult,
): string => {
  if (result.type === 'ok') {
    return '';
  }

  const resultDescription = (() => {
    switch (result.type) {
      case 'step_iteration_exceeded':
        return `Step '${result.stepName}' exceeded max iterations (${result.count}/${result.max})`;
      case 'similar_response':
        return `Similar response detected for '${result.stepName}' (${Math.round(result.similarity * 100)}% similarity)`;
      case 'transition_pattern':
        return `Transition pattern detected (${result.occurrences} occurrences)`;
      default:
        return 'Unknown loop condition';
    }
  })();

  const actionDescription = (() => {
    switch (action.type) {
      case 'abort':
        return `Aborting: ${action.reason}`;
      case 'escalate':
        return `Escalating to ${action.target}`;
      case 'force_continue':
        return action.warning ? `Continuing with warning: ${action.warning}` : 'Forcing continuation';
      case 'retry_with_hint':
        return `Retrying with hint: ${action.hint}`;
      default:
        return 'Unknown action';
    }
  })();

  return `Loop detected: ${resultDescription}. Action: ${actionDescription}`;
};

/**
 * Worker実行用のステップ名を生成
 */
export const getWorkerStepName = (taskId: string): string => `worker_${taskId}`;

/**
 * Judge評価用のステップ名を生成
 */
export const getJudgeStepName = (taskId: string): string => `judge_${taskId}`;

/**
 * Replan用のステップ名を生成
 */
export const getReplanStepName = (taskId: string): string => `replan_${taskId}`;
