import type { TaskStore } from '../task-store/interface.ts';
import type { RunnerEffects } from '../runner/runner-effects.ts';
import type { GitEffects } from '../../adapters/vcs/git-effects.ts';
import type { Task } from '../../types/task.ts';
import { TaskState, BlockReason } from '../../types/task.ts';
import type { TaskId, WorktreePath } from '../../types/branded.ts';
import type { TaskStoreError } from '../../types/errors.ts';
import { validationError } from '../../types/errors.ts';
import type { AgentType } from '../../types/config.ts';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr } from 'option-t/plain_result';
import { z } from 'zod';
import { truncateLogForJudge } from './utils/log-utils.ts';

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
  readonly gitEffects: GitEffects;
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
  /** Planner再評価の必要性（true=タスク分解をやり直す、false=不要） */
  shouldReplan: boolean;
  /** 既に実装済みかどうか（true=要件は既に満たされている、false=そうではない） */
  alreadySatisfied: boolean;
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
  shouldReplan: z.boolean().optional().default(false),
  alreadySatisfied: z.boolean().optional().default(false),
});

/**
 * Git変更情報
 */
interface GitChangeInfo {
  /** git diffの出力（変更があるかどうか） */
  hasDiff: boolean;
  /** 変更されたファイル一覧（未コミットの変更） */
  changedFiles: string[];
  /** コミットされた変更があるか */
  hasCommittedChanges: boolean;
  /** コミットで変更されたファイル一覧 */
  committedFiles: string[];
  /** エラーがあった場合のメッセージ */
  error?: string;
}

/**
 * 判定プロンプトを構築
 *
 * WHY: タスクのacceptance criteriaと実行ログを組み合わせて、
 * エージェントが判定に必要な情報を提供する
 *
 * WHY: git変更情報を追加することで、Workerが「検証のみ」を行い
 * 実際には何も変更しなかったケースを検出できる
 *
 * @param task タスク情報
 * @param runLog 実行ログ内容
 * @param gitChangeInfo Git変更情報
 * @returns 判定プロンプト
 */
