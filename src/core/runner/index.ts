import type { Task } from '../../types/task.ts';
import type { ClaudeRunResult } from './claude-runner.ts';
import type { CodexRunResult } from './codex-runner.ts';
import { LogWriter } from './log-writer.ts';
import { createRunnerEffects } from './runner-effects-impl.ts';
import { createRunTask } from './run-task.ts';
import { isErr } from 'option-t/plain_result';

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
 * 内部実装は新しい関数型 RunnerEffects を使用するが、
 * Orchestrator との互換性のため、クラスインターフェースを維持。
 */
export class Runner {
  private logWriter: LogWriter;
  private taskRunner: ReturnType<typeof createRunTask>;

  constructor(options: RunnerOptions) {
    // 後方互換性のため LogWriter インスタンスを保持
    this.logWriter = new LogWriter({ coordRepoPath: options.coordRepoPath });

    // 新しい関数型実装を使用
    const effects = createRunnerEffects({
      coordRepoPath: options.coordRepoPath,
      timeout: options.timeout,
    });

    this.taskRunner = createRunTask({ effects });
  }

  /**
   * 指定されたエージェント種別でタスクを実行
   *
   * 新しい関数型実装を使用し、Result型を旧インターフェースに変換。
   *
   * @param agentType エージェント種別 ('claude' | 'codex')
   * @param task 実行するタスク
   * @param workingDirectory エージェントの作業ディレクトリ
   * @returns 実行結果
   */
  async runTask(agentType: AgentType, task: Task, workingDirectory: string): Promise<RunResult> {
    let result;

    switch (agentType) {
      case 'claude':
        result = await this.taskRunner.runClaudeTask(task, workingDirectory);
        break;
      case 'codex':
        result = await this.taskRunner.runCodexTask(task, workingDirectory);
        break;
      default:
        throw new Error(`Unknown agent type: ${agentType}`);
    }

    // Result<T, E> を旧インターフェースに変換
    if (isErr(result)) {
      return {
        runId: `error-${Date.now()}`,
        success: false,
        error: result.err.message,
        duration: 0,
      };
    }

    return {
      runId: result.val.runId,
      success: result.val.success,
      duration: result.val.duration,
      threadId: result.val.threadId,
    };
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
