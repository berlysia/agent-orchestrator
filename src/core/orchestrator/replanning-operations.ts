import type { Task, TaskState } from '../../types/task.ts';
import type { JudgementResult } from './judge-operations.ts';
import type { TaskStore } from '../task-store/interface.ts';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr } from 'option-t/plain_result';
import { taskId, repoPath, branchName } from '../../types/branded.ts';
import type { TaskId } from '../../types/branded.ts';
import type { TaskStoreError } from '../../types/errors.ts';
import { validationError, ioError } from '../../types/errors.ts';
import { createInitialTask } from '../../types/task.ts';
import { randomUUID } from 'node:crypto';
import type { PlannerDeps } from './planner-operations.ts';
import { parseAgentOutputWithErrors } from './planner-operations.ts';
import { extractSessionShort } from './task-helpers.ts';

/**
 * Planner再評価プロンプトを生成
 *
 * WHY: Judge判定で shouldReplan=true となったタスクを、
 *      より適切なサイズや構造に再分解するため
 *
 * @param task 元のタスク情報
 * @param runLog Worker実行ログ
 * @param judgement Judge判定結果
 * @param userInstruction 元のユーザー指示（オプショナル）
 * @returns Planner再評価用プロンプト
 */
export const buildReplanningPrompt = (
  task: Task,
  runLog: string,
  judgement: JudgementResult,
  userInstruction?: string,
): string => {
  const truncatedLog = runLog.length > 5000 ? runLog.slice(-5000) + '\n...(truncated)' : runLog;

  // WHY: 再計画時も元のユーザー指示を参照することで、要件欠落を防止（ADR-014）
  const userInstructionSection = userInstruction
    ? `## Original User Instruction

${userInstruction}

`
    : '';

  return `You are a Planner in a multi-agent development system. A task failed to complete and needs replanning.

${userInstructionSection}## Original Task Information

Branch: ${String(task.branch)}
Type: ${task.taskType}

Acceptance Criteria:
${task.acceptance}

Context:
${task.context}

Scope Paths:
${task.scopePaths.join(', ')}

## Execution Result

Worker Execution Log (last 5000 chars):
${truncatedLog}

## Judge Determination

Status: Failed (replanning required)
Reason: ${judgement.reason}
${judgement.missingRequirements && judgement.missingRequirements.length > 0 ? `Missing Requirements: ${judgement.missingRequirements.join(', ')}` : ''}

## Your Task

Replan the original task following these principles:

1. **Break into smaller, achievable tasks**: Each task should be completable in a single Worker iteration
2. **Make each task self-contained**: Minimize dependencies between tasks
3. **Specify clear dependencies**: If tasks must be executed in order, specify dependencies explicitly
4. **Address Judge feedback**: Ensure the replanned tasks resolve the issues identified by Judge

## Output Format

Generate a JSON array of new task breakdowns. Each task must have:
- \`id\`: Unique task identifier (e.g., "task-1", "task-2")
- \`description\`: Brief task summary (30-50 characters)
- \`branch\`: Branch name (should differ from original: "${String(task.branch)}")
- \`scopePaths\`: Array of target file paths
- \`acceptance\`: Acceptance criteria (specific, testable conditions)
- \`type\`: Task type ("implementation" | "documentation" | "investigation" | "integration")
- \`estimatedDuration\`: Estimated time in hours (max: 4)
- \`context\`: Detailed context including technical approach, dependencies, constraints
- \`dependencies\`: Array of task IDs this task depends on (use array indices from this output)
- \`summary\`: 30-character summary for logging (optional)

IMPORTANT: Output ONLY valid JSON array. No markdown code blocks, no additional text.

Example output format:
[
  {
    "id": "task-1",
    "description": "Implement core authentication logic",
    "branch": "feature/auth-core",
    "scopePaths": ["src/auth/core.ts"],
    "acceptance": "Authentication functions pass unit tests",
    "type": "implementation",
    "estimatedDuration": 2,
    "context": "Create authentication functions using JWT...",
    "dependencies": [],
    "summary": "Auth core implementation"
  },
  {
    "id": "task-2",
    "description": "Integrate auth into main app",
    "branch": "feature/auth-integration",
    "scopePaths": ["src/app.ts"],
    "acceptance": "App uses auth, integration tests pass",
    "type": "integration",
    "estimatedDuration": 1,
    "context": "Import auth functions and integrate...",
    "dependencies": [0],
    "summary": "Auth integration"
  }
]`;
};

/**
 * 失敗タスクをPlanner再評価して新タスクを生成
 *
 * WHY: shouldReplan=true となったタスクを自動的に再分解し、
 *      手動介入なしでタスク完了率を向上させる
 *
 * @param deps Planner依存関係
 * @param task 失敗した元のタスク
 * @param runLog Worker実行ログ
 * @param judgement Judge判定結果
 * @returns 生成されたタスクIDのリスト
 */
