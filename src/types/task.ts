import { z } from 'zod';
import { taskId, checkId, workerId, repoPath, branchName } from './branded.ts';
import type { TaskId, RepoPath, BranchName } from './branded.ts';

// CheckIdとWorkerIdはz.inferで自動推論されるため、ここで明示的にexportして利用可能にする
export type { CheckId, WorkerId } from './branded.ts';

/**
 * タスク状態の定数定義
 *
 * - READY: 実行可能（Workerが割り当て待ち）
 * - RUNNING: Worker実行中
 * - NEEDS_CONTINUATION: 実行済みだが継続が必要（Judgeが不完全と判定）
 * - DONE: 完了
 * - SKIPPED: 既に実装済みのためスキップ（Judgeが判定）
 * - BLOCKED: エラーや依存関係により実行不可
 * - CANCELLED: ユーザーによる中断
 * - REPLACED_BY_REPLAN: 再計画により新タスクに置き換えられた
 */
export const TaskState = {
  READY: 'READY',
  RUNNING: 'RUNNING',
  NEEDS_CONTINUATION: 'NEEDS_CONTINUATION',
  DONE: 'DONE',
  SKIPPED: 'SKIPPED',
  BLOCKED: 'BLOCKED',
  CANCELLED: 'CANCELLED',
  REPLACED_BY_REPLAN: 'REPLACED_BY_REPLAN',
} as const;

export type TaskState = (typeof TaskState)[keyof typeof TaskState];

/**
 * Worker Feedback Type
 *
 * Worker がタスク実行後に報告するフィードバックの種類
 *
 * - implementation: 実装タスクの結果報告
 * - exploration: 調査・探索タスクの結果報告
 * - difficulty: 実行困難・障害の報告
 */
export const WorkerFeedbackType = {
  IMPLEMENTATION: 'implementation',
  EXPLORATION: 'exploration',
  DIFFICULTY: 'difficulty',
} as const;

export type WorkerFeedbackType =
  (typeof WorkerFeedbackType)[keyof typeof WorkerFeedbackType];

/**
 * Impediment Category
 *
 * Worker が実行困難に遭遇した際の障害カテゴリ
 *
 * - technical: 技術的問題（バグ、API制限、ツールの問題など）
 * - ambiguity: 要件の曖昧さ（仕様が不明確、判断基準が不明など）
 * - scope: スコープの問題（想定外の作業範囲、追加の依存など）
 * - dependency: 依存関係の問題（他タスクの未完了、外部サービス依存など）
 */
export const ImpedimentCategory = {
  TECHNICAL: 'technical',
  AMBIGUITY: 'ambiguity',
  SCOPE: 'scope',
  DEPENDENCY: 'dependency',
} as const;

export type ImpedimentCategory =
  (typeof ImpedimentCategory)[keyof typeof ImpedimentCategory];

/**
 * Requested Action
 *
 * Worker が障害に対して要求するアクション
 *
 * - clarification: 要件の明確化を求める
 * - replan: タスクの再計画を求める
 * - escalate: 上位へのエスカレーションを求める
 * - continue: 継続実行を試みる
 */
export const RequestedAction = {
  CLARIFICATION: 'clarification',
  REPLAN: 'replan',
  ESCALATE: 'escalate',
  CONTINUE: 'continue',
} as const;

export type RequestedAction = (typeof RequestedAction)[keyof typeof RequestedAction];

/**
 * Worker Feedback Schema
 *
 * Worker がタスク実行後に報告する詳細なフィードバック
 * Leader が次のアクションを決定する際に使用
 */
export const WorkerFeedbackSchema = z.discriminatedUnion('type', [
  // Implementation feedback: 実装タスクの結果
  z.object({
    type: z.literal(WorkerFeedbackType.IMPLEMENTATION),
    result: z.enum(['success', 'partial', 'failed']),
    changes: z.array(z.string()),
    notes: z.string().optional(),
  }),
  // Exploration feedback: 調査・探索タスクの結果
  z.object({
    type: z.literal(WorkerFeedbackType.EXPLORATION),
    findings: z.string(),
    recommendations: z.array(z.string()),
    confidence: z.enum(['high', 'medium', 'low']),
  }),
  // Difficulty feedback: 実行困難・障害の報告
  z.object({
    type: z.literal(WorkerFeedbackType.DIFFICULTY),
    issue: z.string(),
    attempts: z.array(z.string()),
    impediment: z.object({
      category: z.enum([
        ImpedimentCategory.TECHNICAL,
        ImpedimentCategory.AMBIGUITY,
        ImpedimentCategory.SCOPE,
        ImpedimentCategory.DEPENDENCY,
      ]),
      requestedAction: z.enum([
        RequestedAction.CLARIFICATION,
        RequestedAction.REPLAN,
        RequestedAction.ESCALATE,
        RequestedAction.CONTINUE,
      ]),
    }),
    suggestion: z.string().optional(),
  }),
]);

