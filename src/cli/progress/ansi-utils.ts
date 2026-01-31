/**
 * ANSI Escape Sequence Utilities
 *
 * ADR-012: CLI進捗表示機能
 *
 * ターミナル制御用のANSIエスケープシーケンス。
 * - 色付け
 * - カーソル制御
 * - 進捗バー描画
 * - スピナーアニメーション
 */

/**
 * ANSIエスケープシーケンス定数
 */
export const ANSI = {
  // カーソル制御
  HIDE_CURSOR: '\x1b[?25l',
  SHOW_CURSOR: '\x1b[?25h',
  CURSOR_UP: (n: number) => `\x1b[${n}A`,
  CURSOR_DOWN: (n: number) => `\x1b[${n}B`,
  CURSOR_TO_COLUMN: (n: number) => `\x1b[${n}G`,
  CURSOR_TO_START: '\x1b[0G',
  CLEAR_LINE: '\x1b[2K',
  CLEAR_TO_END: '\x1b[0K',

  // 色（フォアグラウンド）
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  BLACK: '\x1b[30m',
  RED: '\x1b[31m',
  GREEN: '\x1b[32m',
  YELLOW: '\x1b[33m',
  BLUE: '\x1b[34m',
  MAGENTA: '\x1b[35m',
  CYAN: '\x1b[36m',
  WHITE: '\x1b[37m',
  GRAY: '\x1b[90m',

  // 背景色
  BG_BLACK: '\x1b[40m',
  BG_RED: '\x1b[41m',
  BG_GREEN: '\x1b[42m',
  BG_YELLOW: '\x1b[43m',
  BG_BLUE: '\x1b[44m',
} as const;

/**
 * スピナーフレーム（ブレイル点字パターン）
 */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * 進捗バー文字
 */
export const PROGRESS_BAR = {
  FILLED: '█',
  EMPTY: '░',
  LEFT_CAP: '',
  RIGHT_CAP: '',
} as const;

/**
 * ステータスアイコン
 */
export const STATUS_ICONS = {
  SUCCESS: '✅',
  FAILURE: '❌',
  WARNING: '⚠️',
  INFO: 'ℹ️',
  RUNNING: '🔄',
  PENDING: '⏳',
  BLOCKED: '🚫',
} as const;

/**
 * ANSIが有効かどうかを判定
 *
 * @param stream 出力ストリーム
 * @returns ANSIが有効な場合true
 */
export function isAnsiEnabled(stream: NodeJS.WriteStream): boolean {
  // TTYでない場合は無効
  if (!stream.isTTY) {
    return false;
  }

  // NO_COLOR環境変数が設定されている場合は無効
  if (process.env['NO_COLOR'] !== undefined) {
    return false;
  }

  // FORCE_COLOR環境変数が設定されている場合は有効
  if (process.env['FORCE_COLOR'] !== undefined) {
    return true;
  }

  return true;
}

/**
 * テキストに色を付ける
 *
 * @param text テキスト
 * @param color 色コード
 * @param useAnsi ANSIを使用するか
 * @returns 色付きテキスト
 */
export function colorize(text: string, color: string, useAnsi: boolean): string {
  if (!useAnsi) {
    return text;
  }
  return `${color}${text}${ANSI.RESET}`;
}

/**
 * テキストを太字にする
 *
 * @param text テキスト
 * @param useAnsi ANSIを使用するか
 * @returns 太字テキスト
 */
export function bold(text: string, useAnsi: boolean): string {
  if (!useAnsi) {
    return text;
  }
  return `${ANSI.BOLD}${text}${ANSI.RESET}`;
}

/**
 * テキストを薄くする
 *
 * @param text テキスト
 * @param useAnsi ANSIを使用するか
 * @returns 薄いテキスト
 */
export function dim(text: string, useAnsi: boolean): string {
  if (!useAnsi) {
    return text;
  }
  return `${ANSI.DIM}${text}${ANSI.RESET}`;
}

/**
 * 進捗バーを描画
 *
 * @param progress 進捗（0-1）
 * @param width バーの幅（文字数）
 * @param useAnsi ANSIを使用するか
 * @returns 進捗バー文字列
 */
export function renderProgressBar(
  progress: number,
  width: number,
  useAnsi: boolean,
): string {
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const filledWidth = Math.round(clampedProgress * width);
  const emptyWidth = width - filledWidth;

  const filled = PROGRESS_BAR.FILLED.repeat(filledWidth);
  const empty = PROGRESS_BAR.EMPTY.repeat(emptyWidth);

  if (useAnsi) {
    return (
      colorize(filled, ANSI.GREEN, true) +
      colorize(empty, ANSI.GRAY, true)
    );
  }

  return filled + empty;
}

/**
 * スピナーフレームを取得
 *
 * @param frameIndex フレームインデックス
 * @returns スピナー文字
 */
export function getSpinnerFrame(frameIndex: number): string {
  const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
  return frame ?? SPINNER_FRAMES[0] ?? '⠋';
}

/**
 * 時刻をフォーマット
 *
 * @param date 日時
 * @returns HH:MM:SS形式の文字列
 */
export function formatTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

/**
 * 経過時間をフォーマット
 *
 * @param startTime 開始時刻
 * @param endTime 終了時刻（省略時は現在）
 * @returns 経過時間文字列（例: "1m 23s"）
 */
export function formatElapsed(startTime: Date, endTime: Date = new Date()): string {
  const elapsedMs = endTime.getTime() - startTime.getTime();
  const seconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${seconds}s`;
}

/**
 * 文字列を指定幅に切り詰める
 *
 * @param text テキスト
 * @param maxWidth 最大幅
 * @param ellipsis 省略記号
 * @returns 切り詰められたテキスト
 */
export function truncate(text: string, maxWidth: number, ellipsis = '...'): string {
  if (text.length <= maxWidth) {
    return text;
  }
  return text.slice(0, maxWidth - ellipsis.length) + ellipsis;
}