export const replanFailedTask = async (
  deps: PlannerDeps,
  task: Task,
  runLog: string,
  judgement: JudgementResult,
): Promise<Result<{ taskIds: TaskId[] }, TaskStoreError>> => {
  const prompt = buildReplanningPrompt(task, runLog, judgement, deps.userInstruction);

  // Planner実行
  const agentResult =
    deps.agentType === 'claude'
      ? await deps.runnerEffects.runClaudeAgent(prompt, deps.appRepoPath, deps.model)
      : await deps.runnerEffects.runCodexAgent(prompt, deps.appRepoPath, deps.model);

  if (!agentResult.ok) {
    return createErr(
      ioError(
        'replanFailedTask.runAgent',
        `Replanning agent execution failed: ${agentResult.err.message}`,
      ),
    );
  }

  // エージェント出力をパース
  const finalResponse = agentResult.val.finalResponse || '';
  const parseResult = parseAgentOutputWithErrors(finalResponse);

  if (parseResult.tasks.length === 0) {
    const errorMsg =
      parseResult.errors.length > 0
        ? `No valid task breakdowns from replanning. Errors: ${parseResult.errors.join('; ')}`
        : 'No valid task breakdowns found in replanning output';

    return createErr(ioError('replanFailedTask.parseOutput', errorMsg));
  }

  const taskBreakdowns = parseResult.tasks;

  // リプランニングセッションIDを生成し、短縮IDを抽出
  const replanningSessionId = `planner-replanning-${randomUUID()}`;
  const sessionShort = extractSessionShort(replanningSessionId);

  // タスクをTaskStoreに保存
  const taskIds: TaskId[] = [];
  const errors: string[] = [];

  for (const breakdown of taskBreakdowns) {
    const rawTaskId = breakdown.id;
    const uniqueTaskId = `task-${sessionShort}-${rawTaskId.replace(/^task-/, '')}`;
    const branchWithTaskId = `${breakdown.branch}-${uniqueTaskId}`;

    const newTask = createInitialTask({
      id: taskId(uniqueTaskId),
      repo: repoPath(deps.appRepoPath),
      branch: branchName(branchWithTaskId),
      scopePaths: breakdown.scopePaths,
      acceptance: breakdown.acceptance,
      taskType: breakdown.type,
      context: breakdown.context,
      dependencies: breakdown.dependencies.map((depIdx) => {
        // dependencies は配列インデックスなので、対応するタスクIDに変換
        if (typeof depIdx === 'number' && depIdx >= 0 && depIdx < taskBreakdowns.length) {
          const depTask = taskBreakdowns[depIdx];
          if (depTask) {
            const depRawId = depTask.id;
            const depUniqueId = `task-${sessionShort}-${depRawId.replace(/^task-/, '')}`;
            return taskId(depUniqueId);
          }
        }
        // 文字列の場合はそのまま使用（後方互換性）
        if (typeof depIdx === 'string') {
          const depUniqueId = `task-${sessionShort}-${depIdx.replace(/^task-/, '')}`;
          return taskId(depUniqueId);
        }
        return taskId(String(depIdx));
      }),
      summary: breakdown.summary,
    });

    // 再計画情報を追加
    newTask.replanningInfo = {
      iteration: 0,
      maxIterations: 3,
      originalTaskId: task.replanningInfo?.originalTaskId ?? task.id,
    };

    const result = await deps.taskStore.createTask(newTask);
    if (!result.ok) {
      errors.push(`Failed to create task ${uniqueTaskId}: ${result.err.message}`);
      continue;
    }

    taskIds.push(taskId(uniqueTaskId));
  }

  if (taskIds.length === 0) {
    return createErr(
      ioError(
        'replanFailedTask.createTasks',
        `All tasks failed to create. Errors: ${errors.join('; ')}`,
      ),
    );
  }

  return createOk({ taskIds });
};

/**
 * タスクを再計画状態に遷移
 *
 * WHY: shouldReplan=true のタスクを REPLACED_BY_REPLAN 状態にマークし、
 *      新タスクへの参照を記録する
 *
 * @param taskStore TaskStoreインスタンス
 * @param tid 元のタスクID
 * @param replacedByTaskIds 新タスクIDのリスト
 * @param judgement Judge判定結果
 * @param maxReplanIterations 最大再計画イテレーション回数
 * @returns 更新されたタスク
 */
export const markTaskAsReplanned = async (
  taskStore: TaskStore,
  tid: TaskId,
  replacedByTaskIds: TaskId[],
  judgement: JudgementResult,
  maxReplanIterations: number = 3,
): Promise<Result<Task, TaskStoreError>> => {
  const taskResult = await taskStore.readTask(tid);
  if (!taskResult.ok) {
    return taskResult;
  }

  const task = taskResult.val;
  const currentIteration = task.replanningInfo?.iteration ?? 0;
  const newIteration = currentIteration + 1;

  // 最大リトライ回数チェック
  if (newIteration > maxReplanIterations) {
    return createErr(
      validationError(`Task ${String(tid)} exceeded max replanning iterations (${maxReplanIterations})`),
    );
  }

  return await taskStore.updateTaskCAS(tid, task.version, (currentTask) => ({
    ...currentTask,
    state: 'REPLACED_BY_REPLAN' as TaskState,
    owner: null,
    updatedAt: new Date().toISOString(),
    replanningInfo: {
      iteration: newIteration,
      maxIterations: maxReplanIterations,
      originalTaskId: currentTask.replanningInfo?.originalTaskId ?? tid,
      replacedBy: replacedByTaskIds,
      replanReason: judgement.reason,
    },
  }));
};
