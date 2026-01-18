import type { Task } from '../../types/task.ts';
import { ClaudeRunner, type ClaudeRunnerOptions, type ClaudeRunResult } from './claude-runner.ts';
import { CodexRunner, type CodexRunnerOptions, type CodexRunResult } from './codex-runner.ts';
import { LogWriter } from './log-writer.ts';

/**
 * エージェント種別
 */
export type AgentType = 'claude' | 'codex';

/**
 * Runner統合オプション
 */
export interface RunnerOptions {
  /** agent-coord repoのベースパス */
  coordRepoPath: string;
  /** タイムアウト（ミリ秒）。0でタイムアウトなし */
  timeout?: number;
}

/**
 * Runner統合実行結果
 */
export type RunResult = ClaudeRunResult | CodexRunResult;

/**
 * Runner統合クラス
 *
 * ClaudeRunnerとCodexRunnerを統一的に扱うためのインターフェース。
 */
export class Runner {
  private logWriter: LogWriter;
  private claudeRunner: ClaudeRunner;
  private codexRunner: CodexRunner;

  constructor(options: RunnerOptions) {
    this.logWriter = new LogWriter({ coordRepoPath: options.coordRepoPath });

    const claudeOptions: ClaudeRunnerOptions = {
      coordRepoPath: options.coordRepoPath,
      logWriter: this.logWriter,
      timeout: options.timeout,
    };

    const codexOptions: CodexRunnerOptions = {
      coordRepoPath: options.coordRepoPath,
      logWriter: this.logWriter,
      timeout: options.timeout,
    };

    this.claudeRunner = new ClaudeRunner(claudeOptions);
    this.codexRunner = new CodexRunner(codexOptions);
  }

  /**
   * 指定されたエージェント種別でタスクを実行
   *
   * @param agentType エージェント種別 ('claude' | 'codex')
   * @param task 実行するタスク
   * @param workingDirectory エージェントの作業ディレクトリ
   * @returns 実行結果
   */
  async runTask(agentType: AgentType, task: Task, workingDirectory: string): Promise<RunResult> {
    switch (agentType) {
      case 'claude':
        return this.claudeRunner.runTask(task, workingDirectory);
      case 'codex':
        return this.codexRunner.runTask(task, workingDirectory);
      default:
        throw new Error(`Unknown agent type: ${agentType}`);
    }
  }

  /**
   * LogWriterインスタンスを取得
   */
  getLogWriter(): LogWriter {
    return this.logWriter;
  }
}

// New functional implementation exports
export { createRunTask } from './run-task.ts';
export type { RunnerEffects, AgentOutput } from './runner-effects.ts';
export { createRunnerEffects, type RunnerEffectsOptions } from './runner-effects-impl.ts';
export * from './prompt-builder.ts';

// Re-export (legacy, will be removed after migration)
export { ProcessRunner, type ProcessResult, type ProcessRunnerOptions } from './process-runner.ts';
export { LogWriter, type LogWriterOptions } from './log-writer.ts';
export { ClaudeRunner, type ClaudeRunnerOptions, type ClaudeRunResult } from './claude-runner.ts';
export { CodexRunner, type CodexRunnerOptions, type CodexRunResult } from './codex-runner.ts';
