import { Codex } from '@openai/codex-sdk';
import type { Task } from '../../types/task.ts';
import type { LogWriter } from './log-writer.ts';
import { createInitialRun, RunStatus } from '../../types/run.ts';

/**
 * Codex実行オプション
 */
export interface CodexRunnerOptions {
  /** agent-coord repoのベースパス */
  coordRepoPath: string;
  /** ログライター */
  logWriter: LogWriter;
  /** タイムアウト（ミリ秒）。0でタイムアウトなし */
  timeout?: number;
}

/**
 * Codex実行結果
 */
export interface CodexRunResult {
  /** 実行ID */
  runId: string;
  /** Thread ID（Codex Thread永続化用） */
  threadId?: string;
  /** 成功したか */
  success: boolean;
  /** エラーメッセージ（失敗時） */
  error?: string;
  /** 実行時間（ミリ秒） */
  duration: number;
}

/**
 * Codex実行クラス
 *
 * @openai/codex-sdk を使用してエージェントを実行する。
 */
export class CodexRunner {
  private options: CodexRunnerOptions;
  private codex: Codex;

  constructor(options: CodexRunnerOptions) {
    this.options = options;
    // Codex SDKの初期化
    this.codex = new Codex();
  }

  /**
   * タスクに基づいてCodexエージェントを実行
   *
   * @param task 実行するタスク
   * @param workingDirectory エージェントの作業ディレクトリ
   * @returns 実行結果
   */
  async runTask(task: Task, workingDirectory: string): Promise<CodexRunResult> {
    const startTime = Date.now();
    const runId = `codex-${task.id}-${Date.now()}`;

    // 初期Run情報を作成
    const run = createInitialRun({
      id: runId,
      taskId: task.id,
      agentType: 'codex',
      logPath: `runs/${runId}.log`,
    });

    const logWriter = this.options.logWriter;
    await logWriter.ensureRunsDir();
    await logWriter.saveRunMetadata(run);

    let threadId: string | undefined;

    try {
      // プロンプト構築
      const prompt = this.buildPrompt(task);

      // ログ開始
      await logWriter.appendLog(runId, `=== Codex Agent Execution Start ===\n`);
      await logWriter.appendLog(runId, `Task ID: ${task.id}\n`);
      await logWriter.appendLog(runId, `Working Directory: ${workingDirectory}\n`);
      await logWriter.appendLog(runId, `Prompt: ${prompt}\n\n`);

      // Codex Thread作成
      const thread = this.codex.startThread({
        workingDirectory,
        // skipGitRepoCheck: true, // 必要に応じて設定
      });
      threadId = thread.id ?? undefined;

      await logWriter.appendLog(runId, `Thread ID: ${threadId}\n\n`);

      // Codex実行
      const turn = await thread.run(prompt);

      // 実行ログ記録
      await logWriter.appendLog(runId, `\n=== Execution Result ===\n`);
      await logWriter.appendLog(runId, `Final Response: ${turn.finalResponse}\n`);
      await logWriter.appendLog(runId, `Items: ${JSON.stringify(turn.items, null, 2)}\n`);
      await logWriter.appendLog(runId, `\n=== Codex Agent Execution Complete ===\n`);

      // Run情報を更新
      const duration = Date.now() - startTime;
      run.status = RunStatus.SUCCESS;
      run.finishedAt = new Date().toISOString();
      await logWriter.saveRunMetadata(run);

      return {
        runId,
        threadId,
        success: true,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // エラーログ記録
      await logWriter.appendLog(runId, `\n=== Error ===\n`);
      await logWriter.appendLog(runId, errorMessage);
      await logWriter.appendLog(runId, `\n=== Codex Agent Execution Failed ===\n`);

      // Run情報を更新
      run.status = RunStatus.FAILURE;
      run.finishedAt = new Date().toISOString();
      run.errorMessage = errorMessage;
      await logWriter.saveRunMetadata(run);

      return {
        runId,
        threadId,
        success: false,
        error: errorMessage,
        duration,
      };
    }
  }

  /**
   * タスク情報からプロンプトを構築
   *
   * @param task タスク情報
   * @returns プロンプト文字列
   */
  private buildPrompt(task: Task): string {
    // scopePaths がある場合は関連ファイルを指定
    const scopeInfo =
      task.scopePaths.length > 0 ? `\n関連ファイル: ${task.scopePaths.join(', ')}` : '';

    // 受け入れ条件がある場合は含める
    const acceptanceInfo = task.acceptance ? `\n受け入れ条件: ${task.acceptance}` : '';

    return `タスク: ${task.id}${scopeInfo}${acceptanceInfo}

実装してください。`;
  }
}
