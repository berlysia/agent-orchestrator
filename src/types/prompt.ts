/**
 * Prompt Types - プロンプト外部化のための型定義
 *
 * ADR-026: エージェントプロンプトをMarkdownファイルとして外部化
 */

import { z } from 'zod';

/**
 * エージェントロール
 */
export const AgentRole = {
  PLANNER: 'planner',
  WORKER: 'worker',
  JUDGE: 'judge',
  LEADER: 'leader',
} as const;

export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole];

/**
 * プロンプトテンプレート変数
 */
export interface PromptVariables {
  /** タスク内容 */
  task?: string;
  /** タスクID */
  task_id?: string;
  /** セッションID */
  session_id?: string;
  /** コンテキスト情報 */
  context?: string;
  /** 前ステップの出力 */
  previous_response?: string;
  /** 現在のイテレーション（ワークフロー全体） */
  iteration?: number;
  /** 現在のステップのイテレーション */
  step_iteration?: number;
  /** 最大イテレーション数 */
  max_iterations?: number;
  /** レポートディレクトリパス */
  report_dir?: string;
  /** ユーザー追加入力 */
  user_inputs?: string;
}

/**
 * プロンプトロードエラーの種類
 */
export const PromptLoadErrorType = {
  FILE_NOT_FOUND: 'file_not_found',
  PARSE_ERROR: 'parse_error',
  VALIDATION_ERROR: 'validation_error',
  IO_ERROR: 'io_error',
} as const;

export type PromptLoadErrorType =
  (typeof PromptLoadErrorType)[keyof typeof PromptLoadErrorType];

/**
 * プロンプトロードエラー
 */
export interface PromptLoadError {
  type: PromptLoadErrorType;
  message: string;
  path?: string;
  cause?: unknown;
}

/**
 * プロンプトロードエラー生成ヘルパー
 */
export const promptLoadError = (
  type: PromptLoadErrorType,
  message: string,
  path?: string,
  cause?: unknown,
): PromptLoadError => ({
  type,
  message,
  path,
  cause,
});

/**
 * プロンプト設定スキーマ
 */
export const PromptConfigSchema = z
  .object({
    /** プロンプト外部化を有効化 */
    enabled: z.boolean().default(true),
    /** プロンプトディレクトリのカスタムパス */
    customPath: z.string().optional(),
    /** キャッシュを有効化 */
    cacheEnabled: z.boolean().default(true),
    /** キャッシュTTL（秒） */
    cacheTtlSeconds: z.number().int().min(0).default(300),
  })
  .default({
    enabled: true,
    cacheEnabled: true,
    cacheTtlSeconds: 300,
  });

export type PromptConfig = z.infer<typeof PromptConfigSchema>;

/**
 * プロンプトソース（どこからロードされたか）
 */
export const PromptSource = {
  PROJECT: 'project',
  GLOBAL: 'global',
  BUILTIN: 'builtin',
} as const;

export type PromptSource = (typeof PromptSource)[keyof typeof PromptSource];

/**
 * ロードされたプロンプト情報
 */
export interface LoadedPrompt {
  /** プロンプト内容 */
  content: string;
  /** ソース */
  source: PromptSource;
  /** ソースパス（ビルトイン以外） */
  sourcePath?: string;
  /** ロード時刻 */
  loadedAt: string;
}
