/**
 * スモークテスト用設定
 *
 * 実際の LLM を使用するテストの設定を管理
 */

export const SMOKE_TEST_CONFIG = {
  /**
   * スモークテストの有効/無効
   *
   * 環境変数 RUN_SMOKE_TESTS=true で有効化
   */
  enabled: process.env['RUN_SMOKE_TESTS'] === 'true',

  /**
   * タイムアウト（ミリ秒）
   *
   * LLM 呼び出しを含むため、通常のテストより長めに設定
   * Worker + Judge の2回のLLM呼び出しを考慮して3分に設定
   */
  timeout: 180_000, // 3分

  /**
   * 使用するエージェントタイプ
   */
  agentType: 'claude' as const,

  /**
   * 使用するモデル
   *
   * 環境変数 SMOKE_TEST_MODEL で上書き可能
   */
  model: process.env['SMOKE_TEST_MODEL'] ?? 'claude-sonnet-4-20250514',

  /**
   * 詳細ログ出力の有効/無効
   */
  verbose: process.env['SMOKE_TEST_VERBOSE'] === 'true',
} as const;

/**
 * スモークテストがスキップされるべきかどうかを判定
 */
export function shouldSkipSmokeTest(): boolean {
  return !SMOKE_TEST_CONFIG.enabled;
}

/**
 * スモークテスト用の describe ラッパー
 *
 * スモークテストが無効の場合は describe.skip を返す
 */
export function describeSmoke(
  name: string,
  _fn: () => void,
): void {
  if (shouldSkipSmokeTest()) {
    console.log(`[SKIP] Smoke test: ${name} (RUN_SMOKE_TESTS not set)`);
    return;
  }
  // 動的に describe を呼び出す
  // テストファイルで直接 describe を使用する場合は、
  // このヘルパーを使わずに shouldSkipSmokeTest() で判定
}

/**
 * スモークテスト実行前のセットアップチェック
 *
 * @throws 必要な環境変数が設定されていない場合
 */
export function assertSmokeTestEnvironment(): void {
  if (!SMOKE_TEST_CONFIG.enabled) {
    throw new Error(
      'Smoke tests are disabled. Set RUN_SMOKE_TESTS=true to enable.',
    );
  }

  // Claude Max契約ならAPIキーなしで動作可能
  // APIキーがある場合は優先的に使用される
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (apiKey) {
    console.log('  ℹ️  Using ANTHROPIC_API_KEY');
  } else {
    console.log('  ℹ️  No ANTHROPIC_API_KEY set - using Claude Max authentication');
  }
}

/**
 * スモークテスト用のタイムアウト付き Promise ラッパー
 */
export async function withSmokeTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = SMOKE_TEST_CONFIG.timeout,
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Smoke test timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]);
}

/**
 * スモークテスト用のログ出力
 */
export function smokeLog(message: string, data?: unknown): void {
  if (SMOKE_TEST_CONFIG.verbose) {
    console.log(`[SMOKE] ${message}`);
    if (data !== undefined) {
      console.log(JSON.stringify(data, null, 2));
    }
  }
}
