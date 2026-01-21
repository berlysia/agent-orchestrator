/**
 * ログ出力用のユーティリティ関数
 */

/**
 * サマリを30文字以内に切り詰める
 * 30文字を超える場合は"..."で省略
 *
 * @param summary - サマリ文字列（nullableも許容）
 * @returns 30文字以内のサマリ文字列
 */
export function truncateSummary(summary: string | null | undefined): string {
  if (!summary) {
    return '';
  }

  const maxLength = 30;
  if (summary.length <= maxLength) {
    return summary;
  }

  return summary.slice(0, maxLength) + '...';
}