const buildJudgementPrompt = (task: Task, runLog: string, gitChangeInfo: GitChangeInfo): string => {
  const gitSection = `
GIT CHANGE INFORMATION:
- Has uncommitted changes: ${gitChangeInfo.hasDiff}
- Uncommitted files: ${gitChangeInfo.changedFiles.length > 0 ? gitChangeInfo.changedFiles.join(', ') : '(none)'}
- Has committed changes in this branch: ${gitChangeInfo.hasCommittedChanges}
- Committed files: ${gitChangeInfo.committedFiles.length > 0 ? gitChangeInfo.committedFiles.join(', ') : '(none)'}
${gitChangeInfo.error ? `- Git check error: ${gitChangeInfo.error}` : ''}
`;

  return `You are a task completion judge for a multi-agent development system.

TASK INFORMATION:
- Branch: ${task.branch}
- Type: ${task.taskType}
- Context: ${task.context}
- Expected files: ${task.scopePaths.length > 0 ? task.scopePaths.join(', ') : '(not specified)'}

TASK ACCEPTANCE CRITERIA:
${task.acceptance}
${gitSection}
EXECUTION LOG:
${runLog}

Your task:
1. Determine if the acceptance criteria were fully met based on the execution log
2. **CRITICAL**: Check if actual changes were made (git info above)
   - If the task requires creating/modifying files but no git changes exist, the task is NOT complete
   - "Verification passed" without actual file changes means the worker only verified existing files
3. Check if the implementation is complete and functional
4. Identify any missing requirements or issues
5. Decide if the task should continue, be replanned, or fail

Output (JSON only, no additional text):
{
  "success": true/false,
  "reason": "Detailed explanation of your judgement",
  "missingRequirements": ["req1", "req2"],  // Empty array if none
  "shouldContinue": true/false,  // true if worker can fix in next iteration
  "shouldReplan": true/false,    // true if task needs to be broken down by planner
  "alreadySatisfied": true/false  // true if requirements were already met before this execution
}

Rules:
- success=true only if ALL acceptance criteria are met AND actual changes were made (if required)
- **IMPORTANT**: If scopePaths specifies files to create but git shows no changes, success=false
- missingRequirements should list specific unmet criteria

- alreadySatisfied=true if the acceptance criteria were ALREADY satisfied before this worker execution:
  * Worker verified existing code and found it already meets all requirements
  * No changes were needed because the functionality was implemented in a previous iteration
  * Tests pass without any modifications from this worker
  * **CRITICAL**: When alreadySatisfied=true, set success=true (task is complete)

- shouldContinue=true if the worker can fix issues in next iteration:
  * Test failures (can be debugged and fixed)
  * Compilation errors (can be corrected)
  * Minor bugs or incomplete implementations (can be completed)
  * Missing error handling or edge cases (can be added)
  * Code quality issues (can be improved)
  * Partial implementation that can be finished
  * Worker only verified but requirements are NOT yet met (needs implementation)

- shouldContinue=false && shouldReplan=true if task needs restructuring:
  * Task scope is too large for single iteration
  * Task requirements are contradictory or unclear
  * Implementation approach is fundamentally wrong
  * Task depends on missing external resources or prerequisites
  * Current task design makes completion impossible

- shouldContinue=false && shouldReplan=false for complete failures only:
  * Task is physically/logically impossible to complete
  * Critical system constraints prevent any solution

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
/**
 * JSONパース失敗の理由を特定
 */
type ParseFailureReason = 'no_json' | 'invalid_json' | 'validation_failed';

interface ParseResult {
  success: true;
  data: z.infer<typeof AgentJudgementSchema>;
}

interface ParseError {
  success: false;
  reason: ParseFailureReason;
  message: string;
  originalOutput: string;
}

const parseJudgementResult = (output: string): ParseResult | ParseError => {
  // JSONブロックを抽出（マークダウンコードブロックに囲まれている可能性）
  const jsonMatch =
    output.match(/```(?:json)?\s*\n?([^`]+)\n?```/) || output.match(/(\{[\s\S]*\})/);

  if (!jsonMatch || !jsonMatch[1]) {
    return {
      success: false,
      reason: 'no_json',
      message: 'No JSON found in response',
      originalOutput: output,
    };
  }

  const jsonStr = jsonMatch[1];

  try {
    const parsed = JSON.parse(jsonStr.trim());

    // Zodスキーマでバリデーション
    const result = AgentJudgementSchema.safeParse(parsed);

    if (result.success) {
      return { success: true, data: result.data };
    }

    return {
      success: false,
      reason: 'validation_failed',
      message: `Schema validation failed: ${JSON.stringify(result.error.format())}`,
      originalOutput: output,
    };
  } catch (error) {
    return {
      success: false,
      reason: 'invalid_json',
      message: error instanceof Error ? error.message : String(error),
      originalOutput: output,
    };
  }
};

/**
 * JSONパース失敗時のリトライプロンプトを構築
 *
 * WHY: エージェントが不正なレスポンスを返した場合、
 * フィードバックを与えて正しいJSON形式を要求する
 *
 * @param originalPrompt 元のプロンプト
 * @param parseError パースエラー情報
 * @returns リトライ用プロンプト
 */
const buildRetryPrompt = (originalPrompt: string, parseError: ParseError): string => {
  const feedbackByReason: Record<ParseFailureReason, string> = {
    no_json: 'Your response did not contain any JSON object.',
    invalid_json: `Your response contained invalid JSON syntax: ${parseError.message}`,
    validation_failed: `Your JSON was missing required fields or had invalid types: ${parseError.message}`,
  };

  const truncatedOutput =
    parseError.originalOutput.length > 500
      ? parseError.originalOutput.slice(0, 500) + '...(truncated)'
      : parseError.originalOutput;

  return `${originalPrompt}

---
IMPORTANT FEEDBACK FROM PREVIOUS ATTEMPT:
${feedbackByReason[parseError.reason]}

Your previous response was:
"""
${truncatedOutput}
"""

Please respond ONLY with a valid JSON object. No markdown code blocks, no explanations before or after.
The JSON must have these required fields: success (boolean), reason (string)
Optional fields: missingRequirements (string[]), shouldContinue (boolean), shouldReplan (boolean)

Example:
{"success": false, "reason": "Tests failed due to type errors", "missingRequirements": ["Fix type errors"], "shouldContinue": true, "shouldReplan": false}`;
};

/**
 * Judge操作を提供するファクトリ関数
 *
 * @param deps Judge依存関係
 * @returns Judge操作オブジェクト
 */
export const createJudgeOperations = (deps: JudgeDeps) => {
  /**
   * Git変更情報を取得
   *
   * WHY: Workerが「検証のみ」を行い実際には何も変更しなかったケースを検出するため
   *
   * @param worktreePath worktreeのパス
   * @param task タスク情報（baseCommit を使用）
   * @returns Git変更情報
   */
  const getGitChangeInfo = async (
    worktreePath: WorktreePath,
    task: Task,
  ): Promise<GitChangeInfo> => {
    try {
      // 1. 未コミットの変更があるか確認（git status --porcelain）
      const statusResult = await deps.gitEffects.getStatus(worktreePath);
      let hasDiff = false;
      let changedFiles: string[] = [];

      if (statusResult.ok) {
        const status = statusResult.val;
        // staged, modified, untrackedを結合して変更ファイル一覧を取得
        changedFiles = [...status.staged, ...status.modified, ...status.untracked];
        hasDiff = changedFiles.length > 0;
      }

      // 2. このブランチで新しいコミットが作成されたか確認
      //    ベースコミットからの全変更ファイル一覧を取得
      let hasCommittedChanges = false;
      let committedFiles: string[] = [];

      // WHY: baseCommit がある場合はそれを使用し、Worker の変更のみを正確に取得
      // - baseCommit は worktree 作成直後（マージ完了後）のコミットハッシュ
      // - baseCommit..HEAD で Worker が実際に行った変更のみを取得できる
      // - baseCommit がない場合（後方互換性）は master/main との差分を取得
      const baseRef = task.baseCommit ?? 'master';
      const diffNameResult = await deps.gitEffects.getDiff(worktreePath, [
        '--name-only',
        `${baseRef}..HEAD`,
      ]);
      if (diffNameResult.ok) {
        const diffOutput = diffNameResult.val.trim();
        if (diffOutput.length > 0) {
          committedFiles = diffOutput.split('\n').filter((line) => line.trim().length > 0);
          hasCommittedChanges = true;
        }
      } else if (!task.baseCommit) {
        // baseCommit がなく master も失敗した場合、main で再試行（後方互換性）
        const diffNameResultMain = await deps.gitEffects.getDiff(worktreePath, [
          '--name-only',
          'main..HEAD',
        ]);
        if (diffNameResultMain.ok) {
          const diffOutput = diffNameResultMain.val.trim();
          if (diffOutput.length > 0) {
            committedFiles = diffOutput.split('\n').filter((line) => line.trim().length > 0);
            hasCommittedChanges = true;
          }
        }
      }

      return {
        hasDiff,
        changedFiles,
        hasCommittedChanges,
        committedFiles,
      };
    } catch (error) {
      return {
        hasDiff: false,
        changedFiles: [],
        hasCommittedChanges: false,
        committedFiles: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  /**
   * タスクの完了を判定
   *
   * WHY: Worker実行後のタスクを評価し、完了/継続/停止を判断
   * Phase 5.6: エージェントベースの高度な判定を実装
   *
   * @param tid 判定するタスクのID
   * @param runIdToRead 判定対象の実行ログRunID（実行結果から受け取る）
   * @param worktreePath worktreeのパス（git変更情報の取得用）
   * @returns 判定結果（Result型）
   */
  const judgeTask = async (
    tid: TaskId,
    runIdToRead: string,
    worktreePath?: WorktreePath,
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
        shouldReplan: false,
        alreadySatisfied: false,
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
    const rawRunLog = logResult.val;

    // WHY: 600KB超のログをJudge（claude-haiku）に渡すとno_jsonエラーが発生するため、
    // ログをtruncateして適切なサイズに制限する
    const runLog = truncateLogForJudge(rawRunLog);
    const logTruncated = runLog !== rawRunLog;
    if (logTruncated) {
      const originalKB = Math.round(Buffer.byteLength(rawRunLog, 'utf-8') / 1024);
      const truncatedKB = Math.round(Buffer.byteLength(runLog, 'utf-8') / 1024);
      console.log(`  📄 Log truncated for Judge: ${originalKB}KB → ${truncatedKB}KB`);
    }

    // Git変更情報を取得（worktreePathが指定されている場合のみ）
    let gitChangeInfo: GitChangeInfo = {
      hasDiff: false,
      changedFiles: [],
      hasCommittedChanges: true, // デフォルトはtrue（後方互換性のため）
      committedFiles: [],
    };

    if (worktreePath) {
      gitChangeInfo = await getGitChangeInfo(worktreePath, task);
    }

    // エージェントに判定を依頼
    const judgementPrompt = buildJudgementPrompt(task, runLog, gitChangeInfo);

    const attemptLimit = deps.judgeTaskRetries;
    let lastError: unknown;
    let currentPrompt = judgementPrompt;

    for (let attempt = 1; attempt <= attemptLimit; attempt++) {
      const agentResult =
        deps.agentType === 'claude'
          ? await deps.runnerEffects.runClaudeAgent(currentPrompt, deps.appRepoPath, deps.model)
          : await deps.runnerEffects.runCodexAgent(currentPrompt, deps.appRepoPath, deps.model);

      if (agentResult.ok) {
        const judgeResponse = agentResult.val.finalResponse ?? '';

        // WHY: Judgeレスポンスをログに記録することで、no_jsonエラー時のデバッグを容易にする
        await deps.runnerEffects.appendLog(
          runIdToRead,
          `\n[JUDGE_RESPONSE attempt=${attempt}/${attemptLimit}]\n${judgeResponse}\n[/JUDGE_RESPONSE]\n`,
        );

        const parseResult = parseJudgementResult(judgeResponse);

        if (parseResult.success) {
          return createOk({
            taskId: tid,
            success: parseResult.data.success,
            shouldContinue: parseResult.data.shouldContinue,
            shouldReplan: parseResult.data.shouldReplan,
            alreadySatisfied: parseResult.data.alreadySatisfied,
            reason: parseResult.data.reason,
            missingRequirements: parseResult.data.missingRequirements,
          });
        }

        // JSONパース失敗 - リトライ可能なら再試行
        if (attempt < attemptLimit) {
          console.log(
            `  ⚠️ Judge response was not valid JSON (${parseResult.reason}), retrying... (attempt ${attempt + 1}/${attemptLimit})`,
          );
          // フィードバック付きプロンプトで再試行
          currentPrompt = buildRetryPrompt(judgementPrompt, parseResult);
          continue;
        }

        // 最大リトライ回数到達
        console.error('❌ Failed to parse judge response after all retries');
        console.error(`   Last error: ${parseResult.reason} - ${parseResult.message}`);
        return createErr(
          validationError(
            `Failed to parse judge response: ${parseResult.reason} - ${parseResult.message}`,
          ),
        );
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
   * タスクをスキップ状態に更新
   *
   * WHY: 要件が既に満たされている場合、タスクを実行せずにスキップする
   *      DONEとは異なり、このイテレーションでは何も変更されていないことを示す
   *
   * @param tid タスクID
   * @param reason スキップ理由
   * @returns 更新後のタスク（Result型）
   */
  const markTaskAsSkipped = async (
    tid: TaskId,
    reason: string,
  ): Promise<Result<Task, TaskStoreError>> => {
    const taskResult = await deps.taskStore.readTask(tid);
    if (!taskResult.ok) {
      return taskResult;
    }

    const task = taskResult.val;

    return await deps.taskStore.updateTaskCAS(tid, task.version, (currentTask) => ({
      ...currentTask,
      state: TaskState.SKIPPED,
      owner: null,
      updatedAt: new Date().toISOString(),
      skipReason: reason,
    }));
  };

  /**
   * タスクをブロック状態に更新
   *
   * WHY: Phase 1で追加 - BLOCKED理由を記録することで、統合ブランチからの再試行可否を判定できる
   *
   * @param tid タスクID
   * @param options オプション（reason: BLOCKED理由、message: 詳細メッセージ）
   * @returns 更新後のタスク（Result型）
   */
  const markTaskAsBlocked = async (
    tid: TaskId,
    options?: { reason?: typeof BlockReason[keyof typeof BlockReason]; message?: string },
  ): Promise<Result<Task, TaskStoreError>> => {
    const taskResult = await deps.taskStore.readTask(tid);
    if (!taskResult.ok) {
      return taskResult;
    }

    const task = taskResult.val;

    return await deps.taskStore.updateTaskCAS(tid, task.version, (currentTask) => ({
      ...currentTask,
      state: TaskState.BLOCKED,
      blockReason: options?.reason ?? null,
      blockMessage: options?.message ?? null,
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
    markTaskAsSkipped,
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
