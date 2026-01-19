import type { TaskStore } from '../task-store/interface.ts';
import type { RunnerEffects } from '../runner/runner-effects.ts';
import type { Task } from '../../types/task.ts';
import { TaskState } from '../../types/task.ts';
import type { TaskId } from '../../types/branded.ts';
import type { TaskStoreError } from '../../types/errors.ts';
import { validationError } from '../../types/errors.ts';
import type { AgentType } from '../../types/config.ts';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr, isErr } from 'option-t/plain_result';
import { z } from 'zod';

/**
 * Judge依存関係
 */
export interface JudgeDeps {
  readonly taskStore: TaskStore;
  readonly runnerEffects: RunnerEffects;
  readonly appRepoPath: string;
  readonly agentType: AgentType;
  readonly model: string;
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

    console.error('❌ Agent judgement validation failed:', result.error.format());
    return undefined;
  } catch (error) {
    console.error('❌ Failed to parse agent judgement:', error);
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
   * @returns 判定結果（Result型）
   */
  const judgeTask = async (tid: TaskId): Promise<Result<JudgementResult, TaskStoreError>> => {
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

    // 実行ログを読み込み
    // latestRunIdを使用（task.idからでは見つからないため）
    const runIdToRead = task.latestRunId;
    if (!runIdToRead) {
      return createErr(validationError(`No latestRunId for task ${tid}`));
    }

    const logResult = await deps.runnerEffects.readLog(runIdToRead);
    if (!logResult.ok) {
      // RunnerErrorをTaskStoreErrorに変換
      return createErr(validationError(`Failed to read log: ${logResult.err.message}`));
    }
    const runLog = logResult.val;

    // エージェントに判定を依頼
    const judgementPrompt = buildJudgementPrompt(task, runLog);

    const agentResult =
      deps.agentType === 'claude'
        ? await deps.runnerEffects.runClaudeAgent(judgementPrompt, deps.appRepoPath, deps.model)
        : await deps.runnerEffects.runCodexAgent(judgementPrompt, deps.appRepoPath, deps.model);

    if (isErr(agentResult)) {
      console.warn(`⚠️  Judge agent execution failed: ${agentResult.err.message}`);
      // エージェント失敗時は簡易判定にフォールバック
      return createOk({
        taskId: tid,
        success: true,
        shouldContinue: false,
        reason: 'Task completed (judge agent failed - fallback to simple judgement)',
      });
    }

    // エージェント応答をパース
    const parsedJudgement = parseJudgementResult(agentResult.val.finalResponse ?? '');

    if (!parsedJudgement) {
      console.warn('⚠️  Failed to parse judge agent response - using fallback judgement');
      // パース失敗時は簡易判定にフォールバック
      return createOk({
        taskId: tid,
        success: true,
        shouldContinue: false,
        reason: 'Task completed (failed to parse judge response - fallback to simple judgement)',
      });
    }

    // 判定結果を返す
    return createOk({
      taskId: tid,
      success: parsedJudgement.success,
      shouldContinue: parsedJudgement.shouldContinue,
      reason: parsedJudgement.reason,
      missingRequirements: parsedJudgement.missingRequirements,
    });
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
   * タスクを継続実行のためにREADY状態に戻し、判定フィードバックを記録
   *
   * WHY: Judgeが「未完了だが継続可能」と判定した場合、フィードバックを付けて再実行する
   *
   * @param tid タスクID
   * @param judgement 判定結果
   * @param maxIterations 最大リトライ回数（デフォルト: 3）
   * @returns 更新後のタスク（Result型）
   */
  const markTaskForContinuation = async (
    tid: TaskId,
    judgement: JudgementResult,
    maxIterations = 3,
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
      return createErr(
        validationError(`Task ${tid} exceeded max iterations (${maxIterations})`),
      );
    }

    return await deps.taskStore.updateTaskCAS(tid, task.version, (currentTask) => ({
      ...currentTask,
      state: TaskState.READY,
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
