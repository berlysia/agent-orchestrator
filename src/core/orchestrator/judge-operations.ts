import type { TaskStore } from '../task-store/interface.ts';
import type { RunnerEffects } from '../runner/runner-effects.ts';
import type { Task } from '../../types/task.ts';
import { TaskState } from '../../types/task.ts';
import type { TaskId } from '../../types/branded.ts';
import type { TaskStoreError } from '../../types/errors.ts';
import { validationError } from '../../types/errors.ts';
import type { AgentType } from '../../types/config.ts';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr } from 'option-t/plain_result';
import { z } from 'zod';

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

const getErrorCause = (err: unknown): unknown => {
  if (err && typeof err === 'object' && 'cause' in err) {
    const cause = (err as { cause?: unknown }).cause;
    return cause ?? err;
  }
  return err;
};

/**
 * Rate Limit エラーかどうかを判定
 */
const isRateLimited = (err: unknown): boolean => {
  const target = getErrorCause(err);

  // RateLimitError インスタンスチェック（最優先）
  if (target && typeof target === 'object' && target.constructor?.name === 'RateLimitError') {
    return true;
  }

  const status =
    (target as any)?.status ??
    (target as any)?.statusCode ??
    (target as any)?.response?.status ??
    (target as any)?.response?.statusCode;
  if (status === 429) {
    return true;
  }

  if ((target as any)?.error?.type === 'rate_limit_error') {
    return true;
  }
  if ((target as any)?.type === 'rate_limit_error') {
    return true;
  }

  return false;
};

/**
 * retry-after ヘッダから待機秒数を取得
 */
