import type { TaskStore } from '../task-store/interface.ts';
import type { RunnerEffects } from '../runner/runner-effects.ts';
import type { PlannerSessionEffects } from './planner-session-effects.ts';
import { createInitialTask, TaskState, type Task, BlockReason } from '../../types/task.ts';
import { taskId, repoPath, branchName, runId } from '../../types/branded.ts';
import { randomUUID } from 'node:crypto';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr, isErr } from 'option-t/plain_result';
import type { TaskStoreError } from '../../types/errors.ts';
import { ioError } from '../../types/errors.ts';
import { createInitialRun, RunStatus } from '../../types/run.ts';
import { z } from 'zod';
import {
  createPlannerSession,
  type StructureValidation,
  type RefinementConfig,
} from '../../types/planner-session.ts';
import path from 'node:path';
import { truncateSummary } from './utils/log-utils.ts';
import { extractSessionShort } from './task-helpers.ts';
import { TaskBreakdownSchema, type TaskBreakdown } from '../../types/task-breakdown.ts';

/**
 * Levenshtein距離を計算
 *
 * WHY: タスクの受け入れ基準の類似度を判定するために使用
 *
 * @param str1 文字列1
 * @param str2 文字列2
 * @returns Levenshtein距離
 */
const calculateLevenshteinDistance = (str1: string, str2: string): number => {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix: number[][] = [];

  // 初期化
  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0]![j] = j;
  }

  // 距離計算
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1, // 削除
        matrix[i]![j - 1]! + 1, // 挿入
        matrix[i - 1]![j - 1]! + cost, // 置換
      );
    }
  }

  return matrix[len1]![len2]!;
};

/**
 * 2つの文字列の類似度を計算（0-1の範囲）
 *
 * WHY: Levenshtein距離を正規化して類似度として使用
 *
 * @param str1 文字列1
 * @param str2 文字列2
 * @returns 類似度（0: 完全に異なる, 1: 完全に同じ）
 */
const calculateSimilarity = (str1: string, str2: string): number => {
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) return 1.0;

  const distance = calculateLevenshteinDistance(str1, str2);
  return 1.0 - distance / maxLen;
};

/**
 * Planner依存関係
 */
export interface PlannerDeps {
  readonly taskStore: TaskStore;
  readonly runnerEffects: RunnerEffects;
  readonly sessionEffects: PlannerSessionEffects;
  readonly appRepoPath: string;
  readonly coordRepoPath: string;
  readonly agentType: 'claude' | 'codex';
  readonly model: string;
  readonly judgeModel: string;
  readonly plannerQualityRetries?: number;
  readonly qualityThreshold?: number;
  readonly strictContextValidation?: boolean;
  readonly maxTaskDuration?: number;
  readonly maxTasks?: number;
  /**
   * Plan品質評価用Judgeのエージェントタイプ（オプショナル）
   * 設定がなければ `agentType` にフォールバック
   */
  readonly planQualityJudgeAgentType?: 'claude' | 'codex';
  /**
   * Plan品質評価用Judgeのモデル（オプショナル）
   * 設定がなければ `judgeModel` にフォールバック
   */
  readonly planQualityJudgeModel?: string;
}

/**
 * タスク分解結果
 */
export interface PlanningResult {
  /** 生成されたタスクIDの配列 */
  taskIds: string[];
  /** 実行ログID */
  runId: string;
}

/**
 * タスク品質評価結果
 *
 * WHY: Plannerが生成したタスクの品質を自動評価し、
 *      品質が不十分な場合はフィードバック付きで再生成するため
 */
export interface TaskQualityJudgement {
  /** 品質が許容可能か */
  isAcceptable: boolean;
  /** 品質問題のリスト */
  issues: string[];
  /** 改善提案のリスト */
  suggestions: string[];
  /** 総合スコア（0-100） */
  overallScore?: number;
}

/**
 * タスク品質評価結果のZodスキーマ
 */
export const TaskQualityJudgementSchema = z.object({
  isAcceptable: z.boolean(),
  issues: z.array(z.string()),
  suggestions: z.array(z.string()),
  overallScore: z.number().min(0).max(100).optional(),
});

/**
 * 最終完了判定結果
 *
 * WHY: 全タスク完了後に元のユーザー指示が本当に達成されたかを評価
 */
export interface FinalCompletionJudgement {
  /** 元の指示が完全に達成されたか */
  isComplete: boolean;
  /** 達成できていない側面のリスト */
  missingAspects: string[];
  /** 追加で必要なタスクの提案 */
  additionalTaskSuggestions: string[];
  /** 達成度スコア（0-100） */
  completionScore?: number;
  /** コード変更分析（オプショナル） */
  codeChangeAnalysis?: {
    /** タスクから期待される変更 */
    expectedChanges: string[];
    /** 実際に観測された変更 */
    actualChanges: string[];
    /** 期待と実際の不一致 */
    mismatches: string[];
  };
}

/**
 * 最終完了判定結果のZodスキーマ
 */
export const FinalCompletionJudgementSchema = z.object({
  isComplete: z.boolean(),
  missingAspects: z.array(z.string()),
  additionalTaskSuggestions: z.array(z.string()),
  completionScore: z.number().min(0).max(100).optional(),
  codeChangeAnalysis: z
    .object({
      expectedChanges: z.array(z.string()),
      actualChanges: z.array(z.string()),
      mismatches: z.array(z.string()),
    })
    .optional(),
});

/**
 * TaskBreakdownスキーマバージョン
 *
 * WHY: 将来的なスキーマ変更時のマイグレーション対応のため
 */
export const TASK_BREAKDOWN_SCHEMA_VERSION = 2;

/**
 * 生のタスクIDから一意のタスクIDを生成
 *
 * WHY: 異なるセッションで同じタスクID（task-1, task-2など）が生成されても衝突しないよう、
 *      セッションIDを含めて一意にする
 *
 * @param rawId 生のタスクID（"task-1"など）
 * @param sessionShort セッション短縮ID
 * @returns 一意のタスクID（"task-7682b3a8-1"など）
 */
const makeUniqueTaskId = (rawId: string, sessionShort: string): string => {
  const baseId = rawId.replace(/^task-/, '');
  return `task-${sessionShort}-${baseId}`;
};

/**
 * ブランチ名にタスクIDを付加して衝突を回避
 *
 * WHY: 異なるセッションで同じブランチ名が生成される可能性があり、
 *      既存ブランチとの衝突を避けるためタスクIDを含める
 *
 * @param originalBranch 元のブランチ名（"feature/auth"など）
 * @param taskIdStr タスクID（"task-7682b3a8-1"など）
 * @returns タスクIDを含むブランチ名（"feature/auth-task-7682b3a8-1"など）
 */
const makeBranchNameWithTaskId = (originalBranch: string, taskIdStr: string): string => {
  return `${originalBranch}-${taskIdStr}`;
};

/**
 * Planner操作を提供するファクトリ関数
 *
 * @param deps Planner依存関係
 * @returns Planner操作オブジェクト
 */
