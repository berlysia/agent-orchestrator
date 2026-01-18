import { unstable_v2_prompt } from '@anthropic-ai/claude-agent-sdk';
import type { Task } from '../../types/task.ts';
import type { LogWriter } from './log-writer.ts';
import { createInitialRun, RunStatus } from '../../types/run.ts';

/**
 * Claude Agent実行オプション
 */
export interface ClaudeRunnerOptions {
  /** agent-coord repoのベースパス */
  coordRepoPath: string;
  /** ログライター */
  logWriter: LogWriter;
  /** タイムアウト（ミリ秒）。0でタイムアウトなし */
  timeout?: number;
  /** 使用するモデル（デフォルト: claude-sonnet-4-5-20250929） */
  model?: string;
}

/**
 * Claude Agent実行結果
 */
export interface ClaudeRunResult {
  /** 実行ID */
  runId: string;
  /** 成功したか */
  success: boolean;
  /** エラーメッセージ（失敗時） */
  error?: string;
  /** 実行時間（ミリ秒） */
  duration: number;
}

/**
 * Claude Agent実行クラス
 *
 * @anthropic-ai/claude-agent-sdk の unstable_v2_prompt を使用してエージェントを実行する。
 */
export class ClaudeRunner {
  private options: ClaudeRunnerOptions;

  constructor(options: ClaudeRunnerOptions) {
    this.options = options;
  }

  /**
   * タスクに基づいてClaudeエージェントを実行
   *
   * @param task 実行するタスク
   * @param workingDirectory エージェントの作業ディレクトリ
   * @returns 実行結果
   */
  async runTask(task: Task, workingDirectory: string): Promise<ClaudeRunResult> {
    const startTime = Date.now();
    const runId = `claude-${task.id}-${Date.now()}`;

    // 初期Run情報を作成
    const run = createInitialRun({
      id: runId,
      taskId: task.id,
      agentType: 'claude',
      logPath: `runs/${runId}.log`,
    });

    const logWriter = this.options.logWriter;
    await logWriter.ensureRunsDir();
    await logWriter.saveRunMetadata(run);

    try {
      // プロンプト構築
      const prompt = this.buildPrompt(task);

      // ログ開始
      await logWriter.appendLog(runId, `=== Claude Agent Execution Start ===\n`);
      await logWriter.appendLog(runId, `Task ID: ${task.id}\n`);
      await logWriter.appendLog(runId, `Working Directory: ${workingDirectory}\n`);
      await logWriter.appendLog(runId, `Prompt: ${prompt}\n\n`);

      // Claude Agent実行（unstable_v2_prompt使用）
      const result = await unstable_v2_prompt(prompt, {
        model: this.options.model || 'claude-sonnet-4-5-20250929',
        // workingDirectoryは環境変数やプロセスのcwdで制御する必要がある
        // SDKが直接workingDirectoryをサポートしていない場合は、
        // プロセス起動前にprocess.chdir()を使用するか、
        // env経由でCLIに渡す必要がある
      });

      // 実行ログ記録
      await logWriter.appendLog(runId, `\n=== Execution Result ===\n`);
      await logWriter.appendLog(runId, JSON.stringify(result, null, 2));
      await logWriter.appendLog(runId, `\n=== Claude Agent Execution Complete ===\n`);

      // Run情報を更新
      const duration = Date.now() - startTime;
      run.status = RunStatus.SUCCESS;
      run.finishedAt = new Date().toISOString();
      await logWriter.saveRunMetadata(run);

      return {
        runId,
        success: true,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // エラーログ記録
      await logWriter.appendLog(runId, `\n=== Error ===\n`);
      await logWriter.appendLog(runId, errorMessage);
      await logWriter.appendLog(runId, `\n=== Claude Agent Execution Failed ===\n`);

      // Run情報を更新
      run.status = RunStatus.FAILURE;
      run.finishedAt = new Date().toISOString();
      run.errorMessage = errorMessage;
      await logWriter.saveRunMetadata(run);

      return {
        runId,
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