const getRetryAfterSeconds = (err: unknown): number | undefined => {
  const target = getErrorCause(err) as any;
  const h = target?.headers ?? target?.response?.headers;
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
 * Judge依存関係
 */
export interface JudgeDeps {
  readonly taskStore: TaskStore;
  readonly runnerEffects: RunnerEffects;
  readonly appRepoPath: string;
  readonly agentType: AgentType;
  readonly model: string;
  readonly judgeTaskRetries: number;
}

/**
 * Judge判定結果
 */
export interface JudgementResult {
  /** タスクID */
  taskId: TaskId;
  /** 判定結果（true=成功、false=失敗） */
  success: boolean;
  /** 継続の可否（true=次イテレーション実行、false=停止） */
  shouldContinue: boolean;
  /** 理由メッセージ */
  reason: string;
  /** 未達成要件リスト */
  missingRequirements?: string[];
}

/**
 * エージェントからの判定応答スキーマ
 */
const AgentJudgementSchema = z.object({
  success: z.boolean(),
  reason: z.string(),
  missingRequirements: z.array(z.string()).optional().default([]),
  shouldContinue: z.boolean().optional().default(false),
});

/**
 * 判定プロンプトを構築
 *
 * WHY: タスクのacceptance criteriaと実行ログを組み合わせて、
 * エージェントが判定に必要な情報を提供する
 *
 * @param task タスク情報
 * @param runLog 実行ログ内容
 * @returns 判定プロンプト
 */
const buildJudgementPrompt = (task: Task, runLog: string): string => {
  return `You are a task completion judge for a multi-agent development system.

TASK INFORMATION:
- Branch: ${task.branch}
- Type: ${task.taskType}
- Context: ${task.context}

TASK ACCEPTANCE CRITERIA:
${task.acceptance}

EXECUTION LOG:
${runLog}

Your task:
1. Determine if the acceptance criteria were fully met based on the execution log
2. Check if the implementation is complete and functional
3. Identify any missing requirements or issues
4. Decide if the task should continue for another iteration (rare - only if fixable issues found)

Output (JSON only, no additional text):
{
  "success": true/false,
  "reason": "Detailed explanation of your judgement",
  "missingRequirements": ["req1", "req2"],  // Empty array if none
  "shouldContinue": true/false  // true only if issues can be fixed in next iteration
}

Rules:
- success=true only if ALL acceptance criteria are met
- missingRequirements should list specific unmet criteria
- shouldContinue=true only if there are fixable issues (not for fundamental problems)
- Provide a clear, actionable reason

Output only the JSON object, no markdown code blocks or additional text.`;
};

/**
 * エージェント応答をパースして判定結果を抽出
 *
 * WHY: エージェントの応答はマークダウンコードブロックに囲まれている可能性があるため、
 * JSON部分を抽出してバリデーションを行う
 *
 * @param output エージェントの生の応答
 * @returns パースされた判定結果（パース失敗時はundefined）
 */
const parseJudgementResult = (output: string): z.infer<typeof AgentJudgementSchema> | undefined => {
  try {
    // JSONブロックを抽出（マークダウンコードブロックに囲まれている可能性）
    const jsonMatch =
      output.match(/```(?:json)?\s*\n?([^`]+)\n?```/) || output.match(/(\{[\s\S]*\})/);

    if (!jsonMatch || !jsonMatch[1]) {
      console.error('❌ No JSON found in agent response');
      return undefined;
    }

    const jsonStr = jsonMatch[1];
    const parsed = JSON.parse(jsonStr.trim());

    // Zodスキーマでバリデーション
    const result = AgentJudgementSchema.safeParse(parsed);

    if (result.success) {
      return result.data;
    }

    console.error(
      '❌ Agent judgement validation failed:',
      JSON.stringify(result.error.format()),
    );
    return undefined;
  } catch (error) {
    console.error(
      '❌ Failed to parse agent judgement:',
      error instanceof Error ? error.message : String(error),
    );
    console.error('Output was:', output);
    return undefined;
  }
};

/**
 * Judge操作を提供するファクトリ関数
 *
 * @param deps Judge依存関係
 * @returns Judge操作オブジェクト
 */
export const createJudgeOperations = (deps: JudgeDeps) => {
  /**
   * タスクの完了を判定
   *
   * WHY: Worker実行後のタスクを評価し、完了/継続/停止を判断
   * Phase 5.6: エージェントベースの高度な判定を実装
   *
   * @param tid 判定するタスクのID
   * @param runIdToRead 判定対象の実行ログRunID（実行結果から受け取る）
   * @returns 判定結果（Result型）
   */
  const judgeTask = async (
    tid: TaskId,
    runIdToRead: string,
  ): Promise<Result<JudgementResult, TaskStoreError>> => {
    const taskResult = await deps.taskStore.readTask(tid);

    // Result型のエラーハンドリング
    if (!taskResult.ok) {
      return createErr(taskResult.err);
    }

    const task = taskResult.val;

    // タスクがRUNNING状態であることを確認
    if (task.state !== TaskState.RUNNING) {
      return createOk({
        taskId: tid,
        success: false,
        shouldContinue: false,
        reason: `Task is not in RUNNING state: ${task.state}`,
      });
    }

    // 実行ログを読み込み（実行結果で得たRunIDを使用）
    if (!runIdToRead) {
      return createErr(validationError(`No runId provided for task ${tid}`));
    }

    const logResult = await deps.runnerEffects.readLog(runIdToRead);
    if (!logResult.ok) {
      // RunnerErrorをTaskStoreErrorに変換
      return createErr(validationError(`Failed to read log: ${logResult.err.message}`));
    }
    const runLog = logResult.val;

    // エージェントに判定を依頼
    const judgementPrompt = buildJudgementPrompt(task, runLog);

    const attemptLimit = deps.judgeTaskRetries;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attemptLimit; attempt++) {
      const agentResult =
        deps.agentType === 'claude'
          ? await deps.runnerEffects.runClaudeAgent(judgementPrompt, deps.appRepoPath, deps.model)
          : await deps.runnerEffects.runCodexAgent(judgementPrompt, deps.appRepoPath, deps.model);

      if (agentResult.ok) {
        const parsedJudgement = parseJudgementResult(agentResult.val.finalResponse ?? '');
        if (!parsedJudgement) {
          return createErr(validationError('Failed to parse judge response'));
        }

        return createOk({
          taskId: tid,
          success: parsedJudgement.success,
          shouldContinue: parsedJudgement.shouldContinue,
          reason: parsedJudgement.reason,
          missingRequirements: parsedJudgement.missingRequirements,
        });
      }

      lastError = agentResult.err;

      if (isRateLimited(agentResult.err)) {
        const retryAfter = getRetryAfterSeconds(agentResult.err);

        if (attempt >= attemptLimit) {
          const errorMessage = retryAfter
            ? `Rate limit exceeded. Retry after ${retryAfter} seconds.`
            : 'Rate limit exceeded.';
          return createErr(validationError(`Judge agent rate limited: ${errorMessage}`));
        }

        const waitSeconds = retryAfter ?? 60;
        const waitUntil = formatWaitUntilTime(waitSeconds);
        console.log(
          `  ⏱️  Judge rate limit exceeded. Waiting until ${waitUntil} (${waitSeconds} seconds)...`,
        );
        console.log(`     Attempt ${attempt}/${attemptLimit}`);
        await sleep(waitSeconds);
        console.log(`  🔄 Retrying judge... (attempt ${attempt + 1}/${attemptLimit})`);
        continue;
      }

      const errorMessage =
        agentResult.err && typeof agentResult.err === 'object' && 'message' in agentResult.err
          ? String((agentResult.err as { message?: unknown }).message)
          : String(agentResult.err);
      return createErr(validationError(`Judge agent execution failed: ${errorMessage}`));
    }

    const fallbackMessage =
      lastError && typeof lastError === 'object' && 'message' in lastError
        ? String((lastError as { message?: unknown }).message)
        : 'Unknown error';
    return createErr(validationError(`Judge agent execution failed: ${fallbackMessage}`));
  };

  /**
   * タスクを完了状態に更新
   *
   * @param tid タスクID
   * @returns 更新後のタスク（Result型）
   */
  const markTaskAsCompleted = async (tid: TaskId): Promise<Result<Task, TaskStoreError>> => {
    const taskResult = await deps.taskStore.readTask(tid);
    if (!taskResult.ok) {
      return taskResult;
    }

    const task = taskResult.val;

    return await deps.taskStore.updateTaskCAS(tid, task.version, (currentTask) => ({
      ...currentTask,
      state: TaskState.DONE,
      owner: null,
      updatedAt: new Date().toISOString(),
    }));
  };

  /**
   * タスクをブロック状態に更新
   *
   * @param tid タスクID
   * @returns 更新後のタスク（Result型）
   */
  const markTaskAsBlocked = async (tid: TaskId): Promise<Result<Task, TaskStoreError>> => {
    const taskResult = await deps.taskStore.readTask(tid);
    if (!taskResult.ok) {
      return taskResult;
    }

    const task = taskResult.val;

    return await deps.taskStore.updateTaskCAS(tid, task.version, (currentTask) => ({
      ...currentTask,
      state: TaskState.BLOCKED,
      owner: null,
      updatedAt: new Date().toISOString(),
    }));
  };

  /**
   * タスクを継続実行のためにNEEDS_CONTINUATION状態に遷移し、判定フィードバックを記録
   *
   * WHY: Judgeが「未完了だが継続可能」と判定した場合、フィードバックを付けて再実行する
   *      READY（未実行）とNEEDS_CONTINUATION（実行済みだが不完全）を明確に区別する
   *
   * @param tid タスクID
   * @param judgement 判定結果
   * @param maxIterations 最大リトライ回数（configから取得）
   * @returns 更新後のタスク（Result型）
   */
  const markTaskForContinuation = async (
    tid: TaskId,
    judgement: JudgementResult,
    maxIterations: number = deps.judgeTaskRetries,
  ): Promise<Result<Task, TaskStoreError>> => {
    const taskResult = await deps.taskStore.readTask(tid);
    if (!taskResult.ok) {
      return taskResult;
    }

    const task = taskResult.val;
    const currentIteration = task.judgementFeedback?.iteration ?? 0;
    const newIteration = currentIteration + 1;

    // 最大リトライ回数を超えた場合はエラー
    if (newIteration >= maxIterations) {
      return createErr(validationError(`Task ${tid} exceeded max iterations (${maxIterations})`));
    }

    return await deps.taskStore.updateTaskCAS(tid, task.version, (currentTask) => ({
      ...currentTask,
      state: TaskState.NEEDS_CONTINUATION,
      owner: null,
      updatedAt: new Date().toISOString(),
      judgementFeedback: {
        iteration: newIteration,
        maxIterations,
        lastJudgement: {
          reason: judgement.reason,
          missingRequirements: judgement.missingRequirements ?? [],
          evaluatedAt: new Date().toISOString(),
        },
      },
    }));
  };

  return {
    judgeTask,
    markTaskAsCompleted,
    markTaskAsBlocked,
    markTaskForContinuation,
  };
};

/**
 * Judge操作型
 */
export type JudgeOperations = ReturnType<typeof createJudgeOperations>;

// TODO: 将来の実装用 - CI統合時に追加
// const handleFailure = async (
//   task: Task,
//   checkResult: Result<Check, TaskStoreError>
// ): Promise<Result<JudgementResult, TaskStoreError>> => {
//   // リトライ戦略の実装
//   // - 自動リトライ（最大N回）
//   // - エラー内容に応じた対処（コンパイルエラー vs テスト失敗）
//   return createOk({
//     taskId: task.id,
//     success: false,
//     shouldContinue: false,
//     reason: `Task failed: ${checkResult.err.message}`,
//   });
// };
