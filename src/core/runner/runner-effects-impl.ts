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
import { createErr } from 'option-t/plain_result';
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
  /** Rate limit時の最大リトライ回数（デフォルト: 3） */
  maxRetries?: number;
  /** Rate limit自動リトライを有効にするか（デフォルト: true） */
  enableRateLimitRetry?: boolean;
}

/**
 * 指定された秒数だけ待機するPromise
 *
 * WHY: Rate limit時に retry-after 秒数だけ待機する
 */
const sleep = (seconds: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
};

/**
 * 待機終了時刻を計算してフォーマット
 *
 * @param seconds 待機秒数
 * @returns ISO 8601形式の時刻文字列
 */
const formatWaitUntilTime = (seconds: number): string => {
  const waitUntil = new Date(Date.now() + seconds * 1000);
  return waitUntil.toISOString();
};

/**
 * RunnerEffects 実装を生成するファクトリ関数
 */
export const createRunnerEffects = (options: RunnerEffectsOptions): RunnerEffects => {
  const runsDir = path.join(options.coordRepoPath, 'runs');
  const maxRetries = options.maxRetries ?? 3;
  const enableRateLimitRetry = options.enableRateLimitRetry ?? true;

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

  /**
   * ログファイルのヘッダーを初期化
   *
   * ログファイルの冒頭にIDとメタデータへのパスを記録する
   */
  const initializeLogFile = async (run: Run): Promise<Result<void, RunnerError>> => {
    const result = await tryCatchIntoResultAsync(async () => {
      const logPath = getLogFilePath(run.id);
      const metadataPath = getRunMetadataPath(run.id);

      const header = [
        '# Agent Execution Log',
        `# Run ID: ${run.id}`,
        `# Task ID: ${run.taskId}`,
        `# Metadata: ${metadataPath}`,
        run.plannerRunId ? `# Planner Run ID: ${run.plannerRunId}` : null,
        run.plannerMetadataPath ? `# Planner Metadata: ${run.plannerMetadataPath}` : null,
        `# Started At: ${run.startedAt}`,
        '#',
        '',
      ].filter(line => line !== null).join('\n');

      await fs.writeFile(logPath, header, 'utf-8');
    });
    return mapErrForResult(result, toRunnerError('initializeLogFile'));
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
   * Rate Limit エラーかどうかを判定
   *
   * WHY: Anthropic API は Rate Limit 超過時に HTTP 429 を返す
   * 参考: https://docs.anthropic.com/en/api/rate-limits
   */
  const isRateLimited = (err: unknown): boolean => {
    // RateLimitError インスタンスチェック（最優先）
    if (err && typeof err === 'object' && err.constructor?.name === 'RateLimitError') {
      return true;
    }
    // status === 429 チェック（次点）
    if ((err as any)?.status === 429) {
      return true;
    }
    // error.type === "rate_limit_error" チェック（ボディ型）
    if ((err as any)?.error?.type === 'rate_limit_error') {
      return true;
    }
    return false;
  };

  /**
   * retry-after ヘッダから待機秒数を取得
   *
   * WHY: Rate Limit エラー時、API は retry-after ヘッダで待機時間を指示する
   * 参考: https://docs.anthropic.com/en/api/rate-limits
   */
  const getRetryAfterSeconds = (err: unknown): number | undefined => {
    const h = (err as any)?.headers;
    const v =
      typeof h?.get === 'function'
        ? h.get('retry-after')
        : typeof h === 'object' && h
          ? h['retry-after'] ?? h['Retry-After']
          : undefined;

    if (v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  /**
   * Claude エージェントを実行
   *
   * ClaudeRunner の実装を関数型に移植。
   * unstable_v2_prompt を使用してエージェントを実行する。
   *
   * WHY: Rate limit エラー時は retry-after 秒数だけ待機して自動リトライする
   */
  const runClaudeAgent = async (
    prompt: string,
    workingDirectory: string,
    model: string,
  ): Promise<Result<AgentOutput, RunnerError>> => {
    let lastError: unknown;
    const attemptLimit = enableRateLimitRetry ? maxRetries : 1;

    for (let attempt = 1; attempt <= attemptLimit; attempt++) {
      const result = await tryCatchIntoResultAsync(async () => {
        // Claude Agent SDK をインポート
        const { query } = await import('@anthropic-ai/claude-agent-sdk');

        // Claude Agent実行
        // WHY: Workerエージェントは自動実行されるため、パーミッション要求をバイパス
        const responseStream = query({
          prompt,
          options: {
            model,
            cwd: workingDirectory,
            permissionMode: 'bypassPermissions',
          },
        });

        // ストリームからresultメッセージを収集
        // WHY: subtype が success 以外の場合もあるため、明示的にチェック
        // 参考: https://github.com/anthropics/claude-code/issues/6408
        let finalResult = '';
        for await (const message of responseStream) {
          if (message.type === 'result') {
            if (message.subtype === 'success') {
              finalResult = message.result;
              break;
            } else {
              // success以外（error等）の場合はエラーとして扱う
              throw new Error(
                `Agent execution failed: result.subtype = ${message.subtype}, message = ${JSON.stringify(message)}`,
              );
            }
          }
        }

        // AgentOutput形式に変換
        return {
          finalResponse: finalResult,
        } satisfies AgentOutput;
      });

      // 成功した場合は即座に返す
      if (result.ok) {
        if (attempt > 1) {
          console.log(`  ✅ Retry successful (attempt ${attempt}/${attemptLimit})`);
        }
        return result;
      }

      lastError = result.err;

      // Rate Limit エラーの場合
      if (isRateLimited(result.err)) {
        const retryAfter = getRetryAfterSeconds(result.err);

        // リトライが無効、または最後の試行の場合はエラーを返す
        if (!enableRateLimitRetry || attempt >= attemptLimit) {
          const errorMessage = retryAfter
            ? `Rate limit exceeded. Retry after ${retryAfter} seconds.`
            : 'Rate limit exceeded.';
          return createErr(agentExecutionError('claude', new Error(errorMessage)));
        }

        // リトライ可能な場合は待機してリトライ
        const waitSeconds = retryAfter ?? 60; // デフォルト60秒
        const waitUntil = formatWaitUntilTime(waitSeconds);

        console.log(
          `  ⏱️  Rate limit exceeded. Waiting until ${waitUntil} (${waitSeconds} seconds)...`,
        );
        console.log(`     Attempt ${attempt}/${attemptLimit}`);

        await sleep(waitSeconds);
        console.log(`  🔄 Retrying... (attempt ${attempt + 1}/${attemptLimit})`);
        continue;
      }

      // Rate Limit以外のエラーは即座に返す
      return createErr(agentExecutionError('claude', result.err));
    }

    // すべてのリトライが失敗した場合
    return createErr(agentExecutionError('claude', lastError));
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
    initializeLogFile,
    appendLog,
    saveRunMetadata,
    loadRunMetadata,
    readLog,
    listRunLogs,
    runClaudeAgent,
    runCodexAgent,
  };
};
