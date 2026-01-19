/**
 * RunnerEffects 実装
 *
 * LogWriter クラスの機能を関数型パターンで再実装し、
 * エージェント実行機能を追加した RunnerEffects インターフェースの具象実装。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { tryCatchIntoResultAsync } from 'option-t/plain_result/try_catch_async';
import { mapErrForResult } from 'option-t/plain_result/map_err';
import type { Result } from 'option-t/plain_result';
import type { RunnerError } from '../../types/errors.ts';
import type { Run } from '../../types/run.ts';
import type { RunnerEffects, AgentOutput } from './runner-effects.ts';
import { agentExecutionError } from '../../types/errors.ts';

export interface RunnerEffectsOptions {
  /** agent-coord repoのベースパス */
  coordRepoPath: string;
  /** タイムアウト（ミリ秒）。0でタイムアウトなし */
  timeout?: number;
}

/**
 * RunnerEffects 実装を生成するファクトリ関数
 */
export const createRunnerEffects = (options: RunnerEffectsOptions): RunnerEffects => {
  const runsDir = path.join(options.coordRepoPath, 'runs');

  // ===== ヘルパー関数 =====

  const getLogFilePath = (theRunId: string): string => {
    return path.join(runsDir, `${theRunId}.log`);
  };

  const getRunMetadataPath = (theRunId: string): string => {
    return path.join(runsDir, `${theRunId}.json`);
  };

  // エラー変換ヘルパー
  const toRunnerError =
    (operation: string) =>
    (e: unknown): RunnerError => {
      return agentExecutionError(operation, e);
    };

  // ===== ログ記録実装 =====

  const ensureRunsDir = async (): Promise<Result<void, RunnerError>> => {
    const result = await tryCatchIntoResultAsync(async () => {
      await fs.mkdir(runsDir, { recursive: true });
    });
    return mapErrForResult(result, toRunnerError('ensureRunsDir'));
  };

  const appendLog = async (
    theRunId: string,
    content: string,
  ): Promise<Result<void, RunnerError>> => {
    const result = await tryCatchIntoResultAsync(async () => {
      const logPath = getLogFilePath(theRunId);
      await fs.appendFile(logPath, content, 'utf-8');
    });
    return mapErrForResult(result, toRunnerError('appendLog'));
  };

  const saveRunMetadata = async (run: Run): Promise<Result<void, RunnerError>> => {
    const result = await tryCatchIntoResultAsync(async () => {
      const metadataPath = getRunMetadataPath(run.id);
      const normalizedLogPath = path.isAbsolute(run.logPath)
        ? run.logPath
        : path.resolve(options.coordRepoPath, run.logPath);
      const json = JSON.stringify({ ...run, logPath: normalizedLogPath }, null, 2);
      await fs.writeFile(metadataPath, json, 'utf-8');
    });
    return mapErrForResult(result, toRunnerError('saveRunMetadata'));
  };

  const loadRunMetadata = async (theRunId: string): Promise<Result<Run, RunnerError>> => {
    const result = await tryCatchIntoResultAsync(async () => {
      const metadataPath = getRunMetadataPath(theRunId);
      const json = await fs.readFile(metadataPath, 'utf-8');
      return JSON.parse(json) as Run;
    });
    return mapErrForResult(result, toRunnerError('loadRunMetadata'));
  };

  const readLog = async (theRunId: string): Promise<Result<string, RunnerError>> => {
    const result = await tryCatchIntoResultAsync(async () => {
      const logPath = getLogFilePath(theRunId);
      return await fs.readFile(logPath, 'utf-8');
    });
    return mapErrForResult(result, toRunnerError('readLog'));
  };

  const listRunLogs = async (): Promise<Result<string[], RunnerError>> => {
    const result = await tryCatchIntoResultAsync(async () => {
      // runsディレクトリが存在しない場合は空配列を返す
      try {
        await fs.access(runsDir);
      } catch {
        return [];
      }

      const files = await fs.readdir(runsDir);
      return files.filter((file) => file.endsWith('.log'));
    });
    return mapErrForResult(result, toRunnerError('listRunLogs'));
  };

  // ===== エージェント実行実装 =====

  /**
   * Claude エージェントを実行
   *
   * ClaudeRunner の実装を関数型に移植。
   * unstable_v2_prompt を使用してエージェントを実行する。
   */
  const runClaudeAgent = async (
    prompt: string,
    workingDirectory: string,
    model: string,
  ): Promise<Result<AgentOutput, RunnerError>> => {
    const result = await tryCatchIntoResultAsync(async () => {
      // Claude Agent SDK をインポート
      const { query } = await import('@anthropic-ai/claude-agent-sdk');

      // Claude Agent実行
      // WHY: Workerエージェントは自動実行されるため、パーミッション要求をバイパス
      const responseStream = query({
        prompt,
        options: {
          model: model || 'claude-sonnet-4-5-20250929',
          cwd: workingDirectory,
          permissionMode: 'bypassPermissions',
        },
      });

      // ストリームからresultメッセージを収集
      let finalResult = '';
      for await (const message of responseStream) {
        if (message.type === 'result' && message.subtype === 'success') {
          finalResult = message.result;
          break;
        }
      }

      // AgentOutput形式に変換
      return {
        finalResponse: finalResult,
      } satisfies AgentOutput;
    });

    return mapErrForResult(result, (e) => agentExecutionError('claude', e));
  };

  /**
   * Codex エージェントを実行
   *
   * CodexRunner の実装を関数型に移植。
   * @openai/codex-sdk を使用してエージェントを実行する。
   */
  const runCodexAgent = async (
    prompt: string,
    workingDirectory: string,
    model?: string,
  ): Promise<Result<AgentOutput, RunnerError>> => {
    const result = await tryCatchIntoResultAsync(async () => {
      // Codex SDK をインポート
      const { Codex } = await import('@openai/codex-sdk');
      const codex = new Codex();

      // Codex Thread作成
      const thread = codex.startThread({
        workingDirectory,
        model,
      });

      // Codex実行
      const turn = await thread.run(prompt);

      // AgentOutput形式に変換
      return {
        finalResponse: turn.finalResponse,
        items: turn.items,
        threadId: thread.id ?? undefined,
      } satisfies AgentOutput;
    });

    return mapErrForResult(result, (e) => agentExecutionError('codex', e));
  };

  // ===== インターフェース実装 =====

  return {
    ensureRunsDir,
    appendLog,
    saveRunMetadata,
    loadRunMetadata,
    readLog,
    listRunLogs,
    runClaudeAgent,
    runCodexAgent,
  };
};
