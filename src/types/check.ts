import { z } from 'zod';

/**
 * CI/Lintチェック結果の状態
 *
 * - PASS: チェック成功
 * - FAIL: チェック失敗
 * - SKIP: チェックスキップ（設定なし等）
 */
export const CheckStatus = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  SKIP: 'SKIP',
} as const;

export type CheckStatus = (typeof CheckStatus)[keyof typeof CheckStatus];

/**
 * Checkのスキーマ定義（Zod）
 *
 * CI/Lint実行結果を記録
 */
export const CheckSchema = z.object({
  /** チェックID（ユニーク識別子） */
  id: z.string(),

  /** 対応するタスクID */
  taskId: z.string(),

  /** チェック状態 */
  status: z.enum([CheckStatus.PASS, CheckStatus.FAIL, CheckStatus.SKIP]),

  /** 実行したチェックコマンド（例: "pnpm test", "pnpm lint"） */
  command: z.string(),

  /** チェック結果の詳細メッセージ */
  message: z.string().nullable(),

  /** チェック実行ログファイルパス */
  logPath: z.string().nullable(),

  /** チェック実行日時 */
  executedAt: z.string().datetime(),
});

/**
 * Check型定義（TypeScript型）
 */
export type Check = z.infer<typeof CheckSchema>;

/**
 * 新規Check初期値生成ヘルパー
 */
export function createInitialCheck(params: { id: string; taskId: string; command: string }): Check {
  return {
    id: params.id,
    taskId: params.taskId,
    status: CheckStatus.SKIP, // 初期値、後で更新
    command: params.command,
    message: null,
    logPath: null,
    executedAt: new Date().toISOString(),
  };
}
