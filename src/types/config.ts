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
    model: z.union([z.enum(KnownClaudeModels), z.string()]),
  }),
  z.object({
    type: z.literal('codex'),
    /**
     * Codexモデル名
     *
     * 既知のモデルには補完が効き、任意の文字列も受け付ける。
     * JSON Schemaでは anyOf として出力され、エディタで補完が効く。
     */
    model: z.union([z.enum(KnownCodexModels), z.string()]),
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
 *
 * WHY: 統合後評価により、全タスク完了後に統合コードベースで最終評価を実施し、
 *      不完全な場合は追加タスクを生成して前に進み続ける
 */
const IntegrationConfigSchema = z
  .object({
    /** 統合方法: 'pr' (Pull Request作成), 'command' (コマンド出力), 'auto' (自動判定) */
    method: z.enum(['pr', 'command', 'auto']).default('auto'),
    /** 統合後評価を有効化（統合worktree上でコード差分を含む最終評価を実施） */
    postIntegrationEvaluation: z.boolean().default(true),
    /** 追加タスクループの最大反復回数（評価が不完全な場合に追加タスクを生成） */
    maxAdditionalTaskIterations: z.number().int().min(1).max(10).default(3),
    /**
     * マージ戦略
     * WHY: タスク数が多いとマージコミットでグラフが複雑化する。
     * 'ff-prefer': fast-forward可能ならff、できない場合のみマージコミット作成
     * 'no-ff': 常にマージコミット作成（各タスクの変更を明示的に記録）
     */
    mergeStrategy: z.enum(['ff-prefer', 'no-ff']).default('ff-prefer'),
  })
  .default({
    method: 'auto',
    postIntegrationEvaluation: true,
    maxAdditionalTaskIterations: 3,
    mergeStrategy: 'ff-prefer',
  });

/**
 * コミット設定のスキーマ
 *
 * WHY: Worker実行時の各タスクコミットとIntegration時の最終コミットで
 *      署名の有無を制御可能にすることで、開発効率と検証可能性の両立を実現
 */
const CommitConfigSchema = z
  .object({
    /** Worker実行時の自動コミットでGPG署名を有効化 */
    autoSignature: z.boolean().default(false),
    /** Integration時の最終コミットでGPG署名を有効化 */
    integrationSignature: z.boolean().default(true),
  })
  .default({ autoSignature: false, integrationSignature: true });

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
    /**
     * Plan品質評価用Judge設定（オプショナル）
     *
     * WHY: Plannerが生成したタスク分解の品質評価に、通常のJudgeモデルとは
     *      別のモデル（より高度なモデル）を指定可能にする。
     *      設定がなければ agents.judge の設定にフォールバック。
     */
    planQualityJudge: AgentConfigSchema.optional(),
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
 * Planner再評価設定のスキーマ
 *
 * WHY: Judge判定で shouldReplan=true となったタスクを自動的に再分解して、
 *      手動介入なしでタスク完了率を向上させる
 */
const ReplanningConfigSchema = z
  .object({
    /** Planner再評価機能を有効化 */
    enabled: z.boolean().default(true),
    /** タスクあたりの最大再評価回数 */
    maxIterations: z.number().int().min(1).max(10).default(3),
    /** Planner再評価のタイムアウト（秒） */
    timeoutSeconds: z.number().int().min(60).max(600).default(300),
  })
  .default({
    enabled: true,
    maxIterations: 3,
    timeoutSeconds: 300,
  });

/**
 * GitHub認証設定のスキーマ
 *
 * WHY: Personal Access Tokenによる認証をサポート
 */
const GitHubAuthConfigSchema = z.object({
  /** 認証タイプ */
  type: z.literal('pat'),
  /** トークンを格納する環境変数名 */
  tokenEnvName: z.string(),
});

/**
 * GitHub設定のスキーマ
 *
 * WHY: GitHub APIとの統合を可能にするための設定
 */
const GitHubConfigSchema = z.object({
  /** GitHub API Base URL */
  apiBaseUrl: z.string().default('https://api.github.com'),
  /** リポジトリオーナー */
  owner: z.string(),
  /** リポジトリ名 */
  repo: z.string(),
  /** 認証設定 */
  auth: GitHubAuthConfigSchema,
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
  agents: z.object({
    /** Planner設定 */
    planner: AgentConfigSchema,
    /** Worker設定 */
    worker: AgentConfigSchema,
    /** Judge設定 */
    judge: AgentConfigSchema,
  }),

  /** チェック設定 */
  checks: ChecksConfigSchema,

  /** コミット設定 */
  commit: CommitConfigSchema,

  /** 統合設定 */
  integration: IntegrationConfigSchema,

  /** タスク計画品質評価設定 */
  planning: PlanningConfigSchema,

  /** 反復実行回数設定 */
  iterations: IterationsConfigSchema,

  /** Planner再評価設定 */
  replanning: ReplanningConfigSchema,

  /** GitHub設定 */
  github: GitHubConfigSchema.optional(),
});

/**
 * Config型定義（TypeScript型）
 */
export type Config = z.infer<typeof ConfigSchema>;

/**
 * GitHub設定型定義（TypeScript型）
 */
export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;

/**
 * GitHub認証設定型定義（TypeScript型）
 */
export type GitHubAuthConfig = z.infer<typeof GitHubAuthConfigSchema>;

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
    commit: {
      autoSignature: false,
      integrationSignature: true,
    },
    integration: {
      method: 'auto',
      postIntegrationEvaluation: true,
      maxAdditionalTaskIterations: 3,
      mergeStrategy: 'ff-prefer',
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
    replanning: {
      enabled: true,
      maxIterations: 3,
      timeoutSeconds: 300,
    },
  };
}
