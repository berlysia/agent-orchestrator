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
import { z } from 'zod';

/**
 * Planner依存関係
 */
export interface PlannerDeps {
  readonly taskStore: TaskStore;
  readonly runnerEffects: RunnerEffects;
  readonly appRepoPath: string;
  readonly agentType: 'claude' | 'codex';
  readonly model?: string;
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
    // WHY: 役割ごとに最適なモデルを使用（Config から取得）
    const runResult =
      deps.agentType === 'claude'
        ? await deps.runnerEffects.runClaudeAgent(
            planningPrompt,
            deps.appRepoPath,
            deps.model!,
          )
        : await deps.runnerEffects.runCodexAgent(planningPrompt, deps.appRepoPath, deps.model);

    // 2. エージェント実行結果の確認
    if (isErr(runResult)) {
      await appendPlanningLog(`\n=== Planner Agent Error ===\n`);
      await appendPlanningLog(`${runResult.err.message}\n`);

      const failedRun = {
        ...planningRun,
        status: RunStatus.FAILURE,
        finishedAt: new Date().toISOString(),
        errorMessage: `Planner agent execution failed: ${runResult.err.message}`,
      };
      await deps.runnerEffects.saveRunMetadata(failedRun);

      return createErr(
        ioError('planTasks.runAgent', `Planner agent execution failed: ${runResult.err.message}`),
      );
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

    // 有効なタスクが1つもない場合はエラー
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

      return createErr(ioError('planTasks.parseOutput', errorMsg));
    }

    const taskBreakdowns = parseResult.tasks;

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
        taskType: breakdown.type,
        context: breakdown.context,
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

For each task, provide:
1. description: Clear description of what needs to be done
2. branch: Git branch name (e.g., "feature/add-login")
3. scopePaths: Array of file/directory paths that will be modified (e.g., ["src/auth/", "tests/auth/"])
4. acceptance: Acceptance criteria for completion
5. type: Task type (REQUIRED) - one of:
   - "implementation": New features or existing feature modifications
   - "documentation": Documentation creation or updates
   - "investigation": Research or investigation tasks
   - "integration": System integration or connectivity work
6. estimatedDuration: Estimated hours (REQUIRED) - number between 0.5 and 8
   - Aim for 1-4 hours per task (smaller, focused tasks preferred)
   - If a task exceeds 4 hours, consider breaking it down further
7. context: Context information needed to execute the task (REQUIRED)
   - Include relevant background, constraints, dependencies
   - Reference related files, patterns, or design decisions
   - Specify any special considerations or gotchas

Output format (JSON array):
[
  {
    "description": "Task description",
    "branch": "feature/branch-name",
    "scopePaths": ["path1/", "path2/"],
    "acceptance": "Acceptance criteria",
    "type": "implementation",
    "estimatedDuration": 2.5,
    "context": "Context information for task execution"
  }
]

Rules:
- Create 1-5 tasks (prefer smaller, focused tasks)
- Each task should be independently implementable
- Branch names must be valid Git branch names (lowercase, hyphens for spaces)
- Scope paths should be specific but allow flexibility
- Acceptance criteria should be testable
- ALL fields are REQUIRED - tasks missing any field will be rejected
- Granularity guideline: Aim for 1-4 hour tasks; break down larger work

Example:
[
  {
    "description": "Implement user authentication with JWT",
    "branch": "feature/auth-jwt",
    "scopePaths": ["src/auth/", "tests/auth/"],
    "acceptance": "Users can log in with email/password and receive JWT token. Token validation works correctly.",
    "type": "implementation",
    "estimatedDuration": 3.0,
    "context": "Using existing database schema. Follow OWASP security guidelines for password hashing (bcrypt). JWT expires in 24 hours."
  },
  {
    "description": "Document authentication flow and API endpoints",
    "branch": "docs/auth-api",
    "scopePaths": ["docs/api/"],
    "acceptance": "API documentation includes all auth endpoints with request/response examples",
    "type": "documentation",
    "estimatedDuration": 1.5,
    "context": "Follow existing API documentation format in docs/api/. Include error responses and rate limiting details."
  }
]

Output only the JSON array, no additional text.`;
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
