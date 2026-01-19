import type { TaskStore } from '../task-store/interface.ts';
import type { GitEffects } from '../../adapters/vcs/git-effects.ts';
import type { RunnerEffects } from '../runner/runner-effects.ts';
import type { Config } from '../../types/config.ts';
import { createSchedulerOperations } from './scheduler-operations.ts';
import { createPlannerOperations } from './planner-operations.ts';
import { createWorkerOperations, type WorkerDeps } from './worker-operations.ts';
import { createJudgeOperations } from './judge-operations.ts';
import { initialSchedulerState } from './scheduler-state.ts';
import { taskId, repoPath } from '../../types/branded.ts';
import { getAgentType, getModel } from '../config/models.ts';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr, isErr } from 'option-t/plain_result';
import {
  buildDependencyGraph,
  computeExecutionLevels,
  detectSerialChains,
} from './dependency-graph.ts';
import { executeLevelParallel, computeBlockedTasks } from './parallel-executor.ts';
import { executeSerialChain } from './serial-executor.ts';
import type { Task } from '../../types/task.ts';

/**
 * Orchestrator依存関係
 */
export interface OrchestrateDeps {
  readonly taskStore: TaskStore;
  readonly gitEffects: GitEffects;
  readonly runnerEffects: RunnerEffects;
  readonly config: Config;
  readonly maxWorkers?: number;
}

/**
 * Orchestrator実行結果
 *
 * WHY: index.ts の OrchestrationResult と同一だが、循環インポート回避のため再定義
 */
export interface OrchestrationResult {
  /** 生成されたタスクID配列 */
  taskIds: string[];
  /** 完了したタスクID配列 */
  completedTaskIds: string[];
  /** 失敗したタスクID配列 */
  failedTaskIds: string[];
  /** 全体の成功可否 */
  success: boolean;
}

/**
 * Orchestratorエラー型
 */
export interface OrchestratorError {
  type: 'PLANNING_ERROR' | 'WORKER_ERROR' | 'JUDGE_ERROR' | 'UNKNOWN_ERROR';
  message: string;
  cause?: unknown;
}

/**
 * Orchestratorを作成
 *
 * ユーザー指示を受け取り、Planner→Worker→Judgeのサイクルを実行
 *
 * @param deps Orchestrator依存関係
 * @returns Orchestrator操作オブジェクト
 */
