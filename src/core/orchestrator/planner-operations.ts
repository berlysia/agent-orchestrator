import type { TaskStore } from '../task-store/interface.ts';
import type { RunnerEffects } from '../runner/runner-effects.ts';
import { createInitialTask } from '../../types/task.ts';
import { taskId, repoPath, branchName, runId } from '../../types/branded.ts';
import { randomUUID } from 'node:crypto';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr, isErr } from 'option-t/plain_result';
import type { TaskStoreError } from '../../types/errors.ts';
import { ioError } from '../../types/errors.ts';
import { createInitialRun, RunStatus } from '../../types/run.ts';
import { AGENT_CONFIG } from '../config/models.ts';

/**
 * Planner依存関係
 */
export interface PlannerDeps {
  readonly taskStore: TaskStore;
  readonly runnerEffects: RunnerEffects;
  readonly appRepoPath: string;
  readonly agentType: 'claude' | 'codex';
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
 * タスク分解情報（エージェントが返すべき形式）
 */
export interface TaskBreakdown {
  /** タスクの説明 */
  description: string;
  /** ブランチ名 */
  branch: string;
  /** スコープパス */
  scopePaths: string[];
  /** 受け入れ基準 */
  acceptance: string;
}

/**
 * Planner操作を提供するファクトリ関数
 *
 * @param deps Planner依存関係
 * @returns Planner操作オブジェクト
 */
export const createPlannerOperations = (deps: PlannerDeps) => {
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

    // 1. Plannerプロンプトを構築
    const planningPrompt = buildPlanningPrompt(userInstruction);

    const planningRun = createInitialRun({
      id: runId(plannerRunId),
      taskId: taskId(plannerRunId),
      agentType: deps.agentType,
      logPath: `runs/${plannerRunId}.log`,
    });

    const ensureRunsResult = await deps.runnerEffects.ensureRunsDir();
    if (isErr(ensureRunsResult)) {
      return createErr(ioError('planTasks.ensureRunsDir', ensureRunsResult.err));
    }

    const saveRunResult = await deps.runnerEffects.saveRunMetadata(planningRun);
    if (isErr(saveRunResult)) {
      return createErr(ioError('planTasks.saveRunMetadata', saveRunResult.err));
    }

    const appendPlanningLog = async (content: string): Promise<void> => {
      const logResult = await deps.runnerEffects.appendLog(plannerRunId, content);
      if (isErr(logResult)) {
        console.warn(`⚠️  Failed to write planner log: ${logResult.err.message}`);
      }
    };

    await appendPlanningLog(`=== Planning Start ===\n`);
    await appendPlanningLog(`Instruction: ${userInstruction}\n`);
    await appendPlanningLog(`Prompt:\n${planningPrompt}\n\n`);

    // 2. エージェントを実行
    // WHY: 役割ごとに最適なモデルを使用（Planner = Opus）
    const runResult =
      deps.agentType === 'claude'
        ? await deps.runnerEffects.runClaudeAgent(
            planningPrompt,
            deps.appRepoPath,
            AGENT_CONFIG.planner.model!,
          )
        : await deps.runnerEffects.runCodexAgent(planningPrompt, deps.appRepoPath);

    let taskBreakdowns: TaskBreakdown[];

    if (isErr(runResult)) {
      await appendPlanningLog(`\n=== Planner Agent Error ===\n`);
      await appendPlanningLog(`${runResult.err.message}\n`);
      console.warn(
        `⚠️  Planner agent execution failed: ${runResult.err.message}. Falling back to dummy task breakdown.`,
      );
      // フォールバック: ダミーのタスク分解を使用
      taskBreakdowns = createDummyTaskBreakdown(userInstruction);
    } else {
      // 3. エージェント出力をパース
      const finalResponse = runResult.val.finalResponse || '';
      await appendPlanningLog(`\n=== Planner Agent Output ===\n`);
      await appendPlanningLog(`${finalResponse}\n`);
      taskBreakdowns = parseAgentOutput(finalResponse);

      if (taskBreakdowns.length === 0) {
        await appendPlanningLog(`\nNo valid task breakdowns. Using fallback.\n`);
        console.warn('⚠️  Agent returned no valid task breakdowns. Falling back to dummy.');
        taskBreakdowns = createDummyTaskBreakdown(userInstruction);
      }
    }

    // タスクをTaskStoreに保存
    const taskIds: string[] = [];
    const errors: string[] = [];

    for (const breakdown of taskBreakdowns) {
      const rawTaskId = `task-${randomUUID()}`;
      const task = createInitialTask({
        id: taskId(rawTaskId),
        repo: repoPath(deps.appRepoPath),
        branch: branchName(breakdown.branch),
        scopePaths: breakdown.scopePaths,
        acceptance: breakdown.acceptance,
      });

      const result = await deps.taskStore.createTask(task);
      if (!result.ok) {
        errors.push(`Failed to create task ${rawTaskId}: ${result.err.message}`);
        continue;
      }

      taskIds.push(rawTaskId);
    }

    if (taskIds.length > 0) {
      await appendPlanningLog(`\n=== Generated Tasks ===\n`);
      for (const rawTaskId of taskIds) {
        await appendPlanningLog(`- ${rawTaskId}\n`);
      }
    }

    const completedRun =
      taskIds.length > 0
        ? {
            ...planningRun,
            status: RunStatus.SUCCESS,
            finishedAt: new Date().toISOString(),
          }
        : {
            ...planningRun,
            status: RunStatus.FAILURE,
            finishedAt: new Date().toISOString(),
            errorMessage: errors.length > 0 ? errors.join(', ') : 'No tasks created',
          };
    await deps.runnerEffects.saveRunMetadata(completedRun);

    // 一部でもタスク作成に成功していれば成功とみなす
    if (taskIds.length === 0) {
      return createErr(ioError('planTasks', `Failed to create any tasks: ${errors.join(', ')}`));
    }

    return createOk({
      taskIds,
      runId: plannerRunId,
    });
  };

