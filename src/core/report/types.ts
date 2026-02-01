import type { TaskState } from '../../types/task.ts';

/**
 * レポートイベント種別
 *
 * - CONFLICT: マージコンフリクト発生
 * - RETRY: タスク再試行
 * - TIMEOUT: タスクタイムアウト
 */
export type ReportEventType = 'CONFLICT' | 'RETRY' | 'TIMEOUT';

/**
 * レポートイベント
 *
 * タスク実行中に発生した重要なイベントを記録
 */
export interface ReportEvent {
  /** イベント種別 */
  type: ReportEventType;
  /** イベント発生時刻 */
  timestamp: Date;
  /** 関連タスクID（オプショナル） */
  taskId?: string;
  /** イベント詳細情報 */
  details: string;
}

/**
 * タスク実行サマリー
 *
 * 個別タスクの実行結果を記録
 */
export interface TaskSummary {
  /** タスクID */
  taskId: string;
  /** タスク説明 */
  description: string;
  /** タスク状態 */
  status: TaskState;
  /** 実行時間（ミリ秒、オプショナル） */
  duration?: number;
  /** エラーメッセージ（失敗時、オプショナル） */
  error?: string;
}

/**
 * タスク統計情報
 *
 * タスク状態別の集計データ
 */
export interface TaskStatistics {
  /** 総タスク数 */
  total: number;
  /** 完了タスク数 */
  completed: number;
  /** 失敗タスク数 */
  failed: number;
  /** スキップタスク数 */
  skipped: number;
  /** ブロックタスク数 */
  blocked: number;
}

/**
 * 監視期間
 *
 * レポート対象の時間範囲
 */
export interface ReportPeriod {
  /** 開始時刻 */
  start: Date;
  /** 終了時刻 */
  end: Date;
}

/**
 * 統合情報
 *
 * ADR017で定義された統合プロセスに関する情報
 */
export interface IntegrationInfo {
  /** 統合ブランチ名（オプショナル） */
  integrationBranch?: string;
  /** マージ済みタスク数 */
  mergedCount: number;
  /** コンフリクト発生タスク数 */
  conflictCount: number;
  /** コンフリクト解決タスクID（オプショナル） */
  conflictResolutionTaskId?: string;
  /** 完了スコア（オプショナル） */
  completionScore?: number;
  /** 未完了アスペクトリスト */
  missingAspects: string[];
}

/**
 * レポートデータ
 *
 * セッション全体の実行結果を包含するデータ構造
 */
export interface ReportData {
  /** ルートセッションID（集計単位） */
  rootSessionId: string;
  /** 監視期間 */
  period: ReportPeriod;
  /** タスク統計情報 */
  statistics: TaskStatistics;
  /** タスク実行サマリー配列 */
  taskSummaries: TaskSummary[];
  /** イベント情報配列 */
  events: ReportEvent[];
  /** 統合情報（オプショナル） */
  integration?: IntegrationInfo;
}

/**
 * レポート生成インターフェース
 *
 * レポート生成とフォーマット処理を定義
 */
export interface ReportGenerator {
  /**
   * レポートデータを生成
   *
   * @param rootSessionId ルートセッションID
   * @returns レポートデータ
   */
  generate(rootSessionId: string): Promise<ReportData>;

  /**
   * レポートデータを文字列形式にフォーマット
   *
   * @param data レポートデータ
   * @returns フォーマット済み文字列
   */
  format(data: ReportData): string;
}

// ===== ADR-032: トレーサビリティレポート型定義 =====

/**
 * 明確化（質問と回答のペア）
 */
export interface Clarification {
  question: string;
  answer: string;
}

/**
 * 設計決定
 */
export interface DesignDecision {
  decision: string;
  rationale: string;
}

/**
 * Planning Reportデータ (00-planning.md)
 */
export interface PlanningReportData {
  sessionId: string;
  originalRequest: string;
  clarifications: Clarification[];
  designDecisions: DesignDecision[];
  approvedScope: string;
  createdAt: string;
}

/**
 * タスク分解項目
 */
export interface TaskBreakdownItem {
  id: string;
  title: string;
  dependencies: string[];
  priority: 'high' | 'normal' | 'low';
  taskType: 'implementation' | 'documentation' | 'investigation' | 'integration';
}

/**
 * Task Breakdown Reportデータ (01-task-breakdown.md)
 */
export interface TaskBreakdownData {
  sessionId: string;
  createdAt: string;
  tasks: TaskBreakdownItem[];
}

/**
 * ファイル変更情報
 */
export interface FileChange {
  type: 'create' | 'modify' | 'delete';
  path: string;
  description?: string;
  linesAdded?: number;
  linesRemoved?: number;
}

/**
 * Scope Reportデータ (tasks/{taskId}/00-scope.md)
 */
export interface ScopeReportData {
  taskId: string;
  title: string;
  description: string;
  plannedChanges: FileChange[];
  estimatedSize: 'small' | 'medium' | 'large';
  impactScope: string[];
}

/**
 * 実行されたコマンド
 */
export interface ExecutedCommand {
  command: string;
  status: 'success' | 'failed';
  output?: string;
}

/**
 * Execution Reportデータ (tasks/{taskId}/01-execution.md)
 */
export interface ExecutionReportData {
  taskId: string;
  workerId: string;
  startedAt: string;
  completedAt: string;
  duration: number;
  changes: FileChange[];
  commands: ExecutedCommand[];
  notes?: string;
}

/**
 * 評価アスペクト
 */
export interface EvaluationAspect {
  aspect: string;
  result: 'pass' | 'fail' | 'warning';
  notes?: string;
}

/**
 * 検出されたIssue
 */
export interface DetectedIssue {
  severity: 'error' | 'warning' | 'info';
  location?: string;
  issue: string;
  action?: string;
}

/**
 * Review Reportデータ (tasks/{taskId}/02-review.md)
 */
export interface ReviewReportData {
  taskId: string;
  verdict: 'done' | 'needs_continuation' | 'blocked' | 'skipped';
  evaluations: EvaluationAspect[];
  issues: DetectedIssue[];
  continuationGuidance?: string;
  reviewedAt: string;
}

/**
 * Deliverable（成果物）
 */
export interface Deliverable {
  type: 'create' | 'modify' | 'delete';
  path: string;
  summary: string;
}

/**
 * タスク実行結果
 */
export interface TaskExecutionResult {
  taskId: string;
  title: string;
  status: 'done' | 'blocked' | 'skipped';
  iterations: number;
}

/**
 * Summary Reportデータ (summary.md)
 */
export interface SummaryReportData {
  sessionId: string;
  originalRequest: string;
  status: 'complete' | 'partial' | 'failed';
  startedAt: string;
  completedAt: string;
  totalDuration: number;
  deliverables: Deliverable[];
  taskResults: TaskExecutionResult[];
  reviewResults: {
    judge: string;
    integration?: string;
  };
  verificationCommands: string[];
}

/**
 * 認知負荷設定
 */
export interface CognitiveLoadConfig {
  maxLines: number;
  collapseDetails: boolean;
  prioritySections: string[];
}

/**
 * レポートタイプ
 */
export type ReportType =
  | 'planning'
  | 'task-breakdown'
  | 'scope'
  | 'execution'
  | 'review'
  | 'summary';

/**
 * レポートメタデータ
 */
export interface ReportMetadata {
  type: ReportType;
  sessionId: string;
  taskId?: string;
  createdAt: string;
  filePath: string;
}
