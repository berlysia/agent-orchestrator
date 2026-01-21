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
 * - BLOCKED: エラーや依存関係により実行不可
 * - CANCELLED: ユーザーによる中断
 */
export const TaskState = {
  READY: 'READY',
  RUNNING: 'RUNNING',
  NEEDS_CONTINUATION: 'NEEDS_CONTINUATION',
  DONE: 'DONE',
  BLOCKED: 'BLOCKED',
  CANCELLED: 'CANCELLED',
} as const;

export type TaskState = (typeof TaskState)[keyof typeof TaskState];

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
    TaskState.BLOCKED,
    TaskState.CANCELLED,
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

  /** このタスクを生成したプランナーのID（オプショナル） */
  plannerRunId: z.string().nullable().optional(),

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
  plannerRunId?: string | null;
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
    plannerRunId: params.plannerRunId ?? null,
    plannerLogPath: params.plannerLogPath ?? null,
    plannerMetadataPath: params.plannerMetadataPath ?? null,
    latestRunId: null,
  };
}
