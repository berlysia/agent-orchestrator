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
4. acceptance: COMPLETE, VERIFIABLE acceptance criteria (REQUIRED)
   - Must be specific enough to verify task completion without ambiguity
   - Include WHAT to verify (e.g., "User can login with email/password")
   - Include HOW to verify (e.g., "Test with valid/invalid credentials, check JWT token generation")
   - Specify edge cases and error scenarios to test
   - Define performance/security requirements if applicable
   - Example: "Users can login with email/password. Valid credentials generate JWT token with 24h expiry. Invalid credentials return 401 with error message. Rate limiting allows 5 attempts per minute."
5. type: Task type (REQUIRED) - one of:
   - "implementation": New features or existing feature modifications
   - "documentation": Documentation creation or updates
   - "investigation": Research or investigation tasks
   - "integration": System integration or connectivity work
6. estimatedDuration: Estimated hours (REQUIRED) - number between 0.5 and 8
   - Aim for 1-4 hours per task (smaller, focused tasks preferred)
   - If a task exceeds 4 hours, consider breaking it down further
7. context: COMPLETE implementation context (REQUIRED)
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
    "acceptance": "Users can login with email/password and receive JWT token with 24h expiry. VERIFY: (1) Valid credentials (test@example.com / password123) generate token and return 200. (2) Invalid credentials return 401 with error message 'Invalid credentials'. (3) Missing email/password returns 400 with validation errors. (4) Token validation succeeds for valid tokens, fails for expired/invalid tokens. (5) Rate limiting blocks after 5 failed attempts per minute per IP. (6) All tests pass including unit tests for token generation/validation and integration tests for full login flow.",
    "type": "implementation",
    "estimatedDuration": 3.0,
    "context": "Implement using jsonwebtoken v9.0+ library for JWT generation/validation. Use bcrypt with cost factor 10 for password hashing. Store user credentials in existing 'users' table defined in src/db/schema.sql (columns: id, email, password_hash, created_at). Follow the authentication pattern from src/auth/oauth.ts for middleware structure. JWT payload: {userId, email, exp}. Store token in HTTP-only cookie named 'auth_token'. Implement rate limiting using existing RateLimiter class in src/middleware/rate-limit.ts (5 attempts per minute per IP). Handle errors: validation errors (400), authentication failures (401), server errors (500). Add unit tests in tests/auth/jwt.test.ts for token generation, validation, expiry. Add integration tests in tests/auth/login.test.ts for full login flow with database. Security: validate email format with regex, sanitize inputs, use constant-time comparison for passwords. Must pass existing security linter rules in .eslintrc.json."
  },
  {
    "description": "Document authentication flow and API endpoints",
    "branch": "docs/auth-api",
    "scopePaths": ["docs/api/"],
    "acceptance": "API documentation includes all authentication endpoints with complete request/response examples. VERIFY: (1) POST /auth/login documented with example request body {email, password}, success response {token, user}, error responses 400/401/429/500. (2) POST /auth/logout documented with cookie clearing behavior. (3) GET /auth/verify documented with token validation. (4) Authentication flow diagram shows login -> token generation -> cookie storage -> subsequent requests. (5) Rate limiting rules documented (5 attempts/minute). (6) Security considerations section includes password requirements, token expiry, HTTPS requirement. (7) All examples are copy-pasteable and work with actual API.",
    "type": "documentation",
    "estimatedDuration": 1.5,
    "context": "Follow existing API documentation format in docs/api/README.md (uses Markdown with code blocks). Reference the authentication implementation in src/auth/ for accurate technical details. Include complete curl examples for each endpoint. Document all HTTP status codes: 200 (success), 400 (validation error), 401 (authentication failed), 429 (rate limited), 500 (server error). Add Mermaid sequence diagram for authentication flow (see docs/diagrams/ for examples). Cross-reference related docs: docs/security/authentication.md for security details, docs/setup/environment.md for HTTPS setup. Include troubleshooting section for common issues: cookie not set (check HTTPS), rate limited (wait 1 minute), token expired (re-login). Validation: run through examples manually and verify they work with local dev server."
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
