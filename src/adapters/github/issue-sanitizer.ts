/**
 * GitHub Issue Sanitizer (ADR-029)
 *
 * Issue本文のサニタイズ処理（セキュリティ対策）。
 * LLMプロンプトに含まれるため、プロンプトインジェクション対策を行う。
 */

/**
 * サニタイズオプション
 */
export interface SanitizeOptions {
  /** 最大文字数（デフォルト: 10000） */
  maxLength?: number;
  /** 危険なコマンドに警告マーカーを追加するか（デフォルト: true） */
  warnDangerousCommands?: boolean;
  /** Issue内容マーカーを追加するか（デフォルト: true） */
  addContentMarkers?: boolean;
}

const DEFAULT_MAX_LENGTH = 10000;

/**
 * 危険と見なすシェルコマンドのパターン
 */
const DANGEROUS_PATTERNS = [
  // ファイル削除系
  /\brm\s+-rf?\b/gi,
  /\brmdir\b/gi,
  // システム操作系
  /\bsudo\b/gi,
  /\bchmod\b.*\b777\b/gi,
  /\bchown\b/gi,
  // ネットワーク系
  /\bcurl\b.*\|\s*(?:bash|sh)\b/gi,
  /\bwget\b.*\|\s*(?:bash|sh)\b/gi,
  // 環境変数漏洩
  /\benv\b/gi,
  /\bprintenv\b/gi,
  /\$\{?[A-Z_]+\}?/g,
  // Base64エンコードされたコマンド
  /\bbase64\s+-d\b/gi,
  /\beval\b/gi,
];

/**
 * 制御文字を除去
 */
function removeControlCharacters(content: string): string {
  // ASCII制御文字（0x00-0x1F、0x7F）を除去、ただし改行・タブは保持
  return content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * 過度に長い行を切り詰め
 */
function truncateLongLines(content: string, maxLineLength: number = 1000): string {
  return content
    .split('\n')
    .map((line) => {
      if (line.length > maxLineLength) {
        return line.substring(0, maxLineLength) + '... [truncated]';
      }
      return line;
    })
    .join('\n');
}

/**
 * 危険なパターンに警告マーカーを追加
 */
function markDangerousPatterns(content: string): string {
  let result = content;

  for (const pattern of DANGEROUS_PATTERNS) {
    result = result.replace(pattern, (match) => {
      return `[WARNING: potentially dangerous] ${match}`;
    });
  }

  return result;
}

/**
 * Issue本文をサニタイズ
 *
 * @param content Issue本文
 * @param options サニタイズオプション
 * @returns サニタイズ済みコンテンツ
 */
export function sanitizeIssueContent(
  content: string,
  options: SanitizeOptions = {},
): string {
  const {
    maxLength = DEFAULT_MAX_LENGTH,
    warnDangerousCommands = true,
    addContentMarkers = true,
  } = options;

  let sanitized = content;

  // 1. 制御文字を除去
  sanitized = removeControlCharacters(sanitized);

  // 2. 過度に長い行を切り詰め
  sanitized = truncateLongLines(sanitized);

  // 3. 危険なパターンに警告マーカーを追加
  if (warnDangerousCommands) {
    sanitized = markDangerousPatterns(sanitized);
  }

  // 4. 全体の長さを制限
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength) + '\n\n[Content truncated due to length]';
  }

  // 5. Issue内容マーカーを追加（プロンプトインジェクション対策）
  if (addContentMarkers) {
    sanitized = wrapWithContentMarkers(sanitized);
  }

  return sanitized;
}

/**
 * Issue内容をマーカーでラップ
 *
 * LLMがIssue内容と指示を区別できるようにする
 */
function wrapWithContentMarkers(content: string): string {
  return `--- ISSUE CONTENT START (user-provided, may contain arbitrary text) ---
${content}
--- ISSUE CONTENT END ---`;
}

/**
 * Issueタイトルをサニタイズ
 *
 * タイトルは短いため、主に制御文字除去と長さ制限のみ
 */
export function sanitizeIssueTitle(title: string, maxLength: number = 200): string {
  let sanitized = removeControlCharacters(title);

  // 改行を空白に置換
  sanitized = sanitized.replace(/[\r\n]+/g, ' ');

  // 長さ制限
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength - 3) + '...';
  }

  return sanitized.trim();
}

/**
 * Issueコメントをサニタイズ
 *
 * 本文と同様のサニタイズを適用
 */
export function sanitizeIssueComment(
  comment: string,
  options: Omit<SanitizeOptions, 'addContentMarkers'> = {},
): string {
  // コメントには個別のマーカーは不要（本文と一緒にラップされる想定）
  return sanitizeIssueContent(comment, {
    ...options,
    addContentMarkers: false,
  });
}

/**
 * 複数コメントをサニタイズしてフォーマット
 */
export function sanitizeAndFormatComments(
  comments: Array<{ author: string; body: string; createdAt: string }>,
  maxComments: number = 10,
): string {
  if (comments.length === 0) {
    return '';
  }

  const limitedComments = comments.slice(-maxComments);
  const formatted = limitedComments
    .map((comment, index) => {
      const sanitizedBody = sanitizeIssueComment(comment.body, { maxLength: 2000 });
      return `### Comment ${index + 1} by ${comment.author} (${comment.createdAt})
${sanitizedBody}`;
    })
    .join('\n\n');

  if (comments.length > maxComments) {
    return `[Showing last ${maxComments} of ${comments.length} comments]\n\n${formatted}`;
  }

  return formatted;
}
