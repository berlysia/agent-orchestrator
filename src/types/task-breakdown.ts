import { z } from 'zod';

/**
 * タスクタイプの定数定義
 *
 * Planner がタスクを分類するために使用
 *
 * - IMPLEMENTATION: 実装タスク（コード変更を伴う）
 * - DOCUMENTATION: ドキュメントタスク（README、コメント等）
 * - INVESTIGATION: 調査タスク（コード調査、設計検討等）
 * - INTEGRATION: 統合タスク（複数ブランチのマージ等）
 */
export const TaskTypeEnum = {
  IMPLEMENTATION: 'implementation',
  DOCUMENTATION: 'documentation',
  INVESTIGATION: 'investigation',
  INTEGRATION: 'integration',
} as const;

export type TaskType = (typeof TaskTypeEnum)[keyof typeof TaskTypeEnum];

/**
 * タスク分解情報のZodスキーマ（エージェントが返すべき形式）
 *
 * WHY: 厳格なバリデーションによりエージェント出力の品質を保証
 */
export const TaskBreakdownSchema = z.object({
  /**
   * タスクID（Planner段階で割り当てる）
   *
   * WHY: "task-N" 形式（N >= 1）を強制することで、セッションIDとの混同を防ぐ
   * 例: "task-1", "task-2", "task-10" は有効
   * 例: "task-0", "task-0d6ed7f4", "1", "task" は無効
   */
  id: z.string().regex(/^task-[1-9]\d*$/, 'Task ID must be in format "task-1", "task-2", etc. (starting from 1)'),
  /** タスクの説明 */
  description: z.string().min(1, 'description must not be empty'),
  /** ブランチ名 */
  branch: z.string().min(1, 'branch must not be empty'),
  /** スコープパス */
  scopePaths: z.array(z.string()).min(1, 'scopePaths must contain at least one path'),
  /** 受け入れ基準 */
  acceptance: z.string().min(1, 'acceptance must not be empty'),
  /** タスクタイプ（必須） */
  type: z.enum([
    TaskTypeEnum.IMPLEMENTATION,
    TaskTypeEnum.DOCUMENTATION,
    TaskTypeEnum.INVESTIGATION,
    TaskTypeEnum.INTEGRATION,
  ]),
  /** 見積もり時間（時間単位、0.5-8時間の範囲） */
  estimatedDuration: z.number().min(0.5).max(8),
  /** タスク実行に必要なコンテキスト情報（必須） */
  context: z.string().min(1, 'context must not be empty'),
  /**
   * 依存するタスクIDの配列（このタスクを実行する前に完了が必要なタスクのID）
   *
   * WHY: 依存関係も "task-N" 形式（N >= 1）を強制して一貫性を確保
   */
  dependencies: z
    .array(z.string().regex(/^task-[1-9]\d*$/, 'Dependency ID must be in format "task-1", "task-2", etc. (starting from 1)'))
    .default([]),
  /** タスクの30文字程度のサマリ（ログ出力用） */
  summary: z.string().max(50).optional(),
});

/**
 * タスク分解情報（TypeScript型）
 */
export type TaskBreakdown = z.infer<typeof TaskBreakdownSchema>;
