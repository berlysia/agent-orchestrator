import { z } from 'zod';

/**
 * 既知のモデル名（補完のため）
 *
 * WHY: Union型で既知のモデルと任意の文字列を組み合わせることで、
 * TypeScriptの `string & {}` トリック相当を実現。
 * 既知のモデルには補完が効き、新しいモデルも受け付ける。
 */
const KnownClaudeModels = ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'] as const;
const KnownCodexModels = ['gpt-5.2-codex', 'gpt-5.1-codex-mini'] as const;

/**
 * エージェント設定のスキーマ
 *
 * WHY: discriminatedUnion を使用することで、type に応じて適切なモデル補完を提供
 */
const AgentConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('claude'),
    /**
     * Claudeモデル名
     *
     * 既知のモデルには補完が効き、任意の文字列も受け付ける。
     * JSON Schemaでは anyOf として出力され、エディタで補完が効く。
     */
    model: z.union([z.enum(KnownClaudeModels), z.string()]).optional(),
  }),
  z.object({
    type: z.literal('codex'),
    /**
     * Codexモデル名
     *
     * 既知のモデルには補完が効き、任意の文字列も受け付ける。
     * JSON Schemaでは anyOf として出力され、エディタで補完が効く。
     */
    model: z.union([z.enum(KnownCodexModels), z.string()]).optional(),
  }),
]);

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