export const createPlannerOperations = (deps: PlannerDeps) => {
  /**
   * タスク品質を評価
   *
   * 生成されたタスクの品質をJudgeエージェントに評価させる。
   *
   * WHY: 低品質なタスクの実行を防ぐため、Planner生成直後に品質チェック
   *
   * @param userInstruction 元のユーザー指示
   * @param tasks 生成されたタスク配列
   * @param previousFeedback 前回のフィードバック（オプション）
   * @returns 品質評価結果
   */
  const judgeTaskQuality = async (
    userInstruction: string,
    tasks: TaskBreakdown[],
    previousFeedback?: string,
  ): Promise<TaskQualityJudgement> => {
    const qualityPrompt = buildTaskQualityPrompt(
      userInstruction,
      tasks,
      deps.strictContextValidation ?? false,
      deps.maxTaskDuration ?? 4,
      previousFeedback,
    );

    // Plan品質評価用モデルの選択
    // WHY: planQualityJudge設定がある場合はそちらを優先し、
    //      なければ通常のJudge設定にフォールバック
    const judgeAgentType = deps.planQualityJudgeAgentType ?? deps.agentType;
    const judgeModelToUse = deps.planQualityJudgeModel ?? deps.judgeModel;

    const runResult =
      judgeAgentType === 'claude'
        ? await deps.runnerEffects.runClaudeAgent(qualityPrompt, deps.appRepoPath, judgeModelToUse)
        : await deps.runnerEffects.runCodexAgent(qualityPrompt, deps.appRepoPath, judgeModelToUse);

    if (isErr(runResult)) {
      console.warn(`⚠️  Quality judge failed: ${runResult.err.message}, accepting by default`);
      return {
        isAcceptable: true,
        issues: [],
        suggestions: [],
      };
    }

    const judgement = parseQualityJudgement(runResult.val.finalResponse || '');
    return judgement;
  };

  /**
   * ユーザー指示からタスクを分解
   *
   * @param userInstruction ユーザーの指示（例: "TODOアプリを作る"）
   * @returns タスク分解結果（Result型）
   */
  const planTasks = async (
    userInstruction: string,
  ): Promise<Result<PlanningResult, TaskStoreError>> => {
    const sessionId = `planner-${randomUUID()}`;
    const maxRetries = deps.plannerQualityRetries ?? 5;

    const appendPlanningLog = async (content: string): Promise<void> => {
      const logResult = await deps.runnerEffects.appendLog(sessionId, content);
      if (isErr(logResult)) {
        console.warn(`⚠️  Failed to write planner log: ${logResult.err.message}`);
      }
    };

    const plannerLogPath = path.join(deps.coordRepoPath, 'runs', `${sessionId}.log`);
    const plannerMetadataPath = path.join(deps.coordRepoPath, 'runs', `${sessionId}.json`);

    console.log(`📝 Starting task planning for instruction: "${userInstruction}"`);
    console.log(`🆔 Planner Run ID: ${sessionId}`);
    console.log(`📄 Planner Log Path: ${plannerLogPath}`);
    console.log(`🗂️  Planner Metadata Path: ${plannerMetadataPath}`);

    const planningRun = createInitialRun({
      id: runId(sessionId),
      taskId: taskId(sessionId),
      agentType: deps.agentType,
      logPath: plannerLogPath,
    });

    const ensureRunsResult = await deps.runnerEffects.ensureRunsDir();
    if (isErr(ensureRunsResult)) {
      return createErr(ioError('planTasks.ensureRunsDir', ensureRunsResult.err));
    }

    const saveRunResult = await deps.runnerEffects.saveRunMetadata(planningRun);
    if (isErr(saveRunResult)) {
      return createErr(ioError('planTasks.saveRunMetadata', saveRunResult.err));
    }

    const initLogResult = await deps.runnerEffects.initializeLogFile(planningRun);
    if (isErr(initLogResult)) {
      return createErr(ioError('planTasks.initializeLogFile', initLogResult.err));
    }

    await appendPlanningLog(`=== Planning Start ===\n`);
    await appendPlanningLog(`Instruction: ${userInstruction}\n`);

    // 品質評価ループ
    let taskBreakdowns: TaskBreakdown[] = [];
    let accumulatedFeedback: string | undefined = undefined;
    let previousFullResponse: string | undefined = undefined;
    let consecutiveJsonErrors = 0;
    const maxConsecutiveJsonErrors = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await appendPlanningLog(`\n--- Attempt ${attempt}/${maxRetries} ---\n`);

      // 1. Plannerプロンプトを構築
      const maxTaskDuration = deps.maxTaskDuration ?? 4;
      const maxTasks = deps.maxTasks ?? 5;
      const planningPrompt = accumulatedFeedback
        ? buildPlanningPromptWithFeedback(
            userInstruction,
            accumulatedFeedback,
            maxTaskDuration,
            maxTasks,
          )
        : buildPlanningPrompt(userInstruction, maxTaskDuration, maxTasks);

      // ログには省略版を書く（重複を避けるため）
      const promptForLog = accumulatedFeedback
        ? formatFeedbackForLog(planningPrompt)
        : planningPrompt;
      await appendPlanningLog(`Prompt:\n${promptForLog}\n\n`);

      // 2. エージェントを実行
      // WHY: 役割ごとに最適なモデルを使用（Config から取得）
      const runResult =
        deps.agentType === 'claude'
          ? await deps.runnerEffects.runClaudeAgent(planningPrompt, deps.appRepoPath, deps.model!, sessionId)
          : await deps.runnerEffects.runCodexAgent(planningPrompt, deps.appRepoPath, deps.model, sessionId);

      // 2. エージェント実行結果の確認
      if (isErr(runResult)) {
        await appendPlanningLog(`\n=== Planner Agent Error ===\n`);
        await appendPlanningLog(`${runResult.err.message}\n`);

        if (attempt === maxRetries) {
          const failedRun = {
            ...planningRun,
            status: RunStatus.FAILURE,
            finishedAt: new Date().toISOString(),
            errorMessage: `Planner agent execution failed after ${maxRetries} attempts: ${runResult.err.message}`,
          };
          await deps.runnerEffects.saveRunMetadata(failedRun);

          return createErr(
            ioError(
              'planTasks.runAgent',
              `Planner agent execution failed after ${maxRetries} attempts: ${runResult.err.message}`,
            ),
          );
        }

        // 再試行
        continue;
      }

      // 3. エージェント出力をパース
      const finalResponse = runResult.val.finalResponse || '';
      previousFullResponse = finalResponse; // 次回のフィードバックで使用
      await appendPlanningLog(`\n=== Planner Agent Output ===\n`);
      await appendPlanningLog(`${finalResponse}\n`);

      const parseResult = parseAgentOutputWithErrors(finalResponse);

      // パースエラーをログに記録
      if (parseResult.errors.length > 0) {
        await appendPlanningLog(`\n=== Validation Errors ===\n`);
        parseResult.errors.forEach((err) => {
          appendPlanningLog(`${err}\n`);
        });
      }

      // 有効なタスクが1つもない場合
      if (parseResult.tasks.length === 0) {
        const errorMsg =
          parseResult.errors.length > 0
            ? `No valid task breakdowns. Validation errors: ${parseResult.errors.join('; ')}`
            : 'No valid task breakdowns found in agent output';

        await appendPlanningLog(`\n❌ ${errorMsg}\n`);

        // JSON構文エラーかどうかを判定
        const isJsonParseError = parseResult.errors.some((err) =>
          err.includes('JSON parse failed'),
        );

        if (isJsonParseError) {
          consecutiveJsonErrors++;
          await appendPlanningLog(
            `⚠️  JSON parse error count: ${consecutiveJsonErrors}/${maxConsecutiveJsonErrors}\n`,
          );

          if (consecutiveJsonErrors >= maxConsecutiveJsonErrors) {
            const failedRun = {
              ...planningRun,
              status: RunStatus.FAILURE,
              finishedAt: new Date().toISOString(),
              errorMessage: `${errorMsg} (${consecutiveJsonErrors} consecutive JSON parse errors)`,
            };
            await deps.runnerEffects.saveRunMetadata(failedRun);

            return createErr(
              ioError(
                'planTasks.parseOutput',
                `${errorMsg} (${consecutiveJsonErrors} consecutive JSON parse errors)`,
              ),
            );
          }

          // JSON構文エラーはattemptカウントを消費しない（再試行）
          attempt--;
          accumulatedFeedback = `${errorMsg}\n\nIMPORTANT: Previous output had JSON syntax errors. Ensure you output ONLY valid JSON without any extra text or malformed strings.`;
          continue;
        } else {
          // JSON構文エラーではない検証エラーの場合はカウントをリセット
          consecutiveJsonErrors = 0;
        }

        if (attempt === maxRetries) {
          const failedRun = {
            ...planningRun,
            status: RunStatus.FAILURE,
            finishedAt: new Date().toISOString(),
            errorMessage: `${errorMsg} (after ${maxRetries} attempts)`,
          };
          await deps.runnerEffects.saveRunMetadata(failedRun);

          return createErr(
            ioError('planTasks.parseOutput', `${errorMsg} (after ${maxRetries} attempts)`),
          );
        }

        // 再試行（パースエラーをフィードバックとして使用）
        accumulatedFeedback = errorMsg;
        continue;
      }

      // JSON構文エラーカウントをリセット（成功したので）
      consecutiveJsonErrors = 0;

      taskBreakdowns = parseResult.tasks;

      // 3. 依存関係の検証（段階的チェック）
      // タスクが1つ以上あるが、依存関係エラーがある場合はクオリティチェックをスキップ
      const hasDependencyErrors = parseResult.errors.some(
        (err) =>
          err.includes('Circular dependencies') || err.includes('depends on non-existent task'),
      );

      if (hasDependencyErrors) {
        const errorMsg = `Dependency validation failed: ${parseResult.errors.join('; ')}`;
        await appendPlanningLog(`\n❌ ${errorMsg}\n`);

        if (attempt === maxRetries) {
          const failedRun = {
            ...planningRun,
            status: RunStatus.FAILURE,
            finishedAt: new Date().toISOString(),
            errorMessage: `${errorMsg} (after ${maxRetries} attempts)`,
          };
          await deps.runnerEffects.saveRunMetadata(failedRun);

          return createErr(
            ioError('planTasks.dependencyValidation', `${errorMsg} (after ${maxRetries} attempts)`),
          );
        }

        // 依存関係エラーをフィードバックとして再試行
        accumulatedFeedback = errorMsg;
        continue;
      }

      // 4. 品質評価
      await appendPlanningLog(`\n=== Quality Evaluation ===\n`);
      const judgement = await judgeTaskQuality(
        userInstruction,
        taskBreakdowns,
        accumulatedFeedback,
      );

      await appendPlanningLog(`Quality acceptable: ${judgement.isAcceptable ? 'YES' : 'NO'}\n`);
      if (judgement.overallScore !== undefined) {
        await appendPlanningLog(`Overall score: ${judgement.overallScore}/100\n`);
      }
      if (judgement.issues.length > 0) {
        await appendPlanningLog(
          `Issues:\n${judgement.issues.map((i, idx) => `  ${idx + 1}. ${i}`).join('\n')}\n`,
        );
      }
      if (judgement.suggestions.length > 0) {
        await appendPlanningLog(
          `Suggestions:\n${judgement.suggestions.map((s, idx) => `  ${idx + 1}. ${s}`).join('\n')}\n`,
        );
      }

      // 品質判定: isAcceptableまたはスコアが閾値以上
      const threshold = deps.qualityThreshold ?? 60;
      const passesScoreThreshold =
        judgement.overallScore !== undefined && judgement.overallScore >= threshold;
      const isQualityAcceptable = judgement.isAcceptable || passesScoreThreshold;

      if (passesScoreThreshold && !judgement.isAcceptable) {
        await appendPlanningLog(
          `\n⚠️  Judge marked as not acceptable, but score ${judgement.overallScore} >= threshold ${threshold}, accepting\n`,
        );
      }

      if (isQualityAcceptable) {
        // 品質OK → タスク保存へ進む
        await appendPlanningLog(`\n✅ Quality check passed\n`);
        break;
      }

      // 品質NG → フィードバックを蓄積して再試行
      await appendPlanningLog(`\n❌ Quality check failed, retrying...\n`);

      if (attempt === maxRetries) {
        // 最大試行回数に達したが品質が許容されない
        const errorMsg = `Task quality not acceptable after ${maxRetries} attempts`;
        await appendPlanningLog(`\n❌ ${errorMsg}\n`);

        const failedRun = {
          ...planningRun,
          status: RunStatus.FAILURE,
          finishedAt: new Date().toISOString(),
          errorMessage: errorMsg,
        };
        await deps.runnerEffects.saveRunMetadata(failedRun);

        return createErr(ioError('planTasks.qualityCheck', errorMsg));
      }

      // 前回の出力とフィードバックを含める（状態を引き継ぐ）
      const previousOutput = JSON.stringify(taskBreakdowns, null, 2);
      accumulatedFeedback = formatFeedbackForRetry(judgement, previousOutput, previousFullResponse);
    }

    // タスクをTaskStoreに保存
    const taskIds: string[] = [];
    const createdTasks: Array<{ id: string; summary: string | null }> = [];
    const errors: string[] = [];

    // プランナーセッションIDの短縮版を使用してタスクIDを一意にする
    const sessionShort = extractSessionShort(sessionId);

    for (const breakdown of taskBreakdowns) {
      const rawTaskId = breakdown.id;
      const uniqueTaskId = makeUniqueTaskId(rawTaskId, sessionShort);
      const task = createInitialTask({
        id: taskId(uniqueTaskId),
        repo: repoPath(deps.appRepoPath),
        branch: branchName(makeBranchNameWithTaskId(breakdown.branch, uniqueTaskId)),
        scopePaths: breakdown.scopePaths,
        acceptance: breakdown.acceptance,
        taskType: breakdown.type,
        context: breakdown.context,
        dependencies: breakdown.dependencies.map((depId) =>
          taskId(makeUniqueTaskId(depId, sessionShort)),
        ),
        summary: breakdown.summary ?? null,
        sessionId: sessionId,
        // 初期タスクは親がないのでnull
        parentSessionId: null,
        // 初期タスクは自身がルート
        rootSessionId: sessionId,
        plannerLogPath: plannerLogPath,
        plannerMetadataPath: plannerMetadataPath,
      });

      const result = await deps.taskStore.createTask(task);
      if (!result.ok) {
        const errorMsg = `Failed to create task ${uniqueTaskId} (from ${rawTaskId}): ${result.err.message}`;
        errors.push(errorMsg);
        await appendPlanningLog(`❌ ${errorMsg}\n`);
        continue;
      }

      taskIds.push(uniqueTaskId);
      createdTasks.push({ id: uniqueTaskId, summary: breakdown.summary ?? null });
    }

    if (taskIds.length > 0) {
      await appendPlanningLog(`\n📋 Generated ${taskIds.length} tasks\n`);
      for (const task of createdTasks) {
        const summaryText = task.summary ? ` - ${truncateSummary(task.summary)}` : '';
        await appendPlanningLog(`  - ${task.id}${summaryText}\n`);
      }
    }

    if (errors.length > 0) {
      await appendPlanningLog(`\n⚠️  Some tasks failed to create:\n`);
      for (const error of errors) {
        await appendPlanningLog(`  - ${error}\n`);
      }
    }

    const completedRun =
      taskIds.length > 0
        ? {
            ...planningRun,
            status: RunStatus.SUCCESS,
            finishedAt: new Date().toISOString(),
            errorMessage: errors.length > 0 ? `Partial success: ${errors.join(', ')}` : null,
          }
        : {
            ...planningRun,
            status: RunStatus.FAILURE,
            finishedAt: new Date().toISOString(),
            errorMessage: errors.length > 0 ? errors.join(', ') : 'No tasks created',
          };
    await deps.runnerEffects.saveRunMetadata(completedRun);

    // セッション情報を保存
    if (taskIds.length > 0) {
      const session = createPlannerSession(sessionId, userInstruction);
      session.generatedTasks = taskBreakdowns;
      session.plannerLogPath = plannerLogPath;
      session.plannerMetadataPath = plannerMetadataPath;
      // 会話履歴を記録（簡易版: プロンプトと応答のみ）
      session.conversationHistory.push({
        role: 'user',
        content: userInstruction,
        timestamp: new Date().toISOString(),
      });
      if (taskBreakdowns.length > 0) {
        session.conversationHistory.push({
          role: 'assistant',
          content: JSON.stringify(taskBreakdowns, null, 2),
          timestamp: new Date().toISOString(),
        });
      }

      const saveSessionResult = await deps.sessionEffects.saveSession(session);
      if (isErr(saveSessionResult)) {
        console.warn(`⚠️  Failed to save planner session: ${saveSessionResult.err.message}`);
      } else {
        await appendPlanningLog(`\n✅ Session saved: ${sessionId}\n`);
      }
    }

    // 一部でもタスク作成に成功していれば成功とみなす
    if (taskIds.length === 0) {
      return createErr(ioError('planTasks', `Failed to create any tasks: ${errors.join(', ')}`));
    }

    return createOk({
      taskIds,
      runId: sessionId,
    });
  };

  /**
   * 実行結果とコード差分を含めた最終完了判定を実行
   *
   * WHY: タスク説明だけでなく実行結果とコード変更を含めることで、
   *      より正確な完了判定を行う
   *
   * @param userInstruction 元のユーザー指示
   * @param completedTaskDescriptions 完了したタスクの説明リスト
   * @param failedTaskDescriptions 失敗したタスクの説明リスト
   * @param completedTaskRunSummaries 完了したタスクの実行サマリーリスト
   * @param codeChanges コード差分（git diff --stat）
   * @returns 最終完了判定結果
   */
  const judgeFinalCompletionWithContext = async (
    userInstruction: string,
    completedTasks: Task[],
    completedTaskDescriptions: string[],
    failedTaskDescriptions: string[],
    completedTaskRunSummaries: string[],
    codeChanges: string,
  ): Promise<FinalCompletionJudgement> => {
    const finalPrompt = buildFinalCompletionPromptWithContext(
      userInstruction,
      completedTasks,
      completedTaskDescriptions,
      failedTaskDescriptions,
      completedTaskRunSummaries,
      codeChanges,
    );

    // Judge用エージェントを実行
    const runResult =
      deps.agentType === 'claude'
        ? await deps.runnerEffects.runClaudeAgent(finalPrompt, deps.appRepoPath, deps.judgeModel)
        : await deps.runnerEffects.runCodexAgent(finalPrompt, deps.appRepoPath, deps.judgeModel);

    if (isErr(runResult)) {
      console.warn(
        `⚠️  Final completion judge failed: ${runResult.err.message}, assuming complete`,
      );
      return {
        isComplete: true,
        missingAspects: [],
        additionalTaskSuggestions: [],
      };
    }

    const judgement = parseFinalCompletionJudgement(runResult.val.finalResponse || '');
    return judgement;
  };

  /**
   * 最終完了判定を実行
   *
   * 全タスク完了後に元のユーザー指示が本当に達成されたかを評価する。
   *
   * WHY: タスクが完了しても、元の指示が完全に達成されていない場合があるため
   *
   * @param userInstruction 元のユーザー指示
   * @param completedTaskDescriptions 完了したタスクの説明リスト
   * @param failedTaskDescriptions 失敗したタスクの説明リスト
   * @returns 最終完了判定結果
   */
  const judgeFinalCompletion = async (
    userInstruction: string,
    completedTaskDescriptions: string[],
    failedTaskDescriptions: string[],
  ): Promise<FinalCompletionJudgement> => {
    const finalPrompt = buildFinalCompletionPrompt(
      userInstruction,
      completedTaskDescriptions,
      failedTaskDescriptions,
    );

    // Judge用エージェントを実行
    const runResult =
      deps.agentType === 'claude'
        ? await deps.runnerEffects.runClaudeAgent(finalPrompt, deps.appRepoPath, deps.judgeModel)
        : await deps.runnerEffects.runCodexAgent(finalPrompt, deps.appRepoPath, deps.judgeModel);

    if (isErr(runResult)) {
      console.warn(
        `⚠️  Final completion judge failed: ${runResult.err.message}, assuming complete`,
      );
      return {
        isComplete: true,
        missingAspects: [],
        additionalTaskSuggestions: [],
      };
    }

    const judgement = parseFinalCompletionJudgement(runResult.val.finalResponse || '');
    return judgement;
  };

  /**
   * 再実行対象タスクを準備
   *
   * WHY: 統合ブランチからの再実行前に、タスク状態をREADYにリセットし、
   *      integrationRetriedフラグを設定する
   *
   * @param task 再実行対象タスク
   * @returns リセット後のタスク（Result型）
   */
  const prepareForRetry = async (
    task: Task,
  ): Promise<Result<Task, TaskStoreError>> => {
    // CAS更新でタスク状態をリセット
    return await deps.taskStore.updateTaskCAS(task.id, task.version, (currentTask) => {
      const updatedTask = {
        ...currentTask,
        state: TaskState.READY,
        owner: null,
        updatedAt: new Date().toISOString(),
      };

      // MAX_RETRIES からの再試行の場合、フラグを立てる
      if (currentTask.blockReason === BlockReason.MAX_RETRIES) {
        updatedTask.integrationRetried = true;
        updatedTask.blockReason = null;  // 理由をクリア
      }

      // SYSTEM_ERROR_TRANSIENT の場合もクリア
      if (currentTask.blockReason === BlockReason.SYSTEM_ERROR_TRANSIENT) {
        updatedTask.blockReason = null;
      }

      return updatedTask;
    });
  };

  /**
   * 既存セッションを継続して追加タスクを生成
   *
   * 会話履歴を維持しながら、不足している側面に対する追加タスクを生成する。
   *
   * WHY: 最終完了判定で不足している側面が見つかった場合、
   *      前回のコンテキストを保持したまま追加タスクを生成するため
   *
   * @param sessionId 継続するセッションID
   * @param missingAspects 達成できていない側面のリスト
   * @returns タスク分解結果（Result型）
   */
  const planAdditionalTasks = async (
    sessionId: string,
    missingAspects: string[],
  ): Promise<Result<PlanningResult, TaskStoreError>> => {
    // セッションを読み込み
    const loadResult = await deps.sessionEffects.loadSession(sessionId);
    if (isErr(loadResult)) {
      return createErr(
        ioError(
          'planAdditionalTasks.loadSession',
          `Failed to load session: ${loadResult.err.message}`,
        ),
      );
    }

    const session = loadResult.val;

    // 追加タスク生成用のRunIDを作成
    const additionalRunId = `planner-additional-${randomUUID()}`;

    const appendPlanningLog = async (content: string): Promise<void> => {
      const logResult = await deps.runnerEffects.appendLog(additionalRunId, content);
      if (isErr(logResult)) {
        console.warn(`⚠️  Failed to write planner log: ${logResult.err.message}`);
      }
    };

    await appendPlanningLog(`=== Additional Task Planning Start ===\n`);
    await appendPlanningLog(`Session ID: ${sessionId}\n`);
    await appendPlanningLog(`Original Instruction: ${session.instruction}\n`);
    await appendPlanningLog(
      `Missing Aspects:\n${missingAspects.map((a, i) => `  ${i + 1}. ${a}`).join('\n')}\n`,
    );

    const additionalPlannerLogPath = path.join(
      deps.coordRepoPath,
      'runs',
      `${additionalRunId}.log`,
    );
    const additionalPlannerMetadataPath = path.join(
      deps.coordRepoPath,
      'runs',
      `${additionalRunId}.json`,
    );

    const planningRun = createInitialRun({
      id: runId(additionalRunId),
      taskId: taskId(additionalRunId),
      agentType: deps.agentType,
      logPath: additionalPlannerLogPath,
    });

    const ensureRunsResult = await deps.runnerEffects.ensureRunsDir();
    if (isErr(ensureRunsResult)) {
      return createErr(ioError('planAdditionalTasks.ensureRunsDir', ensureRunsResult.err));
    }

    const saveRunResult = await deps.runnerEffects.saveRunMetadata(planningRun);
    if (isErr(saveRunResult)) {
      return createErr(ioError('planAdditionalTasks.saveRunMetadata', saveRunResult.err));
    }

    const initLogResult = await deps.runnerEffects.initializeLogFile(planningRun);
    if (isErr(initLogResult)) {
      return createErr(ioError('planAdditionalTasks.initializeLogFile', initLogResult.err));
    }

    console.log(`📝 Additional task planning started`);
    console.log(`🆔 Additional Planner Run ID: ${additionalRunId}`);
    console.log(`📄 Additional Planner Log Path: ${additionalPlannerLogPath}`);
    console.log(`🗂️  Additional Planner Metadata Path: ${additionalPlannerMetadataPath}`);

    // WHY: Phase 2 - 未完了タスクの再実行サポート
    //      統合ブランチからの実行により、未完了タスクが完了する可能性がある
    await appendPlanningLog(`\n=== Phase 2: Checking for Retryable Tasks ===\n`);

    // 全タスクを取得して、再実行対象タスクを抽出
    const allTasksResult = await deps.taskStore.listTasks();
    if (isErr(allTasksResult)) {
      return createErr(
        ioError('planAdditionalTasks.listTasks', `Failed to list tasks: ${allTasksResult.err.message}`),
      );
    }

    const allTasks = allTasksResult.val;

    // WHY: session.sessionId から sessionShort を抽出し、現在のセッションのタスクのみをフィルタリング
    //      これにより、過去のオーケストレーション実行からの無関係なタスクが混入するのを防ぐ
    const sessionShort = extractSessionShort(session.sessionId);
    const sessionTaskPrefix = `task-${sessionShort}-`;

    // 再実行対象タスクの抽出
    // WHY: 5.2 エッジケース - 再実行対象タスクが多数ある場合の制限
    const MAX_RETRY_TASKS = 5;

    const candidateRetryTasks = allTasks.filter(task => {
      // WHY: 現在のセッションのタスクのみを対象にする
      if (!String(task.id).startsWith(sessionTaskPrefix)) {
        return false;
      }

      // NEEDS_CONTINUATION は常に再実行対象
      if (task.state === TaskState.NEEDS_CONTINUATION) {
        return true;
      }

      // BLOCKED (MAX_RETRIES) かつ未再試行
      if (
        task.state === TaskState.BLOCKED &&
        task.blockReason === BlockReason.MAX_RETRIES &&
        !task.integrationRetried
      ) {
        return true;
      }

      // SYSTEM_ERROR_TRANSIENT も再試行対象（1回のみ）
      if (
        task.state === TaskState.BLOCKED &&
        task.blockReason === BlockReason.SYSTEM_ERROR_TRANSIENT &&
        !task.integrationRetried  // 統合ブランチからの再試行は1回のみ
      ) {
        return true;
      }

      return false;
    });

    // 優先順位でソート：NEEDS_CONTINUATION > それ以外（作成順）
    const sortedRetryTasks = candidateRetryTasks.sort((a, b) => {
      // NEEDS_CONTINUATION を優先
      if (a.state === TaskState.NEEDS_CONTINUATION && b.state !== TaskState.NEEDS_CONTINUATION) {
        return -1;
      }
      if (b.state === TaskState.NEEDS_CONTINUATION && a.state !== TaskState.NEEDS_CONTINUATION) {
        return 1;
      }

      // それ以外は作成順（IDの辞書順）
      return String(a.id).localeCompare(String(b.id));
    });

    // 上位N件のみ再実行
    const retryableTasks = sortedRetryTasks.slice(0, MAX_RETRY_TASKS);

    await appendPlanningLog(`Found ${candidateRetryTasks.length} candidate retryable tasks\n`);
    if (candidateRetryTasks.length > MAX_RETRY_TASKS) {
      await appendPlanningLog(`  ⚠️  Limited to top ${MAX_RETRY_TASKS} tasks (sorted by priority)\n`);
    }
    await appendPlanningLog(`Processing ${retryableTasks.length} retryable tasks\n`);
    if (retryableTasks.length > 0) {
      for (const task of retryableTasks) {
        await appendPlanningLog(`  - ${task.id} (${task.state}${task.blockReason ? ` / ${task.blockReason}` : ''})\n`);
      }
    }

    // 再実行対象タスクの準備（状態をREADYにリセット）
    const preparedRetryTasks: Task[] = [];
    for (const task of retryableTasks) {
      await appendPlanningLog(`\nPreparing task ${task.id} for retry from integration branch...\n`);
      const prepared = await prepareForRetry(task);
      if (prepared.ok) {
        preparedRetryTasks.push(prepared.val);
        await appendPlanningLog(`  ✅ Task ${task.id} prepared for retry\n`);
      } else {
        await appendPlanningLog(`  ⚠️  Failed to prepare task ${task.id}: ${prepared.err.message}\n`);
      }
    }

    // 未完了タスク情報をプロンプト用に収集
    const incompleteTaskInfo = retryableTasks.map(t => ({
      id: String(t.id),
      state: t.state,
      acceptance: t.acceptance,
      lastError: t.judgementFeedback?.lastJudgement.reason || t.blockMessage || 'N/A',
    }));

    // 会話履歴を含めたプロンプトを構築
    const conversationContext = session.conversationHistory
      .map((msg) => `${msg.role}: ${msg.content}`)
      .join('\n\n');

    // 完了タスク情報を収集（現在のセッションのタスクのみ）
    // WHY: 統合ブランチには完了タスクがマージ済みだが、他のセッションのタスクを含めると
    //      Planner が混乱し、重複検出が誤作動する
    const completedTasks = allTasks.filter(task =>
      task.state === TaskState.DONE &&
      String(task.id).startsWith(sessionTaskPrefix)
    );
    const completedTaskInfo = completedTasks.map(t => ({
      id: String(t.id),
      summary: t.summary || 'N/A',
      acceptance: t.acceptance,
    }));

    // WHY: 完了タスクの具体的な内容をPlannerに伝えることで、同じタスクの再生成を防ぐ
    const completedTaskSection = completedTaskInfo.length > 0
      ? `\n✅ COMPLETED TASKS (DO NOT RECREATE - already in codebase):
${completedTaskInfo.map(t => `- ${t.id}: ${t.summary}\n  Acceptance: ${t.acceptance}`).join('\n')}

CRITICAL: These tasks are ALREADY DONE and merged into the integration branch.
DO NOT recreate any of these tasks or their functionality.
Only create NEW tasks for missing aspects identified below.
`
      : '';

    // WHY: Phase 2 - 未完了タスク情報をプロンプトに含める
    //      Plannerが未完了タスクを参照・依存できるようにする
    const incompleteTaskSection = incompleteTaskInfo.length > 0
      ? `\n🔄 INCOMPLETE TASKS (can be used as dependencies or for context):
${incompleteTaskInfo.map(t => `- ${t.id} (${t.state}): ${t.acceptance}\n  Last error: ${t.lastError}`).join('\n')}

NOTE: These incomplete tasks will be retried from the integration branch alongside your new tasks.
You can:
1. Create new independent tasks
2. Create tasks that depend on incomplete tasks (use EXACT IDs above, e.g., "${incompleteTaskInfo[0]?.id}")
3. The incomplete tasks above will be automatically retried - you don't need to recreate them
`
      : '';

    const additionalPrompt = `Previous conversation:
${conversationContext}

IMPORTANT CONTEXT:
- Your new tasks will be executed from the integration branch, which includes ALL completed work.
- ${completedTaskInfo.length} tasks have been successfully completed and merged into the integration branch.
- Your new tasks should start from task-1 (unique IDs will be assigned automatically).
- Only create dependencies on other NEW tasks you generate in this session (e.g., task-2 depends on task-1).
${completedTaskSection}${incompleteTaskSection}
Based on the above context, the following aspects are still missing:
${missingAspects.map((aspect, i) => `${i + 1}. ${aspect}`).join('\n')}

Generate additional tasks to address ONLY these missing aspects.
DO NOT recreate any completed tasks listed above.

Output format (JSON array):
[
  {
    "id": "task-1",
    "description": "Task description",
    "branch": "feature/branch-name",
    "scopePaths": ["path1/", "path2/"],
    "acceptance": "Acceptance criteria",
    "type": "implementation|documentation|investigation|integration",
    "estimatedDuration": 2.5,
    "context": "Complete context for task execution",
    "dependencies": [],
    "summary": "Short task summary (30-50 chars)"
  }
]

CRITICAL RULES:
1. DO NOT recreate any tasks from the "COMPLETED TASKS" list above
2. Dependencies should ONLY reference NEW tasks (task-1, task-2, etc.) or INCOMPLETE tasks (with full IDs)
3. Focus ONLY on the missing aspects listed above
4. REQUIRED: Every task MUST have a summary field (30-50 characters)

Output only the JSON array, no additional text.`;

    // Issue 3: バリデーション失敗時のリトライ機構
    // WHY: LLMに即座にフィードバックを与えることで、タスク重複を防ぐ
    const MAX_VALIDATION_RETRIES = 3;
    let validationAttempts = 0;
    let taskBreakdowns: ReturnType<typeof parseAgentOutputWithErrors>['tasks'] = [];
    let currentValidationErrors: string[] = [];

    // Issue: JSONパースエラー時のリトライ機構
    // WHY: Claude APIの出力が途中で切れた場合など、再試行で回復できることがある
    const MAX_JSON_PARSE_RETRIES = 3;
    let consecutiveJsonParseErrors = 0;
    let jsonParseErrorFeedback = '';

    // リトライループ: バリデーション成功 or 最大試行回数まで
    do {
      validationAttempts++;

      // プロンプト生成（初回 or リトライ時）
      let promptToUse = additionalPrompt;

      // JSONパースエラーのフィードバックがあれば追加
      if (jsonParseErrorFeedback) {
        promptToUse = additionalPrompt + jsonParseErrorFeedback;
        jsonParseErrorFeedback = ''; // 使用後にクリア
      } else if (validationAttempts > 1) {
        // リトライ時はバリデーションエラーをフィードバックとして追加
        const feedbackSection = `\n\n⚠️ VALIDATION FEEDBACK (Attempt ${validationAttempts}/${MAX_VALIDATION_RETRIES}):\nYour previous task generation failed validation with the following errors:\n${currentValidationErrors.map((err, idx) => `${idx + 1}. ${err}`).join('\n')}\n\nPlease regenerate the tasks, carefully addressing these issues:\n- Ensure no duplicate tasks with completed tasks listed above\n- Ensure every task has a non-empty summary field\n\nOutput only the corrected JSON array, no additional text.`;
        promptToUse = additionalPrompt + feedbackSection;
      }

      await appendPlanningLog(`\nPrompt (attempt ${validationAttempts}):\n${promptToUse}\n\n`);

      // エージェントを実行
      const runResult =
        deps.agentType === 'claude'
          ? await deps.runnerEffects.runClaudeAgent(promptToUse, deps.appRepoPath, deps.model!, additionalRunId)
          : await deps.runnerEffects.runCodexAgent(promptToUse, deps.appRepoPath, deps.model, additionalRunId);

      if (isErr(runResult)) {
        await appendPlanningLog(`\n=== Planner Agent Error ===\n`);
        await appendPlanningLog(`${runResult.err.message}\n`);

        const failedRun = {
          ...planningRun,
          status: RunStatus.FAILURE,
          finishedAt: new Date().toISOString(),
          errorMessage: `Additional task planner agent execution failed: ${runResult.err.message}`,
        };
        await deps.runnerEffects.saveRunMetadata(failedRun);

        return createErr(
          ioError('planAdditionalTasks.runAgent', `Agent execution failed: ${runResult.err.message}`),
        );
      }

      // エージェント出力をパース
      const finalResponse = runResult.val.finalResponse || '';
      await appendPlanningLog(`\n=== Planner Agent Output (attempt ${validationAttempts}) ===\n`);
      await appendPlanningLog(`${finalResponse}\n`);

      const parseResult = parseAgentOutputWithErrors(finalResponse);

      if (parseResult.errors.length > 0) {
        await appendPlanningLog(`\n=== Parse Errors ===\n`);
        parseResult.errors.forEach((err) => {
          appendPlanningLog(`${err}\n`);
        });
      }

      if (parseResult.tasks.length === 0) {
        // WHY: 空配列には2つのケースがある
        // 1. パースエラーがある場合: JSONパースに失敗した（エラー）
        // 2. パースエラーがない場合: エージェントが「追加タスクなし」と判断した（正常）
        if (parseResult.errors.length > 0) {
          const errorMsg = `No valid task breakdowns. Validation errors: ${parseResult.errors.join('; ')}`;
          await appendPlanningLog(`\n❌ ${errorMsg}\n`);

          // JSON構文エラーかどうかを判定
          const isJsonParseError = parseResult.errors.some((err) =>
            err.includes('JSON parse failed') || err.includes('No JSON content found'),
          );

          if (isJsonParseError) {
            consecutiveJsonParseErrors++;
            await appendPlanningLog(
              `⚠️  JSON parse error count: ${consecutiveJsonParseErrors}/${MAX_JSON_PARSE_RETRIES}\n`,
            );

            if (consecutiveJsonParseErrors >= MAX_JSON_PARSE_RETRIES) {
              // 最大リトライ回数に到達
              const failedRun = {
                ...planningRun,
                status: RunStatus.FAILURE,
                finishedAt: new Date().toISOString(),
                errorMessage: `${errorMsg} (${consecutiveJsonParseErrors} consecutive JSON parse errors)`,
              };
              await deps.runnerEffects.saveRunMetadata(failedRun);

              return createErr(
                ioError(
                  'planAdditionalTasks.parseOutput',
                  `${errorMsg} (${consecutiveJsonParseErrors} consecutive JSON parse errors)`,
                ),
              );
            }

            // JSONパースエラーの場合はリトライ（validationAttemptsを消費しない）
            validationAttempts--;
            jsonParseErrorFeedback = `\n\n⚠️ JSON PARSE ERROR (Retry ${consecutiveJsonParseErrors}/${MAX_JSON_PARSE_RETRIES}):\n${errorMsg}\n\nIMPORTANT: Your previous output had JSON syntax errors. Please ensure you output ONLY valid JSON without any extra text, markdown code blocks, or malformed strings.\n\nOutput only the corrected JSON array, no additional text.`;
            continue;
          }

          // JSONパースエラーではない検証エラーの場合はカウントをリセット
          consecutiveJsonParseErrors = 0;

          // その他のバリデーションエラーの場合は即座に終了
          const failedRun = {
            ...planningRun,
            status: RunStatus.FAILURE,
            finishedAt: new Date().toISOString(),
            errorMessage: errorMsg,
          };
          await deps.runnerEffects.saveRunMetadata(failedRun);

          return createErr(ioError('planAdditionalTasks.parseOutput', errorMsg));
        }

        // エージェントが「追加タスクなし」と判断した場合は正常終了
        await appendPlanningLog(`\n✅ No additional tasks needed (agent returned empty array)\n`);

        const successRun = {
          ...planningRun,
          status: RunStatus.SUCCESS,
          finishedAt: new Date().toISOString(),
        };
        await deps.runnerEffects.saveRunMetadata(successRun);

        // WHY: 再実行対象タスクのみを返す（追加タスクはゼロ）
        return createOk({
          taskIds: preparedRetryTasks.map(t => String(t.id)),
          runId: additionalRunId,
        });
      }

      taskBreakdowns = parseResult.tasks;

      // WHY: 防御的プログラミング - LLMの理解に依存せず、プログラムで重複を検出
      /**
       * 新規タスクが完了済みタスクと重複していないか検証
       *
       * @param newTasks 新規タスクリスト
       * @param completedTasks 完了済みタスクリスト
       * @returns 検証結果（エラーがあればエラーメッセージのリスト）
       */
      const validateNoDuplicates = (
        newTasks: typeof taskBreakdowns,
        completedTasks: Task[],
      ): string[] => {
        const validationErrors: string[] = [];

        for (const task of newTasks) {
          // 受け入れ基準の類似度チェック（完全一致または高類似度）
          const duplicate = completedTasks.find((ct) => {
            // 完全一致
            if (ct.acceptance === task.acceptance) return true;

            // 類似度チェック（Levenshtein距離による）
            const similarity = calculateSimilarity(ct.acceptance, task.acceptance);
            return similarity > 0.9; // 90%以上類似で重複と判定
          });

          if (duplicate) {
            validationErrors.push(
              `Task "${task.id}" (${task.summary ?? 'no summary'}) appears to duplicate completed task "${duplicate.id}" (${duplicate.summary ?? 'no summary'}). ` +
                `Acceptance criteria match or are highly similar.`,
            );
          }

          // summary必須チェック
          if (!task.summary || task.summary.trim() === '') {
            validationErrors.push(`Task "${task.id}" is missing required summary field`);
          }
        }

        return validationErrors;
      };

      // バリデーション実行
      currentValidationErrors = validateNoDuplicates(taskBreakdowns, completedTasks);

      if (currentValidationErrors.length > 0) {
        await appendPlanningLog(
          `\n❌ Task validation failed (attempt ${validationAttempts}/${MAX_VALIDATION_RETRIES}):\n`,
        );
        for (const error of currentValidationErrors) {
          await appendPlanningLog(`  - ${error}\n`);
        }

        if (validationAttempts < MAX_VALIDATION_RETRIES) {
          await appendPlanningLog(`\n🔄 Retrying with feedback...\n`);
          // 次のループで再試行
        } else {
          // 最大リトライ回数に到達
          await appendPlanningLog(
            `\n❌ Maximum retry attempts (${MAX_VALIDATION_RETRIES}) reached. Validation failed.\n`,
          );
        }
      } else {
        // バリデーション成功
        await appendPlanningLog(`\n✅ Task validation passed (attempt ${validationAttempts})\n`);
      }
    } while (currentValidationErrors.length > 0 && validationAttempts < MAX_VALIDATION_RETRIES);

    // 最大リトライ後もバリデーションエラーが残る場合
    if (currentValidationErrors.length > 0) {
      const failedRun = {
        ...planningRun,
        status: RunStatus.FAILURE,
        finishedAt: new Date().toISOString(),
        errorMessage: `Task validation failed after ${MAX_VALIDATION_RETRIES} attempts: ${currentValidationErrors.join('; ')}`,
      };
      await deps.runnerEffects.saveRunMetadata(failedRun);

      return createErr(
        ioError(
          'planAdditionalTasks.validation',
          `Validation failed after ${MAX_VALIDATION_RETRIES} attempts: ${currentValidationErrors.join('; ')}`,
        ),
      );
    }

    // タスクをTaskStoreに保存
    const taskIds: string[] = [];
    const errors: string[] = [];

    // プランナーセッションIDの短縮版を使用してタスクIDを一意にする
    // WHY: 追加タスクは additionalRunId から sessionShort を抽出（元の session.sessionId とは異なる）
    const additionalSessionShort = extractSessionShort(additionalRunId);

    // 親子関係の設定
    // WHY: continue で追加されたタスクは元セッションを参照可能にする
    const parentSessionId = sessionId;  // 元のセッションID
    // WHY: rootSessionId は集計単位として、最初のセッションを追跡
    const rootSessionId = session.rootSessionId ?? sessionId;

    for (const breakdown of taskBreakdowns) {
      const rawTaskId = breakdown.id;
      const uniqueTaskId = makeUniqueTaskId(rawTaskId, additionalSessionShort);
      const task = createInitialTask({
        id: taskId(uniqueTaskId),
        repo: repoPath(deps.appRepoPath),
        branch: branchName(makeBranchNameWithTaskId(breakdown.branch, uniqueTaskId)),
        scopePaths: breakdown.scopePaths,
        acceptance: breakdown.acceptance,
        taskType: breakdown.type,
        context: breakdown.context,
        dependencies: breakdown.dependencies.map((depId) => {
          // WHY: Phase 2 - 未完了タスクへの依存をサポート
          //      実際のタスクID形式（task-xxxx-N）の場合は未完了タスクへの依存
          //      短縮形（task-N）の場合は新規タスク間の依存
          if (depId.match(/^task-[a-f0-9]{8}-\d+$/)) {
            // 未完了タスクへの依存（フルID形式）
            return taskId(depId);
          }

          // 短縮形（task-N）の場合は新規タスク間の依存
          // 追加タスクのセッションIDで変換
          return taskId(makeUniqueTaskId(depId, additionalSessionShort));
        }),
        summary: breakdown.summary ?? null,
        sessionId: additionalRunId,
        parentSessionId,
        rootSessionId,
        plannerLogPath: additionalPlannerLogPath,
        plannerMetadataPath: additionalPlannerMetadataPath,
      });

      const result = await deps.taskStore.createTask(task);
      if (!result.ok) {
        const errorMsg = `Failed to create task ${uniqueTaskId} (from ${rawTaskId}): ${result.err.message}`;
        errors.push(errorMsg);
        await appendPlanningLog(`❌ ${errorMsg}\n`);
        continue;
      }

      taskIds.push(uniqueTaskId);
    }

    // WHY: Phase 2 - 再実行タスクのIDも含める
    //      呼び出し側（orchestrate.ts）で再実行タスクと新規タスクを統合して実行できるようにする
    const retryTaskIds = preparedRetryTasks.map(t => String(t.id));
    const allGeneratedTaskIds = [...retryTaskIds, ...taskIds];

    if (taskIds.length > 0) {
      await appendPlanningLog(`\n=== Generated Additional Tasks ===\n`);
      for (const rawTaskId of taskIds) {
        await appendPlanningLog(`- ${rawTaskId}\n`);
      }
    }

    if (preparedRetryTasks.length > 0) {
      await appendPlanningLog(`\n=== Prepared Retry Tasks ===\n`);
      for (const task of preparedRetryTasks) {
        await appendPlanningLog(`- ${task.id}\n`);
      }
    }

    if (errors.length > 0) {
      await appendPlanningLog(`\n⚠️  Some tasks failed to create:\n`);
      for (const error of errors) {
        await appendPlanningLog(`  - ${error}\n`);
      }
    }

    const completedRun =
      allGeneratedTaskIds.length > 0
        ? {
            ...planningRun,
            status: RunStatus.SUCCESS,
            finishedAt: new Date().toISOString(),
            errorMessage: errors.length > 0 ? `Partial success: ${errors.join(', ')}` : null,
          }
        : {
            ...planningRun,
            status: RunStatus.FAILURE,
            finishedAt: new Date().toISOString(),
            errorMessage: errors.length > 0 ? errors.join(', ') : 'No tasks created',
          };
    await deps.runnerEffects.saveRunMetadata(completedRun);

    // 会話履歴を更新してセッションを保存
    if (allGeneratedTaskIds.length > 0) {
      const timestamp = new Date().toISOString();
      session.conversationHistory.push({
        role: 'user',
        content: `Missing aspects: ${missingAspects.join(', ')}`,
        timestamp,
      });
      session.conversationHistory.push({
        role: 'assistant',
        content: JSON.stringify(taskBreakdowns, null, 2),
        timestamp,
      });
      session.generatedTasks.push(...taskBreakdowns);

      const saveSessionResult = await deps.sessionEffects.saveSession(session);
      if (isErr(saveSessionResult)) {
        console.warn(`⚠️  Failed to update planner session: ${saveSessionResult.err.message}`);
      } else {
        await appendPlanningLog(`\n✅ Session updated: ${sessionId}\n`);
      }
    }

    // 一部でもタスク作成に成功していれば成功とみなす
    if (allGeneratedTaskIds.length === 0) {
      return createErr(
        ioError('planAdditionalTasks', `Failed to create any tasks: ${errors.join(', ')}`),
      );
    }

    return createOk({
      taskIds: allGeneratedTaskIds,
      runId: additionalRunId,
    });
  };

  return {
    planTasks,
    judgeFinalCompletion,
    judgeFinalCompletionWithContext,
    planAdditionalTasks,
  };
};

