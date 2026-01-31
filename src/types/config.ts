import { z } from 'zod';
import type { RefinementConfig } from './planner-session.ts';
import { PromptConfigSchema } from './prompt.ts';
import { LoopDetectionConfigSchema } from './loop-detection.ts';
import { AIAntipatternConfigSchema } from './ai-antipattern.ts';

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
 *
 * WHY: タスク完了後に型チェックやテストを実行し、失敗時は自動修正を試みることで
 *      コード品質を担保しつつ人手による介入を最小化する
 */
const ChecksConfigSchema = z
  .object({
    /** CI/Lintチェックを実行するか */
    enabled: z.boolean().default(true),
    /**
     * チェック失敗時の動作
     * - 'block': オーケストレーション停止
     * - 'warn': 警告のみで続行
     * - 'retry': Workerにエラー内容を渡して修正を指示、成功まで再実行
     */
    failureMode: z.enum(['block', 'warn', 'retry']).default('block'),
    /**
     * タスク完了後に実行するチェックコマンド
     *
     * 例: ["pnpm typecheck", "pnpm lint", "pnpm test"]
     */
    commands: z.array(z.string()).default([]),
    /**
     * retry モード時の最大リトライ回数
     *
     * WHY: 無限ループを防ぎつつ、十分な修正機会を与える
     */
    maxRetries: z.number().int().min(1).max(10).default(3),
  })
  .default({ enabled: true, failureMode: 'block', commands: [], maxRetries: 3 });

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
    /**
     * Worker実行時・統合worktree内の自動コミットでGPG署名を有効化
     *
     * - true: 自動コミットに署名を付与（ユーザーの常時監視が必要）
     * - false (default): 自動コミットは署名なし
     *
     * NOTE: 統合worktree内のマージコミットもこの設定に従う。
     */
    autoSignature: z.boolean().default(false),
    /**
     * Integration完了時（finalizeコマンド）の署名を有効化
     *
     * WHY: GPG署名にはユーザー認証（pinentry等）が必要で、長時間オーケストレーション後に
     *      ユーザーが不在だと認証タイムアウトで失敗する。そのため、自動rebaseではなく
     *      `agent finalize` コマンドを案内して遅延実行を可能にする。
     *
     * - true (default): 署名付きfinalizeコマンド (`agent finalize`) を案内
     * - false: 自動的にrebase & mergeを実行（署名なし）
     *
     * NOTE: このフラグはfinalizeコマンドのみに影響する。
     *       統合worktree内のコミットはautoSignatureを参照する。
     */
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
 * Refinement設定のスキーマ
 *
 * WHY: Plan品質評価後の改善プロセスを制御し、
 *      品質スコアが低い場合でも段階的に改善を試みることで、
 *      タスク生成の成功率を向上させる
 */
const RefinementConfigSchema = z
  .object({
    /** 最大Refinement試行回数 */
    maxRefinementAttempts: z.number().int().min(0).max(10).default(2),
    /** 成功時も改善提案を適用するか */
    refineSuggestionsOnSuccess: z.boolean().default(false),
    /** 提案ベースの再計画最大回数 */
    maxSuggestionReplans: z.number().int().min(0).max(5).default(1),
    /** 個別タスク評価フォールバックを有効化 */
    enableIndividualFallback: z.boolean().default(true),
    /** スコア改善の最小絶対値閾値 */
    deltaThreshold: z.number().min(0).max(50).default(5),
    /** スコア改善の最小パーセント閾値 */
    deltaThresholdPercent: z.number().min(0).max(100).default(5),
    /** タスク数変化の許容割合 */
    taskCountChangeThreshold: z.number().min(0).max(1).default(0.3),
    /** タスク数変化の最小絶対値 */
    taskCountChangeMinAbsolute: z.number().int().min(0).max(10).default(2),
    /**
     * 目標スコア閾値（0-100）
     *
     * WHY: qualityThresholdを超えても、targetScore未達かつsuggestionsがある場合は
     *      refinementを継続することで、より高品質なプランを目指す
     */
    targetScore: z.number().min(0).max(100).default(85),
  })
  .default({
    maxRefinementAttempts: 2,
    refineSuggestionsOnSuccess: false,
    maxSuggestionReplans: 1,
    enableIndividualFallback: true,
    deltaThreshold: 5,
    deltaThresholdPercent: 5,
    taskCountChangeThreshold: 0.3,
    taskCountChangeMinAbsolute: 2,
    targetScore: 85,
  });

/**
 * Worktree設定のスキーマ
 *
 * WHY: プロジェクトごとにworktree作成後の初期化コマンドを定義可能にすることで、
 *      依存関係のインストールなどを自動化し、Worker実行時のエラーを防ぐ
 */
const WorktreeConfigSchema = z
  .object({
    /**
     * worktree作成後に実行するコマンド配列
     *
     * 例: ["pnpm install"], ["npm install"], ["pip install -r requirements.txt"]
     */
    postCreate: z.array(z.string()).default([]),
  })
  .default({ postCreate: [] });

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

  /** Refinement設定 */
  refinement: RefinementConfigSchema.optional(),

  /** Worktree設定 */
  worktree: WorktreeConfigSchema,

  /** GitHub設定 */
  github: GitHubConfigSchema.optional(),

  /**
   * プロンプト外部化設定 (ADR-026)
   *
   * WHY: エージェントプロンプトをMarkdownファイルとして外部化することで、
   *      コード変更なしでプロンプトをカスタマイズ可能にする
   */
  prompts: PromptConfigSchema.optional(),

  /**
   * ループ検出設定 (ADR-033)
   *
   * WHY: 無限ループによるリソース浪費を防止し、
   *      問題の早期検出と適切なエスカレーションを実現
   */
  loopDetection: LoopDetectionConfigSchema.optional(),

  /**
   * AIアンチパターン検出設定 (ADR-031)
   *
   * WHY: AI生成コード特有の品質問題（フォールバック乱用、未使用コード等）を
   *      早期に検出して品質を担保する
   */
  aiAntipattern: AIAntipatternConfigSchema.optional(),

  /**
   * 後方互換性: maxQualityRetries (非推奨)
   * WHY: 既存設定との互換性のため保持。refinement.maxRefinementAttemptsが優先される
   */
  maxQualityRetries: z.number().int().min(0).max(10).optional(),
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
 * デフォルトRefinement設定定数
 *
 * WHY: 設定読み込み時のデフォルト値として使用し、
 *      部分的な設定でも正しくマージできるようにする
 */
export const DEFAULT_REFINEMENT_CONFIG: RefinementConfig = {
  maxRefinementAttempts: 2,
  refineSuggestionsOnSuccess: false,
  maxSuggestionReplans: 1,
  enableIndividualFallback: true,
  deltaThreshold: 5,
  deltaThresholdPercent: 5,
  taskCountChangeThreshold: 0.3,
  taskCountChangeMinAbsolute: 2,
  targetScore: 85,
};

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
      commands: [],
      maxRetries: 3,
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
    refinement: DEFAULT_REFINEMENT_CONFIG,
    worktree: {
      postCreate: [],
    },
  };
}
