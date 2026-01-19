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
 * 統合設定のスキーマ
 */
const IntegrationConfigSchema = z
  .object({
    /** 統合方法: 'pr' (Pull Request作成), 'command' (コマンド出力), 'auto' (自動判定) */
    method: z.enum(['pr', 'command', 'auto']).default('auto'),
  })
  .default({ method: 'auto' });

/**
 * タスク計画品質評価設定のスキーマ
 *
 * WHY: Plannerが生成したタスクの品質評価基準を設定可能にすることで、
 *      プロジェクトの特性に応じた柔軟な品質管理を実現
 */
const PlanningConfigSchema = z
  .object({
    /** 品質許容スコア閾値（0-100） */
    qualityThreshold: z.number().min(0).max(100).default(60),
    /** 厳格なコンテキスト検証を有効化（外部参照禁止、行番号必須など） */
    strictContextValidation: z.boolean().default(false),
    /** タスクあたりの最大見積時間（時間単位）*/
    maxTaskDuration: z.number().min(0.5).max(8).default(4),
    /** 1回の計画で生成する最大タスク数 */
    maxTasks: z.number().int().min(1).max(20).default(5),
  })
  .default({
    qualityThreshold: 60,
    strictContextValidation: false,
    maxTaskDuration: 4,
    maxTasks: 5,
  });

/**
 * 反復実行回数設定のスキーマ
 *
 * WHY: 各種リトライ・反復処理の最大回数を一元管理し、
 *      プロジェクトの特性やタスクの複雑度に応じた柔軟な調整を可能にする
 */
const IterationsConfigSchema = z
  .object({
    /** Planner品質評価の最大リトライ回数 */
    plannerQualityRetries: z.number().int().positive().default(5),
    /** Judgeによるタスク判定の最大リトライ回数 */
    judgeTaskRetries: z.number().int().positive().default(3),
    /** Orchestrateメインループの最大反復回数 */
    orchestrateMainLoop: z.number().int().positive().default(3),
    /** Serial Executorでのタスク実行最大リトライ回数 */
    serialChainTaskRetries: z.number().int().positive().default(3),
  })
  .default({
    plannerQualityRetries: 5,
    judgeTaskRetries: 3,
    orchestrateMainLoop: 3,
    serialChainTaskRetries: 3,
  });

/**
 * プロジェクト設定のスキーマ定義（Zod）
 *
 * `.agent/config.json` に保存される設定
 */
export const ConfigSchema = z.object({
  /** JSON Schema参照（省略可能） */
  $schema: z.string().optional(),

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

  /** 統合設定 */
  integration: IntegrationConfigSchema,

  /** タスク計画品質評価設定 */
  planning: PlanningConfigSchema,

  /** 反復実行回数設定 */
  iterations: IterationsConfigSchema,
});

/**
 * Config型定義（TypeScript型）
 */
export type Config = z.infer<typeof ConfigSchema>;

/**
 * エージェントタイプ
 */
export type AgentType = 'claude' | 'codex';

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
    integration: {
      method: 'auto',
    },
    planning: {
      qualityThreshold: 60,
      strictContextValidation: false,
      maxTaskDuration: 4,
      maxTasks: 5,
    },
    iterations: {
      plannerQualityRetries: 5,
      judgeTaskRetries: 3,
      orchestrateMainLoop: 3,
      serialChainTaskRetries: 3,
    },
  };
}