export type WorkerFeedback = z.infer<typeof WorkerFeedbackSchema>;

/**
 * BLOCKED状態の理由
 *
 * WHY: BLOCKED理由を細分化することで、統合ブランチからの再試行可否を判定できる
 *
 * - MAX_RETRIES: 元ブランチでの継続実行の回数上限（統合ブランチから再試行可能）
 * - MAX_RETRIES_INTEGRATION: 統合ブランチからも失敗（手動介入が必要）
 * - CONFLICT: マージコンフリクト（手動介入が必要）
 * - SYSTEM_ERROR_TRANSIENT: 一時的システムエラー（ネットワーク等、再試行可能）
 * - SYSTEM_ERROR_PERMANENT: 永続的システムエラー（ディスク満杯等、手動介入が必要）
 * - MANUAL: ユーザーが手動でブロック（手動介入が必要）
 * - UNKNOWN: マイグレーション用（既存データ、手動介入が必要）
 */
export const BlockReason = {
  MAX_RETRIES: 'MAX_RETRIES',
  MAX_RETRIES_INTEGRATION: 'MAX_RETRIES_INTEGRATION',
  CONFLICT: 'CONFLICT',
  SYSTEM_ERROR_TRANSIENT: 'SYSTEM_ERROR_TRANSIENT',
  SYSTEM_ERROR_PERMANENT: 'SYSTEM_ERROR_PERMANENT',
  MANUAL: 'MANUAL',
  UNKNOWN: 'UNKNOWN',
} as const;

export type BlockReason = (typeof BlockReason)[keyof typeof BlockReason];

/**
 * Taskのスキーマ定義（Zod）
 *
 * CAS（Compare-And-Swap）並行制御のため、versionフィールドが必須
 */