  return {
    planTasks,
  };
};

/**
 * Planner操作型
 */
export type PlannerOperations = ReturnType<typeof createPlannerOperations>;

/**
 * ダミーのタスク分解を生成（開発用）
 *
 * WHY: エージェント統合前の開発・テストのため
 * TODO: 実際のエージェント統合時に削除
 *
 * @param userInstruction ユーザー指示
 * @returns タスク分解情報の配列
 */
function createDummyTaskBreakdown(userInstruction: string): TaskBreakdown[] {
  console.warn('Using dummy task breakdown (agent integration not yet implemented)');

  return [
    {
      description: `Implement: ${userInstruction}`,
      branch: 'feature/main-implementation',
      scopePaths: ['src/'],
      acceptance: 'Feature is implemented and tested',
    },
  ];
}

/**
 * Plannerプロンプトを構築
 *
 * ユーザー指示からタスク分解を行うためのプロンプトを生成する。
 *
 * @param userInstruction ユーザーの指示
 * @returns Plannerプロンプト
 */
export const buildPlanningPrompt = (userInstruction: string): string => {
  return `You are a task planner for a multi-agent development system.

USER INSTRUCTION:
${userInstruction}

Your task is to break down this instruction into concrete, implementable tasks.

For each task, provide:
1. description: Clear description of what needs to be done
2. branch: Git branch name (e.g., "feature/add-login")
3. scopePaths: Array of file/directory paths that will be modified (e.g., ["src/auth/", "tests/auth/"])
4. acceptance: Acceptance criteria for completion

Output format (JSON array):
[
  {
    "description": "Task description",
    "branch": "feature/branch-name",
    "scopePaths": ["path1/", "path2/"],
    "acceptance": "Acceptance criteria"
  }
]

Rules:
- Create 1-5 tasks (prefer smaller, focused tasks)
- Each task should be independently implementable
- Branch names must be valid Git branch names (lowercase, hyphens for spaces)
- Scope paths should be specific but allow flexibility
- Acceptance criteria should be testable

Output only the JSON array, no additional text.`;
};

/**
 * エージェント出力をパース
 *
 * エージェントが返すJSON形式のタスク分解結果をパースする。
 * マークダウンコードブロックに囲まれている場合も対応。
 *
 * @param output エージェントの出力
 * @returns タスク分解情報の配列
 */
export const parseAgentOutput = (output: string): TaskBreakdown[] => {
  try {
    // JSONブロックを抽出（マークダウンコードブロックに囲まれている可能性）
    // 優先順位: コードブロック > オブジェクト全体 > 配列全体
    const codeBlockMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    const objectMatch = output.match(/^(\{[\s\S]*\})$/);
    const arrayMatch = output.match(/^(\[[\s\S]*\])$/);

    const jsonMatch = codeBlockMatch || objectMatch || arrayMatch;

    if (!jsonMatch || !jsonMatch[1]) {
      console.error('No JSON content found in output');
      return [];
    }

    const jsonStr = jsonMatch[1];
    const parsed = JSON.parse(jsonStr.trim());

    if (!Array.isArray(parsed)) {
      console.warn('Agent output is not an array, wrapping in array');
      return [parsed];
    }

    // バリデーション
    return parsed.filter((item) => {
      const isValid =
        typeof item.description === 'string' &&
        typeof item.branch === 'string' &&
        Array.isArray(item.scopePaths) &&
        typeof item.acceptance === 'string';

      if (!isValid) {
        console.warn('Invalid task breakdown item:', item);
      }

      return isValid;
    });
  } catch (error) {
    console.error('Failed to parse agent output:', error);
    console.error('Output was:', output);
    return [];
  }
};
