import type { TaskStore } from '../task-store/interface.ts';
import { createInitialTask } from '../../types/task.ts';
import { taskId, repoPath, branchName } from '../../types/branded.ts';
import { randomUUID } from 'node:crypto';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr } from 'option-t/plain_result';
import type { TaskStoreError } from '../../types/errors.ts';
import { ioError } from '../../types/errors.ts';

/**
 * Planner依存関係
 */
export interface PlannerDeps {
  readonly taskStore: TaskStore;
  readonly appRepoPath: string;
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
    // TODO: 実際のエージェント実行を統合
    // 現時点では簡易的にダミーのタスク分解を使用

    const plannerTaskId = `planner-${randomUUID()}`;

    // TODO: エージェント実行
    // const runResult = await runAgent({
    //   agentType,
    //   instruction: buildPlanningPrompt(userInstruction),
    //   cwd: deps.appRepoPath,
    // });
    // const taskBreakdowns = parseAgentOutput(runResult.output);

    // 現時点ではダミーのタスク分解を使用
    const taskBreakdowns = createDummyTaskBreakdown(userInstruction);

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

    // 一部でもタスク作成に成功していれば成功とみなす
    if (taskIds.length === 0) {
      return createErr(ioError('planTasks', `Failed to create any tasks: ${errors.join(', ')}`));
    }

    return createOk({
      taskIds,
      runId: plannerTaskId,
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

// TODO: 将来の実装用 - エージェント統合時に追加
// export const buildPlanningPrompt = (userInstruction: string): string => { ... };
// export const parseAgentOutput = (output: string): TaskBreakdown[] => { ... };