/**
 * Planner操作型
 */
export type PlannerOperations = ReturnType<typeof createPlannerOperations>;

/**
 * Plannerプロンプトを構築
 *
 * ユーザー指示からタスク分解を行うためのプロンプトを生成する。
 *
 * WHY: 新フィールド（type, estimatedDuration, context）を要求することで
 *      エージェントにより構造化された出力を強制し、タスク品質を向上
 *
 * @param userInstruction ユーザーの指示
 * @returns Plannerプロンプト
 */
export const buildPlanningPrompt = (
  userInstruction: string,
  maxTaskDuration: number = 4,
  maxTasks: number = 5,
): string => {
  return `You are a task planner for a multi-agent development system.

USER INSTRUCTION:
${userInstruction}

Your task is to break down this instruction into concrete, implementable tasks.

IMPORTANT: You must assign a unique ID to each task. Use the format "task-1", "task-2", etc.
When one task depends on another, reference it by ID in the dependencies array.

For each task, provide:
1. id: Unique task identifier (e.g., "task-1", "task-2")
2. description: Clear description of what needs to be done
3. branch: Git branch name (e.g., "feature/add-login")
4. scopePaths: Array of file/directory paths that will be modified (e.g., ["src/auth/", "tests/auth/"])
5. acceptance: COMPLETE, VERIFIABLE acceptance criteria (REQUIRED)
   - Must be specific enough to verify task completion without ambiguity
   - Include WHAT to verify (e.g., "User can login with email/password")
   - Include HOW to verify (e.g., "Test with valid/invalid credentials, check JWT token generation")
   - Specify edge cases and error scenarios to test
   - Define performance/security requirements if applicable
   - Example: "Users can login with email/password. Valid credentials generate JWT token with 24h expiry. Invalid credentials return 401 with error message. Rate limiting allows 5 attempts per minute."
6. type: Task type (REQUIRED) - one of:
   - "implementation": New features or existing feature modifications
   - "documentation": Documentation creation or updates
   - "investigation": Research or investigation tasks
   - "integration": System integration or connectivity work
7. estimatedDuration: Estimated hours (REQUIRED) - number between 0.5 and ${maxTaskDuration}
   - CRITICAL: Tasks MUST NOT exceed ${maxTaskDuration} hours
   - Preferred range: 1-${Math.min(maxTaskDuration, 3)} hours per task (smaller, focused tasks)
   - If a task would exceed ${maxTaskDuration} hours, you MUST break it down into smaller subtasks
8. context: COMPLETE implementation context (REQUIRED)
   This field must contain ALL information needed to execute the task WITHOUT referring to external sources.

   CRITICAL REQUIREMENTS:
   - NO external references (e.g., "see docs/plans/xxx.md", "refer to design document")
   - Include EXACT file paths WITH line numbers (e.g., "src/types/errors.ts lines 20-89")
   - List ALL required package installations (e.g., "Install: pnpm add option-t @octokit/rest")
   - Provide CODE EXAMPLES for complex patterns (inline TypeScript/JavaScript snippets)
   - Specify EXACT import statements and module paths
   - IMPORTANT: DO NOT use markdown code blocks (backticks) inside the context field. Use plain text with line breaks (\\n) instead.
   - Format code examples as plain text with clear labels (e.g., "Code example: const token = jwt.sign(...)")

   Include the following:
   - Technical approach: Specific libraries, patterns, or techniques to use
   - Package dependencies: Exact package names and installation commands
   - Constraints: Technical limitations, compatibility requirements, performance targets
   - Existing patterns: Reference similar implementations with EXACT file paths and line numbers
   - Code examples: Inline code snippets for complex logic or patterns (NO backticks, use plain text)
   - Data models: Complete type definitions, schema definitions with examples
   - Error handling: How to handle failures and edge cases with code examples
   - Security: Authentication, authorization, validation requirements
   - Testing: What types of tests are needed and what they should cover

   Example: "Implement JWT authentication using jsonwebtoken library. Install: pnpm add jsonwebtoken bcrypt. Use bcrypt with cost factor 10 for password hashing. Store user credentials in existing users table (src/db/schema.sql lines 15-22). Follow existing auth pattern in src/auth/oauth.ts lines 45-89 for middleware structure. JWT payload structure: { userId: string, email: string, exp: number }. Store token in HTTP-only cookie named 'auth_token'. Implement rate limiting using existing RateLimiter class in src/middleware/rate-limit.ts lines 10-35 (5 attempts per minute per IP). Handle errors: validation errors (400), authentication failures (401), server errors (500). Code example for token generation: const token = jwt.sign({ userId, email }, SECRET, { expiresIn: '24h' }). Add unit tests in tests/auth/jwt.test.ts for token generation, validation, expiry. Add integration tests in tests/auth/login.test.ts for full login flow with database. Security: validate email format with regex /^[^@]+@[^@]+\\.[^@]+$/, sanitize inputs, use constant-time comparison for passwords. Must pass existing security linter rules in .eslintrc.json."
9. dependencies: Array of task IDs this task depends on (REQUIRED)
   - Empty array [] if the task has no dependencies
   - List task IDs that must be completed BEFORE this task can start
   - Example: If task-3 depends on task-1 and task-2, use ["task-1", "task-2"]
   - Tasks with no dependencies can be executed in parallel
   - Ensure no circular dependencies (task-1 depends on task-2, task-2 depends on task-1)
10. summary: Short summary of the task (OPTIONAL but RECOMMENDED)
   - Approximately 30 characters (max 50)
   - Used for log output and quick task identification
   - Should be concise and descriptive
   - Examples: "JWT認証の実装", "Add user login API", "Fix authentication bug"

Output format (JSON array):
[
  {
    "id": "task-1",
    "description": "Task description",
    "branch": "feature/branch-name",
    "scopePaths": ["path1/", "path2/"],
    "acceptance": "Acceptance criteria",
    "type": "implementation",
    "estimatedDuration": 2.5,
    "context": "Context information for task execution",
    "dependencies": [],
    "summary": "Short task summary"
  }
]

Rules:
- Create 1-${maxTasks} tasks (prefer smaller, focused tasks)
- Each task must have a unique ID (task-1, task-2, etc.)
- Each task should be independently implementable (or list its dependencies)
- Branch names must be valid Git branch names (lowercase, hyphens for spaces)
- Scope paths should be specific but allow flexibility
- Acceptance criteria should be testable
- Dependencies must reference valid task IDs from the same breakdown
- Avoid circular dependencies
- ALL fields are REQUIRED - tasks missing any field will be rejected
- CRITICAL Granularity guideline: Tasks MUST be ${maxTaskDuration} hours or less; aim for 1-${Math.min(maxTaskDuration, 3)} hours
- Break down any work that would exceed ${maxTaskDuration} hours into multiple smaller tasks

Example:
[
  {
    "id": "task-1",
    "description": "Implement user authentication with JWT",
    "branch": "feature/auth-jwt",
    "scopePaths": ["src/auth/", "tests/auth/"],
    "acceptance": "Users can login with email/password and receive JWT token with 24h expiry. VERIFY: (1) Valid credentials (test@example.com / password123) generate token and return 200. (2) Invalid credentials return 401 with error message 'Invalid credentials'. (3) Missing email/password returns 400 with validation errors. (4) Token validation succeeds for valid tokens, fails for expired/invalid tokens. (5) Rate limiting blocks after 5 failed attempts per minute per IP. (6) All tests pass including unit tests for token generation/validation and integration tests for full login flow.",
    "type": "implementation",
    "estimatedDuration": 3.0,
    "context": "Implement using jsonwebtoken v9.0+ library for JWT generation/validation. Use bcrypt with cost factor 10 for password hashing. Store user credentials in existing 'users' table defined in src/db/schema.sql (columns: id, email, password_hash, created_at). Follow the authentication pattern from src/auth/oauth.ts for middleware structure. JWT payload: {userId, email, exp}. Store token in HTTP-only cookie named 'auth_token'. Implement rate limiting using existing RateLimiter class in src/middleware/rate-limit.ts (5 attempts per minute per IP). Handle errors: validation errors (400), authentication failures (401), server errors (500). Add unit tests in tests/auth/jwt.test.ts for token generation, validation, expiry. Add integration tests in tests/auth/login.test.ts for full login flow with database. Security: validate email format with regex, sanitize inputs, use constant-time comparison for passwords. Must pass existing security linter rules in .eslintrc.json.",
    "dependencies": [],
    "summary": "JWT authentication implementation"
  },
  {
    "id": "task-2",
    "description": "Document authentication flow and API endpoints",
    "branch": "docs/auth-api",
    "scopePaths": ["docs/api/"],
    "acceptance": "API documentation includes all authentication endpoints with complete request/response examples. VERIFY: (1) POST /auth/login documented with example request body {email, password}, success response {token, user}, error responses 400/401/429/500. (2) POST /auth/logout documented with cookie clearing behavior. (3) GET /auth/verify documented with token validation. (4) Authentication flow diagram shows login -> token generation -> cookie storage -> subsequent requests. (5) Rate limiting rules documented (5 attempts/minute). (6) Security considerations section includes password requirements, token expiry, HTTPS requirement. (7) All examples are copy-pasteable and work with actual API.",
    "type": "documentation",
    "estimatedDuration": 1.5,
    "context": "Follow existing API documentation format in docs/api/README.md (uses Markdown with code blocks). Reference the authentication implementation in src/auth/ for accurate technical details. Include complete curl examples for each endpoint. Document all HTTP status codes: 200 (success), 400 (validation error), 401 (authentication failed), 429 (rate limited), 500 (server error). Add Mermaid sequence diagram for authentication flow (see docs/diagrams/ for examples). Cross-reference related docs: docs/security/authentication.md for security details, docs/setup/environment.md for HTTPS setup. Include troubleshooting section for common issues: cookie not set (check HTTPS), rate limited (wait 1 minute), token expired (re-login). Validation: run through examples manually and verify they work with local dev server.",
    "dependencies": ["task-1"],
    "summary": "Document auth API endpoints"
  }
]

Output only the JSON array, no additional text.

CRITICAL JSON FORMATTING RULES:
- The context field is a JSON string and must NOT contain unescaped quotes, newlines, or backticks
- DO NOT use markdown code blocks (\`\`\`) inside the context field
- Use \\\\n for line breaks within the context string
- Escape all special characters properly (quotes as \\\\", backslashes as \\\\\\\\)
- Keep code examples as plain text within the string (e.g., "Code: const x = 1;")
- If you need to show multiple lines of code, separate them with \\\\n (e.g., "Line 1\\\\nLine 2\\\\nLine 3")`;
};

