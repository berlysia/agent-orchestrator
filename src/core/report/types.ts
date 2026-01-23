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
