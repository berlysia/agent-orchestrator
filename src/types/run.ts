import { z } from 'zod';

/**
 * Worker実行結果の状態
 *
 * - SUCCESS: 正常完了
 * - FAILURE: エラーで失敗
 * - TIMEOUT: タイムアウト
 */
export const RunStatus = {
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
  TIMEOUT: 'TIMEOUT',
} as const;

export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

/**
 * Runのスキーマ定義（Zod）
 *
 * Workerエージェント実行結果を記録
 */
export const RunSchema = z.object({
  /** 実行ID（ユニーク識別子） */
  id: z.string(),

  /** 対応するタスクID */
  taskId: z.string(),

  /** 実行状態 */
  status: z.enum([RunStatus.SUCCESS, RunStatus.FAILURE, RunStatus.TIMEOUT]),

  /** 使用したエージェント種別 ("claude" | "codex") */
  agentType: z.enum(['claude', 'codex']),

  /** 実行ログファイルパス（相対パスまたは絶対パス） */
  logPath: z.string(),

  /** 実行開始日時 */
  startedAt: z.string().datetime(),

  /** 実行終了日時 */
  finishedAt: z.string().datetime().nullable(),

  /** エラーメッセージ（失敗時のみ） */
  errorMessage: z.string().nullable(),
});

/**
 * Run型定義（TypeScript型）
 */
export type Run = z.infer<typeof RunSchema>;

/**
 * 新規Run初期値生成ヘルパー
 */
export function createInitialRun(params: {
  id: string;
  taskId: string;
  agentType: 'claude' | 'codex';
  logPath: string;
}): Run {
  return {
    id: params.id,
    taskId: params.taskId,
    status: RunStatus.SUCCESS, // 初期値、後で更新
    agentType: params.agentType,
    logPath: params.logPath,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    errorMessage: null,
  };
}
