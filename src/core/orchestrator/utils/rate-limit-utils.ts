/**
 * Rate Limit関連のユーティリティ関数
 *
 * WHY: Rate Limitエラーの検出ロジックを共通化し、
 * Judge操作やPlanner操作で一貫した検出を行う
 */

/**
 * エラーオブジェクトからcauseを取得
 *
 * WHY: エラーはネストされていることがあるため、
 * 元のエラーを取得して詳細情報にアクセスする
 *
 * @param err エラーオブジェクト
 * @returns causeがあればcause、なければ元のエラー
 */
export const getErrorCause = (err: unknown): unknown => {
  if (err && typeof err === 'object' && 'cause' in err) {
    const cause = (err as { cause?: unknown }).cause;
    return cause ?? err;
  }
  return err;
};

/**
 * Rate Limit エラーかどうかを判定
 *
 * WHY: 複数の方法でRate Limitを構造的に検出する：
 * 1. RateLimitErrorインスタンスチェック
 * 2. HTTPステータスコード429
 * 3. error.type === 'rate_limit_error'
 *
 * @param err エラーオブジェクト
 * @returns Rate Limitエラーの場合true
 */
export const isRateLimited = (err: unknown): boolean => {
  const target = getErrorCause(err);

  // RateLimitError インスタンスチェック（最優先）
  if (target && typeof target === 'object' && target.constructor?.name === 'RateLimitError') {
    return true;
  }

  // HTTPステータスコード429チェック
  const status =
    (target as any)?.status ??
    (target as any)?.statusCode ??
    (target as any)?.response?.status ??
    (target as any)?.response?.statusCode;
  if (status === 429) {
    return true;
  }

  // error.type === 'rate_limit_error' チェック
  if ((target as any)?.error?.type === 'rate_limit_error') {
    return true;
  }
  if ((target as any)?.type === 'rate_limit_error') {
    return true;
  }

  return false;
};

/**
 * retry-after ヘッダから待機秒数を取得
 *
 * WHY: APIからのretry-after指定を尊重して待機時間を決定する
 *
 * @param err エラーオブジェクト
 * @returns 待機秒数（取得できない場合はundefined）
 */
export const getRetryAfterSeconds = (err: unknown): number | undefined => {
  const target = getErrorCause(err) as any;
  const h = target?.headers ?? target?.response?.headers;
  const v =
    typeof h?.get === 'function'
      ? h.get('retry-after')
      : typeof h === 'object' && h
        ? (h['retry-after'] ?? h['Retry-After'])
        : undefined;

  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