export const createOrchestrator = (deps: OrchestrateDeps) => {
  // 各コンポーネントの操作を生成
  const schedulerOps = createSchedulerOperations({ taskStore: deps.taskStore });
  const plannerOps = createPlannerOperations({
    taskStore: deps.taskStore,
    runnerEffects: deps.runnerEffects,
    appRepoPath: deps.config.appRepoPath,
    agentType: getAgentType(deps.config, 'planner'),
    model: getModel(deps.config, 'planner'),
    judgeModel: getModel(deps.config, 'judge'),
    maxQualityRetries: 3,
  });
  const workerDeps: WorkerDeps = {
    gitEffects: deps.gitEffects,
    runnerEffects: deps.runnerEffects,
    taskStore: deps.taskStore,
    appRepoPath: repoPath(deps.config.appRepoPath),
    agentCoordPath: deps.config.agentCoordPath,
    agentType: getAgentType(deps.config, 'worker'),
    model: getModel(deps.config, 'worker'),
  };
  const workerOps = createWorkerOperations(workerDeps);
  const judgeOps = createJudgeOperations({ taskStore: deps.taskStore });

  /**
   * ユーザー指示を実行
   *
   * 1. Planner: タスク分解
   * 2. Scheduler: タスク割り当て
   * 3. Worker: タスク実行
   * 4. Judge: 完了判定
   *
   * @param userInstruction ユーザーの指示
   * @returns 実行結果（Result型）
   */
  const executeInstruction = async (
    userInstruction: string,
  ): Promise<Result<OrchestrationResult, OrchestratorError>> => {
    const completedTaskIds: string[] = [];
    const failedTaskIds: string[] = [];
    let schedulerState = initialSchedulerState(deps.maxWorkers ?? 3);

    try {
      // 1. Planner: タスク分解
      console.log('🔍 Planning tasks...');
      const planningResult = await plannerOps.planTasks(userInstruction);

      if (isErr(planningResult)) {
        return createErr({
          type: 'PLANNING_ERROR',
          message: planningResult.err.message,
          cause: planningResult.err,
        });
      }

      const { taskIds } = planningResult.val;
      console.log(`📋 Generated ${taskIds.length} tasks`);
      if (taskIds.length > 0) {
        for (const createdTaskId of taskIds) {
          console.log(`  - ${createdTaskId}`);
        }
      }

      // 2. すべてのタスクを取得して依存関係グラフを構築
      console.log('\n🔗 Building dependency graph...');
      const tasks: Task[] = [];
      for (const rawTaskId of taskIds) {
        const taskResult = await deps.taskStore.readTask(taskId(rawTaskId));
        if (!taskResult.ok) {
          console.warn(`⚠️  Failed to load task ${rawTaskId}: ${taskResult.err.message}`);
          failedTaskIds.push(rawTaskId);
          continue;
        }
        tasks.push(taskResult.val);
      }

      const graph = buildDependencyGraph(tasks);

      // 3. 循環依存をチェック
      if (graph.cyclicDependencies && graph.cyclicDependencies.length > 0) {
        console.warn(
          `⚠️  Circular dependencies detected: ${graph.cyclicDependencies.map((id) => String(id)).join(', ')}`,
        );
        console.warn('   These tasks will be BLOCKED');

        // 循環依存タスクをBLOCKEDにする
        for (const tid of graph.cyclicDependencies) {
          await schedulerOps.blockTask(tid);
          failedTaskIds.push(String(tid));
        }
      }

      // 4. 直列チェーンを検出
      console.log('\n🔗 Detecting serial chains...');
      const serialChains = detectSerialChains(graph);

      if (serialChains.length > 0) {
        console.log(`  Found ${serialChains.length} serial chains:`);
        for (const chain of serialChains) {
          console.log(`    Chain: ${chain.map((id) => String(id)).join(' → ')}`);
        }
      } else {
        console.log('  No serial chains detected');
      }

      // 5. 直列チェーンのタスクIDを記録
      const serialTaskIds = new Set(graph.cyclicDependencies ?? []);
      for (const chain of serialChains) {
        for (const tid of chain) {
          serialTaskIds.add(tid);
        }
      }

      // 6. 直列チェーンを除外して実行レベルを計算
      const parallelTasks = tasks.filter((task) => !serialTaskIds.has(task.id));
      const parallelGraph =
        parallelTasks.length > 0 ? buildDependencyGraph(parallelTasks) : null;
      const { levels, unschedulable } = parallelGraph
        ? computeExecutionLevels(parallelGraph)
        : { levels: [], unschedulable: [] };

      if (unschedulable.length > 0) {
        console.warn(`⚠️  Unschedulable tasks: ${unschedulable.map((id) => String(id)).join(', ')}`);
        for (const tid of unschedulable) {
          await schedulerOps.blockTask(tid);
          failedTaskIds.push(String(tid));
        }
      }

      console.log(
        `\n📊 Execution plan: ${serialChains.length} serial chains, ${levels.length} parallel levels`,
      );
      for (let i = 0; i < levels.length; i++) {
        const levelTasks = levels[i];
        if (levelTasks) {
          console.log(`  Parallel Level ${i}: ${levelTasks.map((id) => String(id)).join(', ')}`);
        }
      }

      // 7. 直列チェーンを順番に実行
      if (serialChains.length > 0) {
        console.log('\n🔗 Executing serial chains...');
        for (const chain of serialChains) {
          const result = await executeSerialChain(
            chain,
            deps.taskStore,
            schedulerOps,
            workerOps,
            judgeOps,
            schedulerState,
          );
          schedulerState = result.updatedSchedulerState;

          completedTaskIds.push(...result.completed.map((id) => String(id)));
          failedTaskIds.push(...result.failed.map((id) => String(id)));

          // Worktreeをクリーンアップ
          if (result.worktreePath && chain[0]) {
            const firstTaskId = chain[0];
            await workerOps.cleanupWorktree(firstTaskId);
          }
        }
      }

      // 8. レベルごとに並列実行（直列チェーンを除外）
      const blockedTaskIds = new Set(graph.cyclicDependencies ?? []);
      for (const tid of unschedulable) {
        blockedTaskIds.add(tid);
      }
      // 直列チェーンのタスクもブロック済みとして扱う（並列実行から除外）
      for (const tid of serialTaskIds) {
        blockedTaskIds.add(tid);
      }

      for (let levelIndex = 0; levelIndex < levels.length; levelIndex++) {
        const level = levels[levelIndex];
        if (!level) continue;

        console.log(`\n📍 Executing Parallel Level ${levelIndex}...`);

        const levelResult = await executeLevelParallel(
          level,
          schedulerOps,
          workerOps,
          judgeOps,
          schedulerState,
          blockedTaskIds,
        );

        // スケジューラ状態を更新
        schedulerState = levelResult.updatedSchedulerState;

        // 結果を集計
        completedTaskIds.push(...levelResult.completed.map((id) => String(id)));
        failedTaskIds.push(...levelResult.failed.map((id) => String(id)));

        // 失敗タスクの依存先をブロック
        if (levelResult.failed.length > 0) {
          const newBlocked = computeBlockedTasks(levelResult.failed, graph);
          console.log(
            `  ⚠️  Blocking ${newBlocked.length} dependent tasks due to failures: ${newBlocked.map((id) => String(id)).join(', ')}`,
          );

          for (const tid of newBlocked) {
            blockedTaskIds.add(tid);
            await schedulerOps.blockTask(tid);
            failedTaskIds.push(String(tid));
          }
        }

        console.log(
          `  ✅ Parallel Level ${levelIndex} completed: ${levelResult.completed.length} succeeded, ${levelResult.failed.length} failed`,
        );
      }

      const success = failedTaskIds.length === 0;
      console.log(
        `\n${success ? '🎉' : '⚠️ '} Orchestration ${success ? 'completed' : 'finished with errors'}`,
      );
      console.log(`  Completed: ${completedTaskIds.length}`);
      console.log(`  Failed: ${failedTaskIds.length}`);

      return createOk({
        taskIds,
        completedTaskIds,
        failedTaskIds,
        success,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ Orchestration error: ${errorMessage}`);

      return createErr({
        type: 'UNKNOWN_ERROR',
        message: errorMessage,
        cause: error,
      });
    }
  };

  return {
    executeInstruction,
  };
};

/**
 * Orchestrator操作型
 */
export type OrchestratorOperations = ReturnType<typeof createOrchestrator>;
