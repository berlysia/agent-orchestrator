import type { TaskStore } from '../task-store/interface.ts';
import type { RunnerEffects } from '../runner/runner-effects.ts';
import type { PlannerSessionEffects } from './planner-session-effects.ts';
import { createInitialTask } from '../../types/task.ts';
import { taskId, repoPath, branchName, runId } from '../../types/branded.ts';
import { randomUUID } from 'node:crypto';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr, isErr } from 'option-t/plain_result';
import type { TaskStoreError } from '../../types/errors.ts';
import { ioError } from '../../types/errors.ts';
import { createInitialRun, RunStatus } from '../../types/run.ts';
import { z } from 'zod';
import { createPlannerSession } from '../../types/planner-session.ts';
import path from 'node:path';

/**
 * Planner依存関係
 */
export interface PlannerDeps {
  readonly taskStore: TaskStore;
  readonly runnerEffects: RunnerEffects;
  readonly sessionEffects?: PlannerSessionEffects;
  readonly appRepoPath: string;
  readonly coordRepoPath: string;
  readonly agentType: 'claude' | 'codex';
  readonly model?: string;
  readonly judgeModel?: string;
  readonly maxQualityRetries?: number;
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
}

/**
 * 最終完了判定結果のZodスキーマ
 */
export const FinalCompletionJudgementSchema = z.object({
  isComplete: z.boolean(),
  missingAspects: z.array(z.string()),
  additionalTaskSuggestions: z.array(z.string()),
  completionScore: z.number().min(0).max(100).optional(),
});

/**
 * TaskBreakdownスキーマバージョン
 *
 * WHY: 将来的なスキーマ変更時のマイグレーション対応のため
 */
export const TASK_BREAKDOWN_SCHEMA_VERSION = 2;

/**
 * タスクタイプ定数
 *
 * - implementation: 新機能や既存機能の実装
 * - documentation: ドキュメント作成・更新
 * - investigation: 調査・検証タスク
 * - integration: システム統合・連携作業
 */
export const TaskTypeEnum = {
  IMPLEMENTATION: 'implementation',
  DOCUMENTATION: 'documentation',
  INVESTIGATION: 'investigation',
  INTEGRATION: 'integration',
} as const;

export type TaskType = (typeof TaskTypeEnum)[keyof typeof TaskTypeEnum];

/**
 * タスク分解情報のZodスキーマ（エージェントが返すべき形式）
 *
 * WHY: 厳格なバリデーションによりエージェント出力の品質を保証
 */
export const TaskBreakdownSchema = z.object({
  /** タスクID（Planner段階で割り当てる） */
  id: z.string(),
  /** タスクの説明 */
  description: z.string().min(1, 'description must not be empty'),
  /** ブランチ名 */
  branch: z.string().min(1, 'branch must not be empty'),
  /** スコープパス */
  scopePaths: z.array(z.string()).min(1, 'scopePaths must contain at least one path'),
  /** 受け入れ基準 */
  acceptance: z.string().min(1, 'acceptance must not be empty'),
  /** タスクタイプ（必須） */
  type: z.enum([
    TaskTypeEnum.IMPLEMENTATION,
    TaskTypeEnum.DOCUMENTATION,
    TaskTypeEnum.INVESTIGATION,
    TaskTypeEnum.INTEGRATION,
  ]),
  /** 見積もり時間（時間単位、0.5-8時間の範囲） */
  estimatedDuration: z.number().min(0.5).max(8),
  /** タスク実行に必要なコンテキスト情報（必須） */
  context: z.string().min(1, 'context must not be empty'),
  /** 依存するタスクIDの配列（このタスクを実行する前に完了が必要なタスクのID） */
  dependencies: z.array(z.string()).default([]),
});

/**
 * タスク分解情報（TypeScript型）
 */
