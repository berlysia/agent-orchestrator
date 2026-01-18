import { z } from 'zod';

/**
 * エージェント設定のスキーマ
 */
const AgentConfigSchema = z.object({
  /** エージェントタイプ */
  type: z.enum(['claude', 'codex']).default('claude'),
  /** モデル名（Claude使用時のみ） */
  model: z.string().optional(),
});

/**
 * チェック設定のスキーマ
 */
const ChecksConfigSchema = z
  .object({
    /** CI/Lintチェックを実行するか */
    enabled: z.boolean().default(true),
    /** チェック失敗時の動作 */
    failureMode: z.enum(['block', 'warn']).default('block'),
  })
  .default({ enabled: true, failureMode: 'block' });

/**
 * プロジェクト設定のスキーマ定義（Zod）
 *
 * `.agent/config.json` に保存される設定
 */
export const ConfigSchema = z.object({
  /** 開発対象リポジトリのパス（app-repo） */
  appRepoPath: z.string(),

  /** タスク状態管理リポジトリのパス（agent-coord） */
  agentCoordPath: z.string(),

  /** Workerの最大並列実行数 */
  maxWorkers: z.number().int().positive().default(3),

  /** 役割別エージェント設定 */
  agents: z
    .object({
      /** Planner設定（デフォルト: claude + opus-4-5） */
      planner: AgentConfigSchema.default({ type: 'claude', model: 'claude-opus-4-5' }),
      /** Worker設定（デフォルト: claude + sonnet-4-5） */
      worker: AgentConfigSchema.default({ type: 'claude', model: 'claude-sonnet-4-5' }),
      /** Judge設定（デフォルト: claude + haiku-4-5） */
      judge: AgentConfigSchema.default({ type: 'claude', model: 'claude-haiku-4-5' }),
    })
    .default({
      planner: { type: 'claude', model: 'claude-opus-4-5' },
      worker: { type: 'claude', model: 'claude-sonnet-4-5' },
      judge: { type: 'claude', model: 'claude-haiku-4-5' },
    }),

  /** チェック設定 */
  checks: ChecksConfigSchema,
});

/**
 * Config型定義（TypeScript型）
 */
export type Config = z.infer<typeof ConfigSchema>;

/**
 * デフォルトConfig生成ヘルパー
 */
export function createDefaultConfig(params: {
  appRepoPath: string;
  agentCoordPath: string;
}): Config {
  return {
    appRepoPath: params.appRepoPath,
    agentCoordPath: params.agentCoordPath,
    maxWorkers: 3,
    agents: {
      planner: { type: 'claude', model: 'claude-opus-4-5' },
      worker: { type: 'claude', model: 'claude-sonnet-4-5' },
      judge: { type: 'claude', model: 'claude-haiku-4-5' },
    },
    checks: {
      enabled: true,
      failureMode: 'block',
    },
  };
}