/**
 * タスク品質評価プロンプトを構築
 *
 * 生成されたタスクの品質を評価するためのプロンプトを作成する。
 *
 * @param userInstruction 元のユーザー指示
 * @param tasks 生成されたタスクの配列
 * @param strictContextValidation 厳格なコンテキスト検証を有効化するか
 * @param previousFeedback 前回の評価フィードバック（再試行時）
 * @returns 品質評価プロンプト
 */
export const buildTaskQualityPrompt = (
  userInstruction: string,
  tasks: TaskBreakdown[],
  strictContextValidation: boolean,
  maxTaskDuration: number = 4,
  previousFeedback?: string,
): string => {
  const tasksJson = JSON.stringify(tasks, null, 2);

  const contextCriteria = strictContextValidation
    ? `   CRITICAL CHECKS (STRICT MODE):
   - NO external references (e.g., "see docs/...", "refer to design doc") - REJECT if found
   - File paths MUST include line numbers (e.g., "src/file.ts lines 10-20") - REJECT if missing
   - Package dependencies MUST include installation commands (e.g., "Install: pnpm add package") - REJECT if missing
   - Complex patterns MUST include code examples - REJECT if missing for non-trivial logic
   - Import statements and module paths must be specified exactly
   NICE TO HAVE:
   - Technical approach, dependencies, constraints specified
   - Data models, error handling, security, testing requirements included`
    : `   CRITICAL CHECKS (RELAXED MODE):
   - Context provides sufficient information to understand what needs to be done
   - Technical approach is described at a high level
   - Major dependencies are mentioned
   NICE TO HAVE (not required, but improves quality):
   - Specific file paths with line numbers
   - Installation commands for packages
   - Code examples for complex patterns
   - Detailed error handling, security, testing requirements`;

  return `You are a quality evaluator for task planning in a multi-agent development system.

USER INSTRUCTION:
${userInstruction}

GENERATED TASKS:
${tasksJson}

${
  previousFeedback
    ? `PREVIOUS FEEDBACK:
${previousFeedback}

`
    : ''
}Your task is to evaluate whether these tasks meet quality standards for execution.

Evaluation criteria (prioritized):

CRITICAL (must pass - weight: 70%):
1. **Completeness**: Does each task have all required fields (description, branch, scopePaths, acceptance, type, estimatedDuration, context)?
2. **Clarity**: Are descriptions clear and actionable?
3. **Acceptance criteria**: Are acceptance criteria specific, testable, and verifiable?
4. **Dependency validity**: Are all task dependencies valid (no circular dependencies, no references to non-existent tasks)?
5. **Coverage**: Do all tasks together fully satisfy the original instruction?
   - All explicit requirements must be addressed by at least one task
   - Implicit requirements (e.g., if adding interface, must also use it) must be considered
   - No aspect of the instruction should be left unaddressed
   - Example: If instruction says "implement authentication and update orchestrate.ts to use it", there must be tasks for BOTH implementing auth AND updating orchestrate.ts

IMPORTANT (should pass - weight: 20%):
6. **Context sufficiency**: Does the context field contain information needed to execute the task?
${contextCriteria}
7. **Granularity**: Are tasks appropriately sized? CRITICAL: All tasks MUST be ${maxTaskDuration} hours or less (preferred: 1-${Math.min(maxTaskDuration, 3)} hours)

NICE TO HAVE (improves quality - weight: 10%):
8. **Independence**: Can each task be implemented independently (or have proper dependencies listed)?
9. **Best practices**: Does the task follow coding best practices and patterns?

Scoring guide:
- 90-100: Excellent quality, all criteria met including nice-to-haves
- 70-89: Good quality, all critical and most important criteria met
- 60-69: Acceptable quality, critical criteria met, some important criteria may be missing
- 40-59: Below standard, missing some critical criteria
- 0-39: Poor quality, multiple critical issues

Output format (JSON):
{
  "isAcceptable": true/false,
  "issues": ["List of quality problems found"],
  "suggestions": ["List of improvement suggestions"],
  "overallScore": 0-100
}

If isAcceptable is false, provide specific, actionable feedback in issues and suggestions.
Output only the JSON object, no additional text.`;
};

