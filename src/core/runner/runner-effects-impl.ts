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
        run.sessionId ? `# Session ID: ${run.sessionId}` : null,
        run.plannerMetadataPath ? `# Planner Metadata: ${run.plannerMetadataPath}` : null,
        `# Started At: ${run.startedAt}`,
        '#',
        '',
      ]
        .filter((line) => line !== null)
        .join('\n');

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
          ? (h['retry-after'] ?? h['Retry-After'])
          : undefined;

    if (v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  /**
   * ストリームメッセージをログフォーマットに変換
   *
   * WHY: Claude Agent SDKのストリームメッセージを読みやすい形式でログに記録する
   */
  const formatClaudeStreamMessage = (message: any): string => {
    const timestamp = new Date().toISOString();

    // stream_event (thinking, tool use等の詳細)
    if (message.type === 'stream_event') {
      const event = message.event;
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        return `[${timestamp}] [OUTPUT] ${event.delta.text}`;
      }
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block?.type === 'thinking') {
          return `[${timestamp}] [THINKING] Start`;
        }
        if (block?.type === 'tool_use') {
          return `[${timestamp}] [TOOL_USE] ${block.name} (id: ${block.id})`;
        }
      }
      // その他のstream_eventは簡潔に記録
      return `[${timestamp}] [STREAM_EVENT] ${event.type}`;
    }

    // assistant メッセージ (完了したメッセージ)
    if (message.type === 'assistant') {
      return `[${timestamp}] [ASSISTANT_MESSAGE] Completed (role: ${message.message?.role})`;
    }

    // system メッセージ (初期化、ステータス等)
    if (message.type === 'system') {
      if (message.subtype === 'init') {
        return `[${timestamp}] [SYSTEM_INIT] Model: ${message.model}, Tools: ${message.tools?.length ?? 0}`;
      }
      if (message.subtype === 'status') {
        return `[${timestamp}] [STATUS] ${message.status}`;
      }
      if (message.subtype === 'compact_boundary') {
        return `[${timestamp}] [COMPACT_BOUNDARY] Conversation compacted`;
      }
      return `[${timestamp}] [SYSTEM] ${message.subtype ?? 'unknown'}`;
    }

    // result メッセージ (最終結果)
    if (message.type === 'result') {
      if (message.subtype === 'success') {
        return `[${timestamp}] [RESULT_SUCCESS] Turns: ${message.num_turns}, Duration: ${message.duration_ms}ms`;
      }
      if (message.subtype === 'error') {
        return `[${timestamp}] [RESULT_ERROR] ${message.error ?? 'Unknown error'}`;
      }
    }

    // その他のメッセージタイプ
    return `[${timestamp}] [${message.type?.toUpperCase() ?? 'UNKNOWN'}] ${JSON.stringify(message)}`;
  };

  /**
   * Claude エージェントを実行（v1 query API使用）
   *
   * ClaudeRunner の実装を関数型に移植。
   * query 関数を使用してエージェントを実行する。
   *
   * WHY: Rate limit エラー時は retry-after 秒数だけ待機して自動リトライする
   * WHY: ストリームの全メッセージをログに記録し、実行過程を可視化する
   * WHY: sessionIdが渡された場合は options.resume でセッションを継続し、同一ワーカーの同一タスクに対する連続実行で文脈を維持
   */
  const runClaudeAgent = async (
    prompt: string,
    workingDirectory: string,
    model: string,
    runId?: string,
    sessionId?: string,
  ): Promise<Result<AgentOutput, RunnerError>> => {
    let lastError: unknown;
    const attemptLimit = enableRateLimitRetry ? maxRetries : 1;

    for (let attempt = 1; attempt <= attemptLimit; attempt++) {
      const result = await tryCatchIntoResultAsync(async () => {
        // Claude Agent SDK v1 をインポート
        const { query } = await import('@anthropic-ai/claude-agent-sdk');

        // Claude Agent実行
        // WHY: Workerエージェントは自動実行されるため、パーミッション要求をバイパス
        // WHY: sessionIdがある場合は options.resume でセッションを継続
        const responseStream = query({
          prompt,
          options: {
            model,
            cwd: workingDirectory,
            permissionMode: 'bypassPermissions',
            ...(sessionId && { resume: sessionId }),
          },
        });

        // ストリームから全メッセージを収集してログに記録
        // WHY: thinking、tool use、outputなどの途中経過をログに記録して実行過程を可視化
        let finalResult = '';
        let capturedSessionId: string | undefined;
        for await (const message of responseStream) {
          // ログに記録（runIdが指定されている場合）
          if (runId) {
            const logLine = formatClaudeStreamMessage(message) + '\n';
            await appendLog(runId, logLine);
          }

          // sessionIdをキャプチャ
          if (message.type === 'system' && message.subtype === 'init') {
            capturedSessionId = message.session_id
          }

          // result メッセージを処理
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
          sessionId: capturedSessionId,
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
   * Codexストリームイベントをログフォーマットに変換
   *
   * WHY: Codex SDKのストリームイベントを読みやすい形式でログに記録する
   */
  const formatCodexStreamEvent = (event: any): string => {
    const timestamp = new Date().toISOString();

    switch (event.type) {
      case 'thread.started':
        return `[${timestamp}] [THREAD_STARTED] Thread ID: ${event.thread_id}`;

      case 'turn.started':
        return `[${timestamp}] [TURN_STARTED]`;

      case 'turn.completed':
        return `[${timestamp}] [TURN_COMPLETED] Input: ${event.usage?.input_tokens ?? 0}, Output: ${event.usage?.output_tokens ?? 0} tokens`;

      case 'turn.failed':
        return `[${timestamp}] [TURN_FAILED] ${event.error?.message ?? 'Unknown error'}`;

      case 'item.started': {
        const item = event.item;
        if (item.type === 'reasoning') {
          return `[${timestamp}] [REASONING_START]`;
        }
        if (item.type === 'agent_message') {
          return `[${timestamp}] [AGENT_MESSAGE_START]`;
        }
        if (item.type === 'command_execution') {
          return `[${timestamp}] [COMMAND_START] ${item.command}`;
        }
        if (item.type === 'file_change') {
          return `[${timestamp}] [FILE_CHANGE_START] ${item.changes?.length ?? 0} file(s)`;
        }
        if (item.type === 'mcp_tool_call') {
          return `[${timestamp}] [MCP_TOOL_START] ${item.server}::${item.tool}`;
        }
        if (item.type === 'web_search') {
          return `[${timestamp}] [WEB_SEARCH_START] Query: ${item.query}`;
        }
        if (item.type === 'todo_list') {
          return `[${timestamp}] [TODO_LIST_START] ${item.items?.length ?? 0} item(s)`;
        }
        return `[${timestamp}] [ITEM_START] ${item.type}`;
      }

      case 'item.updated': {
        const item = event.item;
        if (item.type === 'reasoning') {
          return `[${timestamp}] [REASONING] ${item.text?.substring(0, 100) ?? ''}`;
        }
        if (item.type === 'agent_message') {
          return `[${timestamp}] [AGENT_MESSAGE] ${item.text?.substring(0, 100) ?? ''}`;
        }
        if (item.type === 'command_execution') {
          return `[${timestamp}] [COMMAND_OUTPUT] ${item.aggregated_output?.substring(0, 100) ?? ''}`;
        }
        if (item.type === 'todo_list') {
          const completed = item.items?.filter((i: any) => i.completed).length ?? 0;
          const total = item.items?.length ?? 0;
          return `[${timestamp}] [TODO_LIST_UPDATE] ${completed}/${total} completed`;
        }
        return `[${timestamp}] [ITEM_UPDATE] ${item.type}`;
      }

      case 'item.completed': {
        const item = event.item;
        if (item.type === 'reasoning') {
          return `[${timestamp}] [REASONING_COMPLETE]`;
        }
        if (item.type === 'agent_message') {
          return `[${timestamp}] [AGENT_MESSAGE_COMPLETE]`;
        }
        if (item.type === 'command_execution') {
          return `[${timestamp}] [COMMAND_COMPLETE] Exit code: ${item.exit_code ?? 'N/A'}, Status: ${item.status}`;
        }
        if (item.type === 'file_change') {
          return `[${timestamp}] [FILE_CHANGE_COMPLETE] Status: ${item.status}`;
        }
        if (item.type === 'mcp_tool_call') {
          return `[${timestamp}] [MCP_TOOL_COMPLETE] Status: ${item.status}`;
        }
        if (item.type === 'web_search') {
          return `[${timestamp}] [WEB_SEARCH_COMPLETE]`;
        }
        if (item.type === 'todo_list') {
          return `[${timestamp}] [TODO_LIST_COMPLETE]`;
        }
        return `[${timestamp}] [ITEM_COMPLETE] ${item.type}`;
      }

      case 'error':
        return `[${timestamp}] [ERROR] ${event.message ?? 'Unknown error'}`;

      default:
        return `[${timestamp}] [${event.type?.toUpperCase() ?? 'UNKNOWN'}] ${JSON.stringify(event).substring(0, 100)}`;
    }
  };

  /**
   * Codex エージェントを実行
   *
   * CodexRunner の実装を関数型に移植。
   * @openai/codex-sdk を使用してエージェントを実行する。
   *
   * WHY: runStreamed()を使用してストリームイベントをログに記録し、実行過程を可視化する
   * WHY: threadIdが渡された場合はスレッドを再開し、同一ワーカーの同一タスクに対する連続実行で文脈を維持
   */
  const runCodexAgent = async (
    prompt: string,
    workingDirectory: string,
    model?: string,
    runId?: string,
    threadId?: string,
  ): Promise<Result<AgentOutput, RunnerError>> => {
    const result = await tryCatchIntoResultAsync(async () => {
      // Codex SDK をインポート
      const { Codex } = await import('@openai/codex-sdk');
      const codex = new Codex();

      // Codex Thread作成または再開
      // WHY: threadIdがある場合はスレッドを再開し、文脈を維持する
      const thread = threadId
        ? codex.resumeThread(threadId)
        : codex.startThread({
            workingDirectory,
            model,
          });

      // Codex実行（ストリーミング）
      // WHY: runStreamed()を使用して途中経過を取得し、ログに記録する
      const streamedTurn = await thread.runStreamed(prompt);

      // イベントストリームからログを記録
      const items: unknown[] = [];
      let finalResponse = '';

      for await (const event of streamedTurn.events) {
        // ログに記録（runIdが指定されている場合）
        if (runId) {
          const logLine = formatCodexStreamEvent(event) + '\n';
          await appendLog(runId, logLine);
        }

        // item.completed イベントから items を収集
        if (event.type === 'item.completed') {
          items.push(event.item);
          // agent_message から finalResponse を取得
          if (event.item.type === 'agent_message') {
            finalResponse = event.item.text ?? '';
          }
        }
      }

      // AgentOutput形式に変換
      // NOTE: threadIdをsessionIdフィールドに保存（Task型と統一）
      return {
        finalResponse,
        items,
        sessionId: thread.id ?? undefined,
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
