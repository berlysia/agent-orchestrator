/**
 * Run Task - タスク実行ファクトリ関数
 *
 * RunnerEffects に依存してタスク実行ロジックを提供する。
 * Result型を使用してエラーハンドリングを統一。
 */

import { createOk, createErr, isErr } from 'option-t/plain_result';
import type { Result } from 'option-t/plain_result';
import type { RunnerError } from '../../types/errors.ts';
import type { Task } from '../../types/task.ts';
import type { RunnerEffects } from './runner-effects.ts';
import {
  buildTaskPrompt,
  createRunRecord,
  markRunSuccess,
  markRunFailure,
} from './prompt-builder.ts';
import { unwrapRunId } from '../../types/branded.ts';

/**
 * タスク実行結果
 */
export interface RunTaskResult {
  /** Run ID（文字列形式） */
  readonly runId: string;
  /** 成功したかどうか */
  readonly success: boolean;
  /** 実行時間（ミリ秒） */
  readonly duration: number;
  /** Thread ID（Codex の場合のみ） */
  readonly threadId?: string;
}

/**
 * タスク実行関数の依存関係
 */
export interface RunTaskDeps {
  /** Runner Effects */
  readonly effects: RunnerEffects;
}

/**
 * タスク実行関数を作成
 *
 * @param deps 依存関係
 * @returns タスク実行関数群
 */
export const createRunTask = (deps: RunTaskDeps) => {
  /**
   * Claude エージェントでタスクを実行
   *
   * @param task タスク
   * @param workingDirectory 作業ディレクトリ
   * @param model 使用するモデル
   * @returns 実行結果
   */
  const runClaudeTask = async (
    task: Task,
    workingDirectory: string,
    model = 'claude-sonnet-4-5-20250929',
  ): Promise<Result<RunTaskResult, RunnerError>> => {
    const startTime = Date.now();
    const run = createRunRecord(task.id, 'claude');
    const rawRunId = unwrapRunId(run.id);

    // Runs ディレクトリを作成
    const ensureDirResult = await deps.effects.ensureRunsDir();
    if (isErr(ensureDirResult)) {
      return ensureDirResult;
    }

    // Run メタデータを保存
    const saveMetadataResult = await deps.effects.saveRunMetadata(run);
    if (isErr(saveMetadataResult)) {
      return saveMetadataResult;
    }

    // プロンプト構築
    const prompt = buildTaskPrompt(task);

    // ログ開始
    await deps.effects.appendLog(rawRunId, `=== Claude Agent Execution Start ===\n`);
    await deps.effects.appendLog(rawRunId, `Task ID: ${task.id}\n`);
    await deps.effects.appendLog(rawRunId, `Working Directory: ${workingDirectory}\n`);
    await deps.effects.appendLog(rawRunId, `Prompt: ${prompt}\n\n`);

    // Claude Agent 実行（runIdを渡してストリームログを記録）
    const agentResult = await deps.effects.runClaudeAgent(
      prompt,
      workingDirectory,
      model,
      rawRunId,
    );

    const duration = Date.now() - startTime;

    if (isErr(agentResult)) {
      // エラーログ記録
      await deps.effects.appendLog(rawRunId, `\n=== Error ===\n`);
      await deps.effects.appendLog(rawRunId, agentResult.err.message);
      await deps.effects.appendLog(rawRunId, `\n=== Claude Agent Execution Failed ===\n`);

      // Run 情報を更新
      const failedRun = markRunFailure(run, agentResult.err.message);
      await deps.effects.saveRunMetadata(failedRun);

      return createErr(agentResult.err);
    }

    // 実行ログ記録
    await deps.effects.appendLog(rawRunId, `\n=== Execution Result ===\n`);
    await deps.effects.appendLog(rawRunId, JSON.stringify(agentResult.val, null, 2));
    await deps.effects.appendLog(rawRunId, `\n=== Claude Agent Execution Complete ===\n`);

    // Run 情報を更新
    const successRun = markRunSuccess(run);
    await deps.effects.saveRunMetadata(successRun);

    return createOk({
      runId: rawRunId,
      success: true,
      duration,
    });
  };

  /**
   * Codex エージェントでタスクを実行
   *
   * @param task タスク
   * @param workingDirectory 作業ディレクトリ
   * @returns 実行結果
   */
  const runCodexTask = async (
    task: Task,
    workingDirectory: string,
  ): Promise<Result<RunTaskResult, RunnerError>> => {
    const startTime = Date.now();
    const run = createRunRecord(task.id, 'codex');
    const rawRunId = unwrapRunId(run.id);

    // Runs ディレクトリを作成
    const ensureDirResult = await deps.effects.ensureRunsDir();
    if (isErr(ensureDirResult)) {
      return ensureDirResult;
    }

    // Run メタデータを保存
    const saveMetadataResult = await deps.effects.saveRunMetadata(run);
    if (isErr(saveMetadataResult)) {
      return saveMetadataResult;
    }

    // プロンプト構築
    const prompt = buildTaskPrompt(task);

    // ログ開始
    await deps.effects.appendLog(rawRunId, `=== Codex Agent Execution Start ===\n`);
    await deps.effects.appendLog(rawRunId, `Task ID: ${task.id}\n`);
    await deps.effects.appendLog(rawRunId, `Working Directory: ${workingDirectory}\n`);
    await deps.effects.appendLog(rawRunId, `Prompt: ${prompt}\n\n`);

    // Codex Agent 実行（runIdを渡してストリームログを記録）
    const agentResult = await deps.effects.runCodexAgent(
      prompt,
      workingDirectory,
      undefined,
      rawRunId,
    );

    const duration = Date.now() - startTime;

    if (isErr(agentResult)) {
      // エラーログ記録
      await deps.effects.appendLog(rawRunId, `\n=== Error ===\n`);
      await deps.effects.appendLog(rawRunId, agentResult.err.message);
      await deps.effects.appendLog(rawRunId, `\n=== Codex Agent Execution Failed ===\n`);

      // Run 情報を更新
      const failedRun = markRunFailure(run, agentResult.err.message);
      await deps.effects.saveRunMetadata(failedRun);

      return createErr(agentResult.err);
    }

    // Thread ID を取得
    const threadId = agentResult.val.sessionId;

    // 実行ログ記録
    await deps.effects.appendLog(rawRunId, `Thread ID: ${threadId}\n\n`);
    await deps.effects.appendLog(rawRunId, `\n=== Execution Result ===\n`);
    await deps.effects.appendLog(rawRunId, `Final Response: ${agentResult.val.finalResponse}\n`);
    await deps.effects.appendLog(
      rawRunId,
      `Items: ${JSON.stringify(agentResult.val.items, null, 2)}\n`,
    );
    await deps.effects.appendLog(rawRunId, `\n=== Codex Agent Execution Complete ===\n`);

    // Run 情報を更新
    const successRun = markRunSuccess(run);
    await deps.effects.saveRunMetadata(successRun);

    return createOk({
      runId: rawRunId,
      success: true,
      duration,
      threadId,
    });
  };

  return {
    runClaudeTask,
    runCodexTask,
  };
};
