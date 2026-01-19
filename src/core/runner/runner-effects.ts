/**
 * RunnerEffects インターフェース
 *
 * エージェント実行とログ記録の副作用を抽象化するインターフェース。
 * すべての操作は Result<T, RunnerError> を返し、エラーハンドリングを統一する。
 */

import type { Result } from 'option-t/plain_result';
import type { RunnerError } from '../../types/errors.ts';
import type { Run } from '../../types/run.ts';

/**
 * エージェント出力
 */
export interface AgentOutput {
  /** 最終的なレスポンス */
  readonly finalResponse?: string;
  /** 実行アイテム（Codexの場合） */
  readonly items?: unknown[];
  /** Thread ID（Codexの場合） */
  readonly threadId?: string;
}

/**
 * RunnerEffects インターフェース
 *
 * エージェント実行とログ操作の副作用を抽象化。テスト時にはモックで置き換え可能。
 */
export interface RunnerEffects {
  // ===== エージェント実行 =====

  /**
   * Claude エージェントを実行
   * @param prompt プロンプト文字列
   * @param workingDirectory 作業ディレクトリ
   * @param model 使用するモデル
   * @returns エージェント出力
   */
  runClaudeAgent(
    prompt: string,
    workingDirectory: string,
    model: string,
  ): Promise<Result<AgentOutput, RunnerError>>;

  /**
   * Codex エージェントを実行
   * @param prompt プロンプト文字列
   * @param workingDirectory 作業ディレクトリ
   * @param model 使用するモデル（省略時はCodexのデフォルト）
   * @returns エージェント出力
   */
  runCodexAgent(
    prompt: string,
    workingDirectory: string,
    model?: string,
  ): Promise<Result<AgentOutput, RunnerError>>;

  // ===== ログ記録 =====

  /**
   * runs ディレクトリが存在することを保証
   */
  ensureRunsDir(): Promise<Result<void, RunnerError>>;

  /**
   * ログにコンテンツを追記
   * @param runId Run ID（文字列形式）
   * @param content 追記するコンテンツ
   */
  appendLog(runId: string, content: string): Promise<Result<void, RunnerError>>;

  /**
   * Run メタデータを保存
   * @param run Run オブジェクト
   */
  saveRunMetadata(run: Run): Promise<Result<void, RunnerError>>;

  /**
   * Run メタデータを読み込み
   * @param runId Run ID（文字列形式）
   * @returns Run オブジェクト（存在しない場合はエラー）
   */
  loadRunMetadata(runId: string): Promise<Result<Run, RunnerError>>;

  /**
   * ログファイル全体を読み込み
   * @param runId Run ID（文字列形式）
   * @returns ログ内容（存在しない場合はエラー）
   */
  readLog(runId: string): Promise<Result<string, RunnerError>>;

  /**
   * すべてのログファイル名を一覧取得
   * @returns ログファイル名の配列（拡張子.logを含む）
   */
  listRunLogs(): Promise<Result<string[], RunnerError>>;
}
