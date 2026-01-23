import type { ReportData, TaskSummary, ReportEvent } from './types.ts';
import { TaskState } from '../../types/task.ts';

/**
 * ReportDataをMarkdown形式に変換する
 *
 * @param data レポートデータ
 * @returns Markdown形式の文字列
 */
export function formatReportAsMarkdown(data: ReportData): string {
  const sections: string[] = [];

  // ヘッダー
  sections.push('# 監視レポート\n');

  // 監視期間
  sections.push('## 監視期間');
  sections.push(`- 開始: ${formatDate(data.period.start)}`);
  sections.push(`- 終了: ${formatDate(data.period.end)}\n`);

  // タスク統計
  sections.push('## タスク統計');
  sections.push('| 項目 | 数 |');
  sections.push('|------|------|');
  sections.push(`| 総数 | ${data.statistics.total} |`);
  sections.push(`| 完了 | ${data.statistics.completed} |`);
  sections.push(`| 失敗 | ${data.statistics.failed} |`);
  sections.push(`| スキップ | ${data.statistics.skipped} |`);
  sections.push(`| ブロック | ${data.statistics.blocked} |\n`);

  // タスク実行サマリー
  sections.push('## タスク実行サマリー');
  if (data.taskSummaries.length === 0) {
    sections.push('- なし\n');
  } else {
    for (const task of data.taskSummaries) {
      sections.push(formatTaskSummary(task));
    }
    sections.push('');
  }

  // 観察されたイベント
  sections.push('## 観察されたイベント');

  // コンフリクトイベント
  const conflicts = data.events.filter((e) => e.type === 'CONFLICT');
  sections.push('### コンフリクト');
  if (conflicts.length === 0) {
    sections.push('- なし');
  } else {
    for (const event of conflicts) {
      sections.push(formatEvent(event));
    }
  }

  // リトライイベント
  const retries = data.events.filter((e) => e.type === 'RETRY');
  sections.push('### リトライ');
  if (retries.length === 0) {
    sections.push('- なし');
  } else {
    for (const event of retries) {
      sections.push(formatEvent(event));
    }
  }

  // タイムアウトイベント
  const timeouts = data.events.filter((e) => e.type === 'TIMEOUT');
  if (timeouts.length > 0) {
    sections.push('### タイムアウト');
    for (const event of timeouts) {
      sections.push(formatEvent(event));
    }
  }

  // 統合情報
  if (data.integration) {
    sections.push('');
    sections.push('## 統合結果');
    sections.push('- 統合ブランチ: ' + (data.integration.integrationBranch ?? '未作成'));
    sections.push('- マージ成功: ' + data.integration.mergedCount);
    sections.push('- コンフリクト: ' + data.integration.conflictCount);
    if (data.integration.conflictResolutionTaskId) {
      sections.push('- コンフリクト解決タスク: ' + data.integration.conflictResolutionTaskId);
    }
    if (data.integration.completionScore !== undefined) {
      sections.push('');
      sections.push('### 完了評価');
      sections.push('- スコア: ' + data.integration.completionScore + '%');
    }
    if (data.integration.missingAspects.length > 0) {
      sections.push('');
      sections.push('### 未達成の側面');
      for (const aspect of data.integration.missingAspects) {
        sections.push('- ' + aspect);
      }
    }
  }

  return sections.join('\n');
}

/**
 * DateをISO8601形式の文字列に変換
 *
 * @param date Date型またはISO8601文字列
 * @returns ISO8601形式の文字列
 */
function formatDate(date: Date | string): string {
  if (typeof date === 'string') {
    return date;
  }
  return date.toISOString();
}

/**
 * タスクサマリーをMarkdownリスト項目に変換
 *
 * @param task タスクサマリー
 * @returns Markdownリスト項目
 */
function formatTaskSummary(task: TaskSummary): string {
  const statusLabel = getStatusLabel(task.status);
  const durationText = task.duration !== undefined ? ` (${formatDuration(task.duration)})` : '';
  const errorText = task.error ? ` - エラー: ${task.error}` : '';

  return `- [${statusLabel}] ${task.taskId}: ${task.description}${durationText}${errorText}`;
}

/**
 * タスク状態をラベルに変換
 *
 * @param status タスク状態
 * @returns 日本語ラベル
 */
function getStatusLabel(status: string): string {
  switch (status) {
    case TaskState.DONE:
      return '完了';
    case TaskState.BLOCKED:
      return '失敗';
    case TaskState.SKIPPED:
      return 'スキップ';
    case TaskState.RUNNING:
      return '実行中';
    case TaskState.READY:
      return '待機中';
    case TaskState.NEEDS_CONTINUATION:
      return '継続待ち';
    case TaskState.CANCELLED:
      return 'キャンセル';
    case TaskState.REPLACED_BY_REPLAN:
      return '再計画';
    default:
      return status;
  }
}

/**
 * ミリ秒を人間に読みやすい形式に変換
 *
 * @param ms ミリ秒
 * @returns 人間に読みやすい時間表記
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}秒`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (remainingSeconds === 0) {
    return `${minutes}分`;
  }
  return `${minutes}分${remainingSeconds}秒`;
}

/**
 * イベントをMarkdownリスト項目に変換
 *
 * @param event レポートイベント
 * @returns Markdownリスト項目
 */
function formatEvent(event: ReportEvent): string {
  const timestamp = formatDate(event.timestamp);
  const taskInfo = event.taskId ? `${event.taskId}で` : '';
  return `- ${timestamp}: ${taskInfo}${event.details}`;
}