/**
 * フィードバック付きプランニングプロンプトを構築
 *
 * 品質評価のフィードバックを含むプロンプトで再生成を促す。
 *
 * @param userInstruction 元のユーザー指示
 * @param feedback 品質評価フィードバック
 * @returns フィードバック付きプロンプト
 */
export const buildPlanningPromptWithFeedback = (
  userInstruction: string,
  feedback: string,
  maxTaskDuration: number = 4,
  maxTasks: number = 5,
): string => {
  const basePrompt = buildPlanningPrompt(userInstruction, maxTaskDuration, maxTasks);

  return `${basePrompt}

IMPORTANT - QUALITY FEEDBACK FROM PREVIOUS ATTEMPT:
${feedback}

Please address all issues and suggestions above in your task breakdown.`;
};

/**
 * 品質評価結果をパース
 *
 * エージェントが返すJSON形式の品質評価結果をパースする。
 * マークダウンコードブロックに囲まれている場合も対応。
 * パース失敗時はデフォルトで品質許容（isAcceptable: true）を返す。
 *
 * WHY: 品質評価エージェントの失敗により全体が止まらないよう、
 *      デフォルトで許容することで可用性を優先
 *
 * @param output エージェントの出力
 * @returns 品質評価結果
 */
export const parseQualityJudgement = (output: string): TaskQualityJudgement => {
  // デフォルト値（品質評価失敗時は許容する）
  const defaultJudgement: TaskQualityJudgement = {
    isAcceptable: true,
    issues: [],
    suggestions: [],
  };

  try {
    // JSONブロックを抽出（マークダウンコードブロックに囲まれている可能性）
    const codeBlockMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    const objectMatch = output.match(/(\{[\s\S]*\})/);

    const jsonMatch = codeBlockMatch || objectMatch;

    if (!jsonMatch || !jsonMatch[1]) {
      console.warn('⚠️  Quality judgement: No JSON found, accepting by default');
      return defaultJudgement;
    }

    const jsonStr = jsonMatch[1];
    let parsed: unknown;

    try {
      parsed = JSON.parse(jsonStr.trim());
    } catch (parseError) {
      console.warn(
        `⚠️  Quality judgement: JSON parse failed, accepting by default: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      );
      return defaultJudgement;
    }

    // Zodスキーマでバリデーション
    const validationResult = TaskQualityJudgementSchema.safeParse(parsed);

    if (!validationResult.success) {
      const zodErrors = validationResult.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join(', ');
      console.warn(`⚠️  Quality judgement: Validation failed, accepting by default: ${zodErrors}`);
      return defaultJudgement;
    }

    return validationResult.data;
  } catch (error) {
    console.warn(
      `⚠️  Quality judgement: Unexpected error, accepting by default: ${error instanceof Error ? error.message : String(error)}`,
    );
    return defaultJudgement;
  }
};

/**
 * フィードバックを再試行用に整形
 *
 * 品質評価結果を読みやすいフィードバック文字列に変換する。
 * 前回の完全な出力を含めることで、エージェントが状態を引き継いで修正できる。
 *
 * @param judgement 品質評価結果
 * @param previousOutput 前回の出力（JSON文字列）
 * @param previousFullResponse 前回のエージェント完全レスポンス（テキスト説明含む）
 * @returns 整形されたフィードバック
 */
export const formatFeedbackForRetry = (
  judgement: TaskQualityJudgement,
  previousOutput?: string,
  previousFullResponse?: string,
): string => {
  const lines: string[] = [];

  if (judgement.overallScore !== undefined) {
    lines.push(`Overall Quality Score: ${judgement.overallScore}/100`);
  }

  if (judgement.issues.length > 0) {
    lines.push('\nIssues:');
    judgement.issues.forEach((issue, idx) => {
      lines.push(`${idx + 1}. ${issue}`);
    });
  }

  if (judgement.suggestions.length > 0) {
    lines.push('\nSuggestions:');
    judgement.suggestions.forEach((suggestion, idx) => {
      lines.push(`${idx + 1}. ${suggestion}`);
    });
  }

  // 前回の完全なレスポンスを含める（エージェントが前回の説明や意図を参照できる）
  if (previousFullResponse) {
    lines.push('\nPrevious Response (for reference and modification):');
    lines.push('```');
    lines.push(previousFullResponse);
    lines.push('```');
  } else if (previousOutput) {
    // フォールバック: JSONのみ
    lines.push('\nPrevious Output (for reference and modification):');
    lines.push('```json');
    lines.push(previousOutput);
    lines.push('```');
  }

  return lines.join('\n');
};

/**
 * フィードバックのログ表示用に省略版を作成
 *
 * WHY: ログファイルの重複を避けるため、前回のレスポンスを省略表示
 *
 * @param feedback 完全なフィードバック
 * @returns ログ表示用の省略版フィードバック
 */
export const formatFeedbackForLog = (feedback: string): string => {
  // "Previous Response" セクションを省略表示に置き換え
  // WHY: 正規表現を改善して確実にマッチするように修正
  //      - (?:json)? の後の \n をオプショナルにして、改行がない場合にも対応
  //      - 最後の ``` の前の \n もオプショナルにして、より柔軟にマッチ
  return feedback.replace(
    /Previous (?:Response|Output) \(for reference and modification\):\n```(?:json)?\n?[\s\S]*?\n?```/,
    '<< Previous Response Omitted (included in prompt for agent context) >>',
  );
};

/**
 * パース結果（成功したタスクとエラーの両方を保持）
 *
 * WHY: 部分的な成功を許容し、エラー詳細を返すことでデバッグを容易に
 */
export interface ParseResult {
  /** バリデーション成功したタスク分解情報 */
  tasks: TaskBreakdown[];
  /** バリデーションエラーメッセージの配列 */
  errors: string[];
}

/**
 * タスク依存関係の循環を検出
 *
 * DFS（深さ優先探索）を使用して循環依存を検出する。
 *
 * @param tasks タスク配列
 * @returns 循環依存のパス配列（例: ["task-1 -> task-2 -> task-1"]）
 */
export const detectCircularDependencies = (tasks: TaskBreakdown[]): string[] => {
  const taskMap = new Map<string, TaskBreakdown>();
  tasks.forEach((task) => taskMap.set(task.id, task));

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles: string[] = [];

  const dfs = (taskId: string, path: string[]): void => {
    if (visiting.has(taskId)) {
      // 循環検出
      const cycleStart = path.indexOf(taskId);
      const cyclePath = [...path.slice(cycleStart), taskId].join(' -> ');
      cycles.push(cyclePath);
      return;
    }

    if (visited.has(taskId)) {
      return;
    }

    visiting.add(taskId);
    path.push(taskId);

    const task = taskMap.get(taskId);
    if (task && task.dependencies) {
      for (const depId of task.dependencies) {
        if (!taskMap.has(depId)) {
          // 存在しない依存先（別途エラーとして報告される）
          continue;
        }
        dfs(depId, path);
      }
    }

    visiting.delete(taskId);
    visited.add(taskId);
    path.pop();
  };

  for (const task of tasks) {
    if (!visited.has(task.id)) {
      dfs(task.id, []);
    }
  }

  return cycles;
};

/**
 * タスクの依存関係を検証
 *
 * - 循環依存の検出
 * - 存在しない依存先の検出
 *
 * @param tasks タスク配列
 * @returns 検証エラーメッセージの配列
 */
export const validateTaskDependencies = (tasks: TaskBreakdown[]): string[] => {
  const errors: string[] = [];
  const taskIds = new Set(tasks.map((t) => t.id));

  // 循環依存のチェック
  const cycles = detectCircularDependencies(tasks);
  if (cycles.length > 0) {
    errors.push(`Circular dependencies detected: ${cycles.join('; ')}`);
  }

  // 存在しない依存先のチェック
  for (const task of tasks) {
    if (task.dependencies) {
      for (const depId of task.dependencies) {
        if (!taskIds.has(depId)) {
          errors.push(`Task "${task.id}" depends on non-existent task "${depId}"`);
        }
      }
    }
  }

  return errors;
};

/**
 * エージェント出力をパース（Zodスキーマによる厳格なバリデーション）
 *
 * エージェントが返すJSON形式のタスク分解結果をパースする。
 * マークダウンコードブロックに囲まれている場合も対応。
 *
 * WHY: Zodスキーマによる厳格なバリデーションで、新フィールド（type, estimatedDuration, context）
 *      が欠けている場合は明確なエラーを返し、品質を保証
 *
 * @param output エージェントの出力
 * @returns タスク分解情報の配列
 */
export const parseAgentOutput = (output: string): TaskBreakdown[] => {
  const result = parseAgentOutputWithErrors(output);

  // エラーをログ出力
  if (result.errors.length > 0) {
    console.error('=== Task Breakdown Validation Errors ===');
    result.errors.forEach((err, idx) => {
      console.error(`Error ${idx + 1}: ${err}`);
    });
  }

  return result.tasks;
};

/**
 * エージェント出力をパース（エラー詳細を含む）
 *
 * WHY: テストやデバッグ時にエラー詳細が必要なため、別関数として提供
 *
 * @param output エージェントの出力
 * @returns パース結果（タスクとエラー）
 */
export const parseAgentOutputWithErrors = (output: string): ParseResult => {
  const errors: string[] = [];
  const tasks: TaskBreakdown[] = [];

  try {
    // JSONブロックを抽出（マークダウンコードブロックに囲まれている可能性）
    // 優先順位: コードブロック > オブジェクト全体 > 配列全体
    const codeBlockMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    const objectMatch = output.match(/^(\{[\s\S]*\})$/);
    const arrayMatch = output.match(/^(\[[\s\S]*\])$/);

    const jsonMatch = codeBlockMatch || objectMatch || arrayMatch;

    if (!jsonMatch || !jsonMatch[1]) {
      errors.push('No JSON content found in output');
      return { tasks, errors };
    }

    const jsonStr = jsonMatch[1];
    let parsed: unknown;

    try {
      parsed = JSON.parse(jsonStr.trim());
    } catch (parseError) {
      errors.push(
        `JSON parse failed: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      );
      return { tasks, errors };
    }

    // 配列でない場合は配列にラップ
    const items = Array.isArray(parsed) ? parsed : [parsed];

    // 各アイテムをZodスキーマでバリデーション
    items.forEach((item, index) => {
      const validationResult = TaskBreakdownSchema.safeParse(item);

      if (validationResult.success) {
        tasks.push(validationResult.data);
      } else {
        const zodErrors = validationResult.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join(', ');
        errors.push(`Task ${index + 1} validation failed: ${zodErrors}`);
      }
    });

    // 依存関係の検証（タスクが1つ以上ある場合のみ）
    if (tasks.length > 0) {
      const depErrors = validateTaskDependencies(tasks);
      errors.push(...depErrors);
    }

    return { tasks, errors };
  } catch (error) {
    errors.push(
      `Unexpected error during parsing: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { tasks, errors };
  }
};

/**
 * 実行結果とコード差分を含めた最終完了判定プロンプトを構築
 *
 * WHY: タスク説明だけでなく実行結果とコード変更を含めることで、
 *      より正確な完了判定を行う
 *
 * @param userInstruction 元のユーザー指示
 * @param completedTaskDescriptions 完了したタスクの説明リスト
 * @param failedTaskDescriptions 失敗したタスクの説明リスト
 * @param completedTaskRunSummaries 完了したタスクの実行サマリーリスト
 * @param codeChanges コード差分（git diff --stat）
 * @returns 最終完了判定プロンプト
 */
export const buildFinalCompletionPromptWithContext = (
  userInstruction: string,
  completedTasks: Task[],
  completedTaskDescriptions: string[],
  failedTaskDescriptions: string[],
  completedTaskRunSummaries: string[],
  codeChanges: string,
): string => {
  // WHY: 完了タスクの詳細情報をプロンプトに含めることで、
  //      既に完了している機能を不足として誤検出するのを防ぐ
  const completedTaskDetails =
    completedTasks.length > 0
      ? completedTasks
          .map((t, idx) => `${idx + 1}. [${t.id}] ${t.summary || 'N/A'}\n   Acceptance: ${t.acceptance}`)
          .join('\n')
      : '(No tasks completed)';

  return `You are evaluating whether the original user instruction has been fully satisfied.

ORIGINAL INSTRUCTION:
${userInstruction}

COMPLETED TASKS (detailed):
${completedTaskDetails}

TASK DESCRIPTIONS:
${completedTaskDescriptions.length > 0 ? completedTaskDescriptions.map((desc, idx) => `${idx + 1}. ${desc}`).join('\n') : '(No task descriptions available)'}

TASK EXECUTION SUMMARIES:
${completedTaskRunSummaries.length > 0 ? completedTaskRunSummaries.map((summary, idx) => `${idx + 1}. ${summary}`).join('\n') : '(No execution summaries available)'}

CODE CHANGES (git diff --stat):
${codeChanges || '(No code changes detected)'}

FAILED TASKS:
${failedTaskDescriptions.length > 0 ? failedTaskDescriptions.map((desc, idx) => `${idx + 1}. ${desc}`).join('\n') : '(No tasks failed)'}

IMPORTANT:
- Review COMPLETED TASKS carefully before identifying missing aspects
- If a feature is already satisfied (listed in COMPLETED TASKS), do NOT suggest recreating it
- Only identify truly missing aspects that are NOT covered by completed tasks

Evaluate based on:
1. Do the completed tasks cover all aspects of the original instruction?
2. Do the actual code changes match what was expected based on task descriptions?
3. Are there any implicit requirements left unaddressed?
4. Is there any mismatch between task descriptions and actual code changes?

Output format (JSON):
{
  "isComplete": true/false,
  "missingAspects": ["List of aspects NOT addressed"],
  "additionalTaskSuggestions": ["Suggested tasks to complete the instruction"],
  "completionScore": 0-100,
  "codeChangeAnalysis": {
    "expectedChanges": ["Expected changes based on tasks"],
    "actualChanges": ["Observed changes from diff"],
    "mismatches": ["Any discrepancies found"]
  }
}

If isComplete is true, missingAspects and additionalTaskSuggestions should be empty arrays.
If isComplete is false, provide specific, actionable items in missingAspects and additionalTaskSuggestions.

Output only the JSON object, no additional text.`;
};

/**
 * 最終完了判定プロンプトを構築
 *
 * WHY: 全タスク完了後に元のユーザー指示が本当に達成されたかを評価
 *
 * @param userInstruction 元のユーザー指示
 * @param completedTaskDescriptions 完了したタスクの説明リスト
 * @param failedTaskDescriptions 失敗したタスクの説明リスト
 * @returns 最終完了判定プロンプト
 */
export const buildFinalCompletionPrompt = (
  userInstruction: string,
  completedTaskDescriptions: string[],
  failedTaskDescriptions: string[],
): string => {
  return `You are evaluating if the original user instruction was fully completed.

ORIGINAL INSTRUCTION:
${userInstruction}

COMPLETED TASKS:
${completedTaskDescriptions.length > 0 ? completedTaskDescriptions.map((desc, idx) => `${idx + 1}. ${desc}`).join('\n') : '(No tasks completed)'}

FAILED TASKS:
${failedTaskDescriptions.length > 0 ? failedTaskDescriptions.map((desc, idx) => `${idx + 1}. ${desc}`).join('\n') : '(No tasks failed)'}

Your task:
1. Determine if the original instruction is fully satisfied based on the completed tasks
2. Identify any missing aspects or functionality that were requested but not delivered
3. Suggest additional tasks if needed to fully satisfy the original instruction
4. Rate the overall completion (0-100%)

Evaluation criteria:
- Does the completed work cover all aspects mentioned in the original instruction?
- Are there any implicit requirements that weren't addressed?
- Do failed tasks affect the completeness of the original instruction?
- Is the delivered functionality complete and usable?

Output format (JSON):
{
  "isComplete": true/false,
  "missingAspects": ["List of aspects not yet addressed"],
  "additionalTaskSuggestions": ["List of tasks needed to complete the instruction"],
  "completionScore": 0-100
}

If isComplete is true, missingAspects and additionalTaskSuggestions should be empty arrays.
If isComplete is false, provide specific, actionable items in missingAspects and additionalTaskSuggestions.

Output only the JSON object, no additional text.`;
};

/**
 * 最終完了判定結果をパース
 *
 * エージェントが返すJSON形式の最終完了判定結果をパースする。
 * マークダウンコードブロックに囲まれている場合も対応。
 * パース失敗時はデフォルトで完了（isComplete: true）を返す。
 *
 * WHY: 最終判定エージェントの失敗により追加タスクが無限に生成されないよう、
 *      デフォルトで完了とすることで安全性を優先
 *
 * @param output エージェントの出力
 * @returns 最終完了判定結果
 */
export const parseFinalCompletionJudgement = (output: string): FinalCompletionJudgement => {
  // デフォルト値（判定失敗時は完了とみなす）
  const defaultJudgement: FinalCompletionJudgement = {
    isComplete: true,
    missingAspects: [],
    additionalTaskSuggestions: [],
  };

  try {
    // JSONブロックを抽出（マークダウンコードブロックに囲まれている可能性）
    const codeBlockMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    const objectMatch = output.match(/(\{[\s\S]*\})/);

    const jsonMatch = codeBlockMatch || objectMatch;

    if (!jsonMatch || !jsonMatch[1]) {
      console.warn('⚠️  Final completion judgement: No JSON found, assuming complete');
      return defaultJudgement;
    }

    const jsonStr = jsonMatch[1];
    let parsed: unknown;

    try {
      parsed = JSON.parse(jsonStr.trim());
    } catch (parseError) {
      console.warn(
        `⚠️  Final completion judgement: JSON parse failed, assuming complete: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      );
      return defaultJudgement;
    }

    // Zodスキーマでバリデーション
    const validationResult = FinalCompletionJudgementSchema.safeParse(parsed);

    if (!validationResult.success) {
      const zodErrors = validationResult.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join(', ');
      console.warn(
        `⚠️  Final completion judgement: Validation failed, assuming complete: ${zodErrors}`,
      );
      return defaultJudgement;
    }

    return validationResult.data;
  } catch (error) {
    console.warn(
      `⚠️  Final completion judgement: Unexpected error, assuming complete: ${error instanceof Error ? error.message : String(error)}`,
    );
    return defaultJudgement;
  }
};

/**
 * 循環依存を検出
 *
 * WHY: タスクの依存関係グラフに循環がある場合、実行が不可能になるため検出が必要
 *
 * @param tasks タスクリスト
 * @returns 循環依存が存在する場合はtrue
 */
const hasCycle = (tasks: Task[]): boolean => {
  const taskMap = new Map<string, Task>();
  for (const task of tasks) {
    taskMap.set(task.id, task);
  }

  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  const dfs = (taskId: string): boolean => {
    if (recursionStack.has(taskId)) {
      // 再帰スタックに存在する = 循環依存を発見
      return true;
    }

    if (visited.has(taskId)) {
      // 既に訪問済み（別の経路から）
      return false;
    }

    visited.add(taskId);
    recursionStack.add(taskId);

    const task = taskMap.get(taskId);
    if (task && task.dependencies) {
      for (const depId of task.dependencies) {
        // 自己参照チェック
        if (depId === taskId) {
          return true;
        }

        if (dfs(depId)) {
          return true;
        }
      }
    }

    recursionStack.delete(taskId);
    return false;
  };

  // すべてのタスクについてDFSを実行
  for (const task of tasks) {
    if (!visited.has(task.id)) {
      if (dfs(task.id)) {
        return true;
      }
    }
  }

  return false;
};

/**
 * 構造検証を実行
 *
 * WHY: Plannerが生成したタスクリストの構造的な妥当性を検証し、
 *      実行不可能なタスク構成を早期に検出する
 *
 * 検証項目:
 * 1. タスク数の変化率が閾値を超えていないか
 * 2. 依存関係の不整合（存在しないタスクIDへの依存）
 * 3. 循環依存の有無
 *
 * @param originalTasks 元のタスクリスト
 * @param newTasks 新しいタスクリスト
 * @param config 閾値設定
 * @returns 構造検証の結果
 */
export const validateStructure = (
  originalTasks: Task[],
  newTasks: Task[],
  config: RefinementConfig,
): StructureValidation => {
  const details: string[] = [];

  // タスク数変化率の計算（0除算回避）
  const absoluteDiff = Math.abs(newTasks.length - originalTasks.length);
  const changeRate =
    originalTasks.length === 0
      ? 0
      : Math.abs(newTasks.length - originalTasks.length) / originalTasks.length;

  // タスク数変化判定
  const hasExcessiveChange =
    changeRate > config.taskCountChangeThreshold && absoluteDiff > config.taskCountChangeMinAbsolute;

  if (hasExcessiveChange) {
    details.push(
      `タスク数変化率が閾値超過: 変化率=${(changeRate * 100).toFixed(1)}% (閾値=${(config.taskCountChangeThreshold * 100).toFixed(1)}%), 絶対差=${absoluteDiff} (下限=${config.taskCountChangeMinAbsolute})`,
    );
  }

  // 依存関係不整合検出
  const taskIds = new Set(newTasks.map((t) => t.id));
  const dependencyIssues: string[] = [];

  for (const task of newTasks) {
    if (task.dependencies) {
      for (const depId of task.dependencies) {
        if (!taskIds.has(depId)) {
          dependencyIssues.push(`${task.id} -> ${depId}`);
        }
      }
    }
  }

  const hasDependencyIssues = dependencyIssues.length > 0;

  if (hasDependencyIssues) {
    details.push(`依存関係不整合: ${dependencyIssues.join(', ')}`);
  }

  // 循環依存検出
  const hasCyclicDependency = hasCycle(newTasks);

  if (hasCyclicDependency) {
    details.push('循環依存検出');
  }

  const isValid = !hasExcessiveChange && !hasDependencyIssues && !hasCyclicDependency;

  return {
    isValid,
    taskCountChange: changeRate,
    absoluteTaskCountDiff: absoluteDiff,
    hasDependencyIssues,
    hasCyclicDependency,
    details: details.length > 0 ? details.join('; ') : undefined,
  };
};