export type TaskBreakdown = z.infer<typeof TaskBreakdownSchema>;

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
    // judgeModelが設定されていない場合は常に許容
    if (!deps.judgeModel) {
      return {
        isAcceptable: true,
        issues: [],
        suggestions: [],
      };
    }

    const qualityPrompt = buildTaskQualityPrompt(userInstruction, tasks, previousFeedback);

    // Judge用エージェントを実行
    // WHY: Plannerとは別のモデル（軽量なHaikuなど）を使用してコスト削減
    const runResult =
      deps.agentType === 'claude'
        ? await deps.runnerEffects.runClaudeAgent(qualityPrompt, deps.appRepoPath, deps.judgeModel)
        : await deps.runnerEffects.runCodexAgent(qualityPrompt, deps.appRepoPath, deps.judgeModel);

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
    const plannerRunId = `planner-${randomUUID()}`;
    const maxRetries = deps.maxQualityRetries ?? 3;

    const appendPlanningLog = async (content: string): Promise<void> => {
      const logResult = await deps.runnerEffects.appendLog(plannerRunId, content);
      if (isErr(logResult)) {
        console.warn(`⚠️  Failed to write planner log: ${logResult.err.message}`);
      }
    };

    await appendPlanningLog(`=== Planning Start ===\n`);
    await appendPlanningLog(`Instruction: ${userInstruction}\n`);

    const plannerLogPath = path.join(deps.coordRepoPath, 'runs', `${plannerRunId}.log`);
    const plannerMetadataPath = path.join(deps.coordRepoPath, 'runs', `${plannerRunId}.json`);

    const planningRun = createInitialRun({
      id: runId(plannerRunId),
      taskId: taskId(plannerRunId),
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

    // 品質評価ループ
    let taskBreakdowns: TaskBreakdown[] = [];
    let accumulatedFeedback: string | undefined = undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await appendPlanningLog(`\n--- Attempt ${attempt}/${maxRetries} ---\n`);

      // 1. Plannerプロンプトを構築
      const planningPrompt = accumulatedFeedback
        ? buildPlanningPromptWithFeedback(userInstruction, accumulatedFeedback)
        : buildPlanningPrompt(userInstruction);

      await appendPlanningLog(`Prompt:\n${planningPrompt}\n\n`);

      // 2. エージェントを実行
      // WHY: 役割ごとに最適なモデルを使用（Config から取得）
      const runResult =
        deps.agentType === 'claude'
          ? await deps.runnerEffects.runClaudeAgent(planningPrompt, deps.appRepoPath, deps.model!)
          : await deps.runnerEffects.runCodexAgent(planningPrompt, deps.appRepoPath, deps.model);

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

      taskBreakdowns = parseResult.tasks;

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

      if (judgement.isAcceptable) {
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

      accumulatedFeedback = formatFeedbackForRetry(judgement);
    }

    // タスクをTaskStoreに保存
    const taskIds: string[] = [];
    const errors: string[] = [];

    // プランナーセッションIDの短縮版を使用してタスクIDを一意にする
    const sessionShort = plannerRunId.substring(8, 16); // "planner-" の後の8文字
    const makeUniqueTaskId = (rawId: string): string => {
      const baseId = rawId.replace(/^task-/, '');
      return `task-${sessionShort}-${baseId}`;
    };

    for (const breakdown of taskBreakdowns) {
      const rawTaskId = breakdown.id;
      const uniqueTaskId = makeUniqueTaskId(rawTaskId);
      const task = createInitialTask({
        id: taskId(uniqueTaskId),
        repo: repoPath(deps.appRepoPath),
        branch: branchName(breakdown.branch),
        scopePaths: breakdown.scopePaths,
        acceptance: breakdown.acceptance,
        taskType: breakdown.type,
        context: breakdown.context,
        dependencies: breakdown.dependencies.map((depId) => taskId(makeUniqueTaskId(depId))),
        plannerRunId: plannerRunId,
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
    }

    if (taskIds.length > 0) {
      await appendPlanningLog(`\n=== Generated Tasks ===\n`);
      for (const rawTaskId of taskIds) {
        await appendPlanningLog(`- ${rawTaskId}\n`);
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

    // セッション情報を保存（sessionEffectsが提供されている場合のみ）
    if (deps.sessionEffects && taskIds.length > 0) {
      const session = createPlannerSession(plannerRunId, userInstruction);
      session.generatedTasks = taskBreakdowns;
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
        await appendPlanningLog(`\n✅ Session saved: ${plannerRunId}\n`);
      }
    }

    // 一部でもタスク作成に成功していれば成功とみなす
    if (taskIds.length === 0) {
      return createErr(ioError('planTasks', `Failed to create any tasks: ${errors.join(', ')}`));
    }

    return createOk({
      taskIds,
      runId: plannerRunId,
    });
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
    // judgeModelが設定されていない場合は常に完了とみなす
    if (!deps.judgeModel) {
      return {
        isComplete: true,
        missingAspects: [],
        additionalTaskSuggestions: [],
      };
    }

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
    // sessionEffectsが提供されていない場合はエラー
    if (!deps.sessionEffects) {
      return createErr(
        ioError(
          'planAdditionalTasks',
          'Session management is not enabled (sessionEffects not provided)',
        ),
      );
    }

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

    // 会話履歴を含めたプロンプトを構築
    const conversationContext = session.conversationHistory
      .map((msg) => `${msg.role}: ${msg.content}`)
      .join('\n\n');

    const additionalPrompt = `Previous conversation:
${conversationContext}

Based on the above context, the following aspects are still missing:
${missingAspects.map((aspect, i) => `${i + 1}. ${aspect}`).join('\n')}

Generate additional tasks to address these missing aspects.
Follow the same format and guidelines as before.

Output format (JSON array):
[
  {
    "id": "task-X",
    "description": "Task description",
    "branch": "feature/branch-name",
    "scopePaths": ["path1/", "path2/"],
    "acceptance": "Acceptance criteria",
    "type": "implementation|documentation|investigation|integration",
    "estimatedDuration": 2.5,
    "context": "Complete context for task execution",
    "dependencies": []
  }
]

Output only the JSON array, no additional text.`;

    await appendPlanningLog(`\nPrompt:\n${additionalPrompt}\n\n`);

    // エージェントを実行
    const runResult =
      deps.agentType === 'claude'
        ? await deps.runnerEffects.runClaudeAgent(additionalPrompt, deps.appRepoPath, deps.model!)
        : await deps.runnerEffects.runCodexAgent(additionalPrompt, deps.appRepoPath, deps.model);

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
    await appendPlanningLog(`\n=== Planner Agent Output ===\n`);
    await appendPlanningLog(`${finalResponse}\n`);

    const parseResult = parseAgentOutputWithErrors(finalResponse);

    if (parseResult.errors.length > 0) {
      await appendPlanningLog(`\n=== Validation Errors ===\n`);
      parseResult.errors.forEach((err) => {
        appendPlanningLog(`${err}\n`);
      });
    }

    if (parseResult.tasks.length === 0) {
      const errorMsg =
        parseResult.errors.length > 0
          ? `No valid task breakdowns. Validation errors: ${parseResult.errors.join('; ')}`
          : 'No valid task breakdowns found in agent output';

      await appendPlanningLog(`\n❌ ${errorMsg}\n`);

      const failedRun = {
        ...planningRun,
        status: RunStatus.FAILURE,
        finishedAt: new Date().toISOString(),
        errorMessage: errorMsg,
      };
      await deps.runnerEffects.saveRunMetadata(failedRun);

      return createErr(ioError('planAdditionalTasks.parseOutput', errorMsg));
    }

    const taskBreakdowns = parseResult.tasks;

    // タスクをTaskStoreに保存
    const taskIds: string[] = [];
    const errors: string[] = [];

    // プランナーセッションIDの短縮版を使用してタスクIDを一意にする
    const sessionShort = additionalRunId.substring(18, 26); // "planner-additional-" の後の8文字
    const makeUniqueTaskId = (rawId: string): string => {
      const baseId = rawId.replace(/^task-/, '');
      return `task-${sessionShort}-${baseId}`;
    };

    for (const breakdown of taskBreakdowns) {
      const rawTaskId = breakdown.id;
      const uniqueTaskId = makeUniqueTaskId(rawTaskId);
      const task = createInitialTask({
        id: taskId(uniqueTaskId),
        repo: repoPath(deps.appRepoPath),
        branch: branchName(breakdown.branch),
        scopePaths: breakdown.scopePaths,
        acceptance: breakdown.acceptance,
        taskType: breakdown.type,
        context: breakdown.context,
        dependencies: breakdown.dependencies.map((depId) => taskId(makeUniqueTaskId(depId))),
        plannerRunId: additionalRunId,
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

    if (taskIds.length > 0) {
      await appendPlanningLog(`\n=== Generated Additional Tasks ===\n`);
      for (const rawTaskId of taskIds) {
        await appendPlanningLog(`- ${rawTaskId}\n`);
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

    // 会話履歴を更新してセッションを保存
    if (taskIds.length > 0) {
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
    if (taskIds.length === 0) {
      return createErr(
        ioError('planAdditionalTasks', `Failed to create any tasks: ${errors.join(', ')}`),
      );
    }

    return createOk({
      taskIds,
      runId: additionalRunId,
    });
  };

  return {
    planTasks,
    judgeFinalCompletion,
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
export const buildPlanningPrompt = (userInstruction: string): string => {
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
7. estimatedDuration: Estimated hours (REQUIRED) - number between 0.5 and 8
   - Aim for 1-4 hours per task (smaller, focused tasks preferred)
   - If a task exceeds 4 hours, consider breaking it down further
8. context: COMPLETE implementation context (REQUIRED)
   This field must contain ALL information needed to execute the task WITHOUT referring to external sources.
   Include the following:
   - Technical approach: Specific libraries, patterns, or techniques to use
   - Dependencies: What must exist or be completed first
   - Constraints: Technical limitations, compatibility requirements, performance targets
   - Existing patterns: Reference similar implementations in the codebase with file paths
   - Data models: Expected input/output formats, schema definitions
   - Error handling: How to handle failures and edge cases
   - Security: Authentication, authorization, validation requirements
   - Testing: What types of tests are needed and what they should cover
   Example: "Implement JWT authentication using jsonwebtoken library. Use bcrypt for password hashing (cost factor 10). Store user credentials in existing users table (src/db/schema.sql). Follow existing auth pattern in src/auth/oauth.ts. Tokens expire in 24h, store in HTTP-only cookies. Handle login failures with exponential backoff. Validate email format before lookup. Add unit tests for token generation/validation, integration tests for login flow. Must pass OWASP security review."
9. dependencies: Array of task IDs this task depends on (REQUIRED)
   - Empty array [] if the task has no dependencies
   - List task IDs that must be completed BEFORE this task can start
   - Example: If task-3 depends on task-1 and task-2, use ["task-1", "task-2"]
   - Tasks with no dependencies can be executed in parallel
   - Ensure no circular dependencies (task-1 depends on task-2, task-2 depends on task-1)

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
    "dependencies": []
  }
]

Rules:
- Create 1-5 tasks (prefer smaller, focused tasks)
- Each task must have a unique ID (task-1, task-2, etc.)
- Each task should be independently implementable (or list its dependencies)
- Branch names must be valid Git branch names (lowercase, hyphens for spaces)
- Scope paths should be specific but allow flexibility
- Acceptance criteria should be testable
- Dependencies must reference valid task IDs from the same breakdown
- Avoid circular dependencies
- ALL fields are REQUIRED - tasks missing any field will be rejected
- Granularity guideline: Aim for 1-4 hour tasks; break down larger work

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
    "dependencies": []
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
    "dependencies": ["task-1"]
  }
]

Output only the JSON array, no additional text.`;
};

/**
 * タスク品質評価プロンプトを構築
 *
 * 生成されたタスクの品質を評価するためのプロンプトを作成する。
 *
 * @param userInstruction 元のユーザー指示
 * @param tasks 生成されたタスクの配列
 * @param previousFeedback 前回の評価フィードバック（再試行時）
 * @returns 品質評価プロンプト
 */
export const buildTaskQualityPrompt = (
  userInstruction: string,
  tasks: TaskBreakdown[],
  previousFeedback?: string,
): string => {
  const tasksJson = JSON.stringify(tasks, null, 2);

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

Evaluation criteria:
1. **Completeness**: Does each task have all required fields (description, branch, scopePaths, acceptance, type, estimatedDuration, context)?
2. **Clarity**: Are descriptions clear and actionable?
3. **Acceptance criteria**: Are acceptance criteria specific, testable, and verifiable?
4. **Context sufficiency**: Does the context field contain ALL information needed to execute the task WITHOUT external references?
   - Technical approach, dependencies, constraints specified?
   - Existing patterns referenced with file paths?
   - Data models, error handling, security, testing requirements included?
5. **Granularity**: Are tasks appropriately sized (1-4 hours each)?
6. **Independence**: Can each task be implemented independently?

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
): string => {
  const basePrompt = buildPlanningPrompt(userInstruction);

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
 *
 * @param judgement 品質評価結果
 * @returns 整形されたフィードバック
 */
export const formatFeedbackForRetry = (judgement: TaskQualityJudgement): string => {
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

  return lines.join('\n');
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

    return { tasks, errors };
  } catch (error) {
    errors.push(
      `Unexpected error during parsing: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { tasks, errors };
  }
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