export const TaskSchema = z.object({
  /** タスクID（ユニーク識別子） */
  id: z.string().transform(taskId),

  /** 現在の状態 */
  state: z.enum([
    TaskState.READY,
    TaskState.RUNNING,
    TaskState.NEEDS_CONTINUATION,
    TaskState.DONE,
    TaskState.SKIPPED,
    TaskState.BLOCKED,
    TaskState.CANCELLED,
    TaskState.REPLACED_BY_REPLAN,
  ]),

  /** 楽観的ロック用バージョン番号（CAS制御） */
  version: z.number().int().nonnegative(),

  /** タスクを実行するエージェントの所有者（例: "planner", "worker-1"） */
  owner: z
    .string()
    .nullable()
    .transform((val) => (val === null ? null : workerId(val))),

  /** タスクが作業するリポジトリパス */
  repo: z.string().transform(repoPath),

  /** タスク専用のブランチ名 */
  branch: z.string().transform(branchName),

  /** タスクのスコープ（対象ファイルパス配列） */
  scopePaths: z.array(z.string()),

  /** 受け入れ基準（完了判定条件のテキスト） */
  acceptance: z.string(),

  /** タスクタイプ */
  taskType: z.enum(['implementation', 'documentation', 'investigation', 'integration']),

  /** タスク実行に必要なコンテキスト情報 */
  context: z.string(),

  /** 依存するタスクIDの配列（このタスクを実行する前に完了が必要なタスク） */
  dependencies: z.array(z.string().transform(taskId)).default([]),

  /** CI/Lintチェック結果への参照（checkId） */
  check: z
    .string()
    .nullable()
    .transform((val) => (val === null ? null : checkId(val))),

  /** タスク作成日時 */
  createdAt: z.string().datetime(),

  /** タスク更新日時 */
  updatedAt: z.string().datetime(),

  /** タスクの30文字程度のサマリ（ログ出力用） */
  summary: z.string().max(50).nullable().optional(),

  /**
   * エージェントセッション/スレッドID
   *
   * WHY: セッション単位でのタスク検索・集計を可能にする
   * WHY: 同一タスクの連続実行でセッション/スレッドを継続するため
   * - Claude実行時: sessionId を保存
   * - Codex実行時: threadId を保存
   */
  sessionId: z.string().nullable().optional(),

  /**
   * 親セッションID（continue時）
   *
   * WHY: `agent continue` で追加タスクを生成した場合、元のセッションを参照可能にする
   */
  parentSessionId: z.string().nullable().optional(),

  /**
   * ルートセッションID（集計単位）
   *
   * WHY: 複数のcontinueを経ても、元のセッションチェーンを追跡可能にする
   */
  rootSessionId: z.string().nullable().optional(),

  /** プランナーのログファイルパス（絶対パス、オプショナル） */
  plannerLogPath: z.string().nullable().optional(),

  /** プランナーのメタデータファイルパス（絶対パス、オプショナル） */
  plannerMetadataPath: z.string().nullable().optional(),

  /** 最新のWorker実行RunID（継続実行や参照用に使用） */
  latestRunId: z.string().nullable().optional(),

  /** Judge判定フィードバック（継続実行用） */
  judgementFeedback: z
    .object({
      /** 現在のリトライ回数（0から開始） */
      iteration: z.number().int().nonnegative(),
      /** 最大リトライ回数 */
      maxIterations: z.number().int().positive(),
      /** 最後の判定結果 */
      lastJudgement: z.object({
        reason: z.string(),
        missingRequirements: z.array(z.string()),
        evaluatedAt: z.string().datetime(),
      }),
    })
    .nullable()
    .optional(),

  /**
   * Worker フィードバック（Leader セッション用）
   *
   * WHY: Leader が Worker の実行結果を詳細に把握し、適切な次アクションを決定するため
   *      - 実装タスクの成功/部分成功/失敗の詳細
   *      - 探索タスクの発見事項と推奨事項
   *      - 実行困難時の障害カテゴリと要求アクション
   */
  workerFeedback: WorkerFeedbackSchema.nullable().optional(),

  /** コンフリクト解消待ちの情報（BLOCKED状態時のみ） */
  pendingConflictResolution: z
    .object({
      /** コンフリクト解消タスクID */
      conflictTaskId: z.string().transform(taskId),
      /** 一時マージブランチ名 */
      tempBranch: z.string().transform(branchName),
    })
    .nullable()
    .optional(),

  /** Planner再評価情報（REPLACED_BY_REPLAN状態時の追跡用） */
  replanningInfo: z
    .object({
      /** 現在の再計画イテレーション回数 */
      iteration: z.number().int().nonnegative(),
      /** 最大再計画イテレーション回数 */
      maxIterations: z.number().int().nonnegative(),
      /** 最初のタスクID（再計画の連鎖を追跡） */
      originalTaskId: z.string().transform(taskId).optional(),
      /** 置き換え先の新タスクIDリスト */
      replacedBy: z.array(z.string().transform(taskId)).optional(),
      /** 再計画の理由 */
      replanReason: z.string().optional(),
    })
    .nullable()
    .optional(),

  /** BLOCKED理由（Phase 1: 未完了タスク再実行機能） */
  blockReason: z.nativeEnum(BlockReason).optional().nullable(),

  /** BLOCKED理由の詳細メッセージ（Phase 1: 未完了タスク再実行機能） */
  blockMessage: z.string().optional().nullable(),

  /** SKIPPED理由（既に実装済みの場合のスキップ理由） */
  skipReason: z.string().optional().nullable(),

  /** 統合ブランチからの再試行済みフラグ（Phase 1: 未完了タスク再実行機能） */
  integrationRetried: z.boolean().default(false),

  /**
   * Worker の作業開始時点のベースコミットハッシュ
   *
   * WHY: Judge が Worker の変更を正確に検出するために使用
   * - worktree 作成直後（複数依存の場合はマージ完了後）のコミットハッシュを記録
   * - `baseCommit..HEAD` で Worker が実際に行った変更のみを取得できる
   */
  baseCommit: z.string().nullable().optional(),
});

/**
 * Task型定義（TypeScript型）
 */
export type Task = z.infer<typeof TaskSchema>;

/**
 * 新規Taskの初期値生成ヘルパー
 */
export function createInitialTask(params: {
  id: TaskId;
  repo: RepoPath;
  branch: BranchName;
  scopePaths: string[];
  acceptance: string;
  taskType: 'implementation' | 'documentation' | 'investigation' | 'integration';
  context: string;
  dependencies?: TaskId[];
  summary?: string | null;
  sessionId?: string | null;
  parentSessionId?: string | null;
  rootSessionId?: string | null;
  plannerLogPath?: string | null;
  plannerMetadataPath?: string | null;
}): Task {
  const now = new Date().toISOString();
  return {
    id: params.id,
    state: TaskState.READY,
    version: 0,
    owner: null,
    repo: params.repo,
    branch: params.branch,
    scopePaths: params.scopePaths,
    acceptance: params.acceptance,
    taskType: params.taskType,
    context: params.context,
    dependencies: params.dependencies ?? [],
    check: null,
    createdAt: now,
    updatedAt: now,
    summary: params.summary ?? null,
    sessionId: params.sessionId ?? null,
    parentSessionId: params.parentSessionId ?? null,
    rootSessionId: params.rootSessionId ?? null,
    plannerLogPath: params.plannerLogPath ?? null,
    plannerMetadataPath: params.plannerMetadataPath ?? null,
    latestRunId: null,
    integrationRetried: false,
  };
}
