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

/**
 * Judge用に実行ログを切り詰める
 *
 * WHY: 600KB超のログをJudgeエージェント（claude-haiku）に渡すと、
 * 適切なJSON出力を生成できなくなる（no_jsonエラー）。
 * 末尾部分が最も重要な結果情報を含むため、末尾を優先して保持する。
 *
 * @param log - 実行ログ全体
 * @param maxBytes - 最大バイト数（デフォルト: 150KB）
 * @returns 切り詰められたログ（先頭部分を省略、末尾を保持）
 */
export function truncateLogForJudge(log: string, maxBytes: number = 150 * 1024): string {
  const logBytes = Buffer.byteLength(log, 'utf-8');

  if (logBytes <= maxBytes) {
    return log;
  }

  // 先頭から一定量を保持（ヘッダー情報用）
  const headerBytes = 10 * 1024; // 10KB
  const tailBytes = maxBytes - headerBytes;

  // バイト単位で切り出すため、文字境界に注意
  const headerPart = truncateToByteLength(log, headerBytes);
  const tailPart = truncateFromEndToByteLength(log, tailBytes);

  const truncatedBytes = logBytes - maxBytes;
  const truncatedKB = Math.round(truncatedBytes / 1024);

  return `${headerPart}

... [${truncatedKB}KB truncated for Judge evaluation] ...

${tailPart}`;
}

/**
 * 文字列を指定バイト数以内に切り詰める（先頭から）
 */
function truncateToByteLength(str: string, maxBytes: number): string {
  let byteCount = 0;
  let charIndex = 0;

  for (const char of str) {
    const charBytes = Buffer.byteLength(char, 'utf-8');
    if (byteCount + charBytes > maxBytes) {
      break;
    }
    byteCount += charBytes;
    charIndex += char.length;
  }

  return str.slice(0, charIndex);
}

/**
 * 文字列を指定バイト数以内に切り詰める（末尾から）
 */
function truncateFromEndToByteLength(str: string, maxBytes: number): string {
  // 末尾から逆順に探索
  const chars = [...str];
  let byteCount = 0;
  let startIndex = chars.length;

  for (let i = chars.length - 1; i >= 0; i--) {
    const charBytes = Buffer.byteLength(chars[i]!, 'utf-8');
    if (byteCount + charBytes > maxBytes) {
      break;
    }
    byteCount += charBytes;
    startIndex = i;
  }

  // 元の文字列のインデックスに変換
  let charPosition = 0;
  for (let i = 0; i < startIndex; i++) {
    charPosition += chars[i]!.length;
  }

  return str.slice(charPosition);
}
