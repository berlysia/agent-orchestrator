/**
 * RunnerEffects 実装
 *
 * LogWriter クラスの機能を関数型パターンで再実装し、
 * エージェント実行機能を追加した RunnerEffects インターフェースの具象実装。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createErr } from 'option-t/plain_result';
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
  const toRunnerError = (operation: string) => (e: unknown): RunnerError => {
    return agentExecutionError(operation, e);
  };

  // ===== ログ記録実装 =====

  const ensureRunsDir = async (): Promise<Result<void, RunnerError>> => {
    const result = await tryCatchIntoResultAsync(async () => {
      await fs.mkdir(runsDir, { recursive: true });
    });
    return mapErrForResult(result, toRunnerError('ensureRunsDir'));
  };

  const appendLog = async (theRunId: string, content: string): Promise<Result<void, RunnerError>> => {
    const result = await tryCatchIntoResultAsync(async () => {
      const logPath = getLogFilePath(theRunId);
      await fs.appendFile(logPath, content, 'utf-8');
    });
    return mapErrForResult(result, toRunnerError('appendLog'));
  };

  const saveRunMetadata = async (run: Run): Promise<Result<void, RunnerError>> => {
    const result = await tryCatchIntoResultAsync(async () => {
      const metadataPath = getRunMetadataPath(run.id);
      const json = JSON.stringify(run, null, 2);
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

  // ===== エージェント実行実装 =====
  // NOTE: 現時点では ClaudeRunner/CodexRunner クラスの実装を呼び出す
  // 将来的にはこれらも関数化して統合する予定

  const runClaudeAgent = async (
    _prompt: string,
    _workingDirectory: string,
    _model: string,
  ): Promise<Result<AgentOutput, RunnerError>> => {
    // TODO: ClaudeRunner の機能を関数化して実装
    // 現時点では未実装
    return createErr(agentExecutionError('claude', new Error('Not implemented yet')));
  };

  const runCodexAgent = async (
    _prompt: string,
    _workingDirectory: string,
  ): Promise<Result<AgentOutput, RunnerError>> => {
    // TODO: CodexRunner の機能を関数化して実装
    // 現時点では未実装
    return createErr(agentExecutionError('codex', new Error('Not implemented yet')));
  };

  // ===== インターフェース実装 =====

  return {
    ensureRunsDir,
    appendLog,
    saveRunMetadata,
    loadRunMetadata,
    readLog,
    runClaudeAgent,
    runCodexAgent,
  };
};
