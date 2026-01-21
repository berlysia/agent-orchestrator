import type { Task } from '../../types/task.ts';
import type { TaskStore } from '../task-store/interface.ts';
import type { SchedulerOperations } from './scheduler-operations.ts';
import { createWorkerOperations } from './worker-operations.ts';
import type { JudgeOperations } from './judge-operations.ts';
import type { GitEffects } from '../../adapters/vcs/git-effects.ts';
import { createBaseBranchResolver } from './base-branch-resolver.ts';
import type { Config } from '../../types/config.ts';
import type { SchedulerState } from './scheduler-state.ts';
import type { TaskId } from '../../types/branded.ts';
import type { RunnerEffects } from '../runner/runner-effects.ts';
import type { PlannerSessionEffects } from './planner-session-effects.ts';

type WorkerOperations = ReturnType<typeof createWorkerOperations>;
type BaseBranchResolver = ReturnType<typeof createBaseBranchResolver>;
import {
  buildDependencyGraph,
  computeExecutionLevels,
  detectSerialChains,
} from './dependency-graph.ts';
import { computeBlockedTasks } from './parallel-executor.ts';
import { executeSerialChain } from './serial-executor.ts';
import { executeDynamically } from './dynamic-scheduler.ts';

/**
 * タスク実行パイプライン入力
 *
 * WHY: executeInstruction, resumeFromSession, continueFromSession で重複している
 *      タスク実行ロジックを共通化するための入力インターフェース
 */
export interface TaskExecutionPipelineInput {
  /** 実行対象のタスク配列 */
  readonly tasks: Task[];
  /** タスクストア */
  readonly taskStore: TaskStore;
  /** スケジューラ操作 */
  readonly schedulerOps: SchedulerOperations;
  /** ワーカー操作 */
  readonly workerOps: WorkerOperations;
  /** Judge操作 */
  readonly judgeOps: JudgeOperations;
  /** Git操作 */
  readonly gitEffects: GitEffects;
  /** ベースブランチ解決 */
  readonly baseBranchResolver: BaseBranchResolver;
  /** 設定 */
  readonly config: Config;
  /** 最大並列ワーカー数 */
  readonly maxWorkers: number;
  /** 初期スケジューラ状態 */
  readonly initialSchedulerState: SchedulerState;
  /** 初期ブロック済みタスクID（既にブロックされているタスク） */
  readonly initialBlockedTaskIds?: Set<TaskId>;
  /** 全タスクID（依存関係グラフ構築用） */
  readonly globalTaskIds?: Set<TaskId>;
  /** Runner Effects（Planner再評価に必要） */
  readonly runnerEffects: RunnerEffects;
  /** Planner Session Effects（Planner再評価に必要） */
  readonly sessionEffects: PlannerSessionEffects;
  /** アプリケーションリポジトリパス */
  readonly appRepoPath: string;
  /** Coordination リポジトリパス */
  readonly coordRepoPath: string;
  /** Plannerエージェントタイプ */
  readonly plannerAgentType: 'claude' | 'codex';
  /** Plannerモデル */
  readonly plannerModel: string;
  /** Judgeモデル */
  readonly judgeModel: string;
}

/**
 * タスク実行パイプライン結果
 */
export interface TaskExecutionPipelineResult {
  /** 完了したタスクID */
  readonly completedTaskIds: string[];
  /** 失敗したタスクID（実際に実行して失敗） */
  readonly failedTaskIds: string[];
  /** ブロックされたタスクID（依存関係により実行されなかった） */
  readonly blockedTaskIds: string[];
  /** 更新されたスケジューラ状態 */
  readonly schedulerState: SchedulerState;
}

/**
 * タスク実行パイプライン
 *
 * WHY: executeInstruction, resumeFromSession, continueFromSession で重複している
 *      タスク実行コアロジック（約180行 x 3箇所）を共通化
 *
 * 処理フロー：
 * 1. 依存関係グラフ構築
 * 2. 循環依存チェック・ブロック
 * 3. 直列チェーン検出・実行
 * 4. 失敗タスクの依存先ブロック
 * 5. 並列タスク動的実行
 *
 * @param input パイプライン入力
 * @returns パイプライン実行結果
 */
export async function executeTaskPipeline(
  input: TaskExecutionPipelineInput,
): Promise<TaskExecutionPipelineResult> {
  const {
    tasks,
    taskStore,
    schedulerOps,
    workerOps,
    judgeOps,
    gitEffects,
    baseBranchResolver,
    config,
    maxWorkers,
    initialSchedulerState,
    initialBlockedTaskIds,
    globalTaskIds,
    runnerEffects,
    sessionEffects,
    appRepoPath,
    coordRepoPath,
    plannerAgentType,
    plannerModel,
    judgeModel,
  } = input;

  // WHY: Planner再評価に必要な依存関係を構築
  const plannerDeps = {
    taskStore,
    runnerEffects,
    sessionEffects,
    appRepoPath,
    coordRepoPath,
    agentType: plannerAgentType,
    model: plannerModel,
    judgeModel,
  };

  const completedTaskIds: string[] = [];
  const failedTaskIds: string[] = [];
  const blockedTaskIds: string[] = [];
  let schedulerState = initialSchedulerState;

  // 1. 依存関係グラフを構築
  console.log('\n🔗 Building dependency graph...');
  const graph = buildDependencyGraph(tasks, globalTaskIds);

  // 依存関係を表示
  console.log('\n📊 Task dependencies:');
  for (const task of tasks) {
    const deps = task.dependencies;
    if (deps.length === 0) {
      console.log(`  ${String(task.id)}: no dependencies`);
    } else {
      console.log(`  ${String(task.id)}: depends on [${deps.map((d) => String(d)).join(', ')}]`);
    }
  }

  // 2. 循環依存をチェック
  if (graph.cyclicDependencies && graph.cyclicDependencies.length > 0) {
    console.warn(
      `⚠️  Circular dependencies detected: ${graph.cyclicDependencies.map((id) => String(id)).join(', ')}`,
    );
    console.warn('   These tasks will be BLOCKED');

    // 循環依存タスクをBLOCKEDにする
    for (const tid of graph.cyclicDependencies) {
      await schedulerOps.blockTask(tid);
      blockedTaskIds.push(String(tid));
    }
  }

  // 3. 直列チェーンを検出
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

  // 4. 直列チェーンのタスクIDを記録
  const serialTaskIds = new Set(graph.cyclicDependencies ?? []);
  for (const chain of serialChains) {
    for (const tid of chain) {
      serialTaskIds.add(tid);
    }
  }

  // 5. 直列チェーンを除外して実行レベルを計算
  const parallelTasks = tasks.filter((task) => !serialTaskIds.has(task.id));
  const parallelGraph =
    parallelTasks.length > 0 ? buildDependencyGraph(parallelTasks, graph.allTaskIds) : null;
  const { levels, unschedulable } = parallelGraph
    ? computeExecutionLevels(parallelGraph)
    : { levels: [], unschedulable: [] };

  if (unschedulable.length > 0) {
    console.warn(
      `⚠️  Unschedulable tasks: ${unschedulable.map((id) => String(id)).join(', ')}`,
    );
    for (const tid of unschedulable) {
      await schedulerOps.blockTask(tid);
      blockedTaskIds.push(String(tid));
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

  // 6. 直列チェーンを順番に実行
  const serialChainFailedTasks: TaskId[] = [];
  if (serialChains.length > 0) {
    console.log('\n🔗 Executing serial chains...');
    for (const chain of serialChains) {
      const result = await executeSerialChain(
        chain,
        taskStore,
        schedulerOps,
        workerOps,
        judgeOps,
        gitEffects,
        schedulerState,
        config.iterations.serialChainTaskRetries,
        plannerDeps,
      );
      schedulerState = result.updatedSchedulerState;

      completedTaskIds.push(...result.completed.map((id) => String(id)));
      failedTaskIds.push(...result.failed.map((id) => String(id)));
      serialChainFailedTasks.push(...result.failed);

      // Worktreeをクリーンアップ
      if (result.worktreePath && chain[0]) {
        const firstTaskId = chain[0];
        await workerOps.cleanupWorktree(firstTaskId);
      }
    }

    // Serial chainで失敗したタスクの依存先を自動的にブロック
    if (serialChainFailedTasks.length > 0) {
      const dependentTasks = computeBlockedTasks(serialChainFailedTasks, graph);
      if (dependentTasks.length > 0) {
        console.log(
          `  ⚠️  Blocking ${dependentTasks.length} dependent tasks due to serial chain failures: ${dependentTasks.map((id) => String(id)).join(', ')}`,
        );
        for (const tid of dependentTasks) {
          await schedulerOps.blockTask(tid);
          blockedTaskIds.push(String(tid));
        }
      }
    }
  }

  // 7. レベルごとに並列実行（直列チェーンを除外）
  const blockedTaskIdsSet = new Set(initialBlockedTaskIds ?? []);
  for (const tid of graph.cyclicDependencies ?? []) {
    blockedTaskIdsSet.add(tid);
  }
  for (const tid of unschedulable) {
    blockedTaskIdsSet.add(tid);
  }
  // 直列チェーンのタスクもブロック済みとして扱う（並列実行から除外）
  for (const tid of serialTaskIds) {
    blockedTaskIdsSet.add(tid);
  }
  // Serial chainで失敗したタスクの依存先もブロック済みとして扱う
  if (serialChainFailedTasks.length > 0) {
    const dependentTasks = computeBlockedTasks(serialChainFailedTasks, graph);
    for (const tid of dependentTasks) {
      blockedTaskIdsSet.add(tid);
    }
  }

  if (parallelTasks.length > 0) {
    console.log(`\n📍 Executing parallel tasks with dynamic scheduling...`);

    const dynamicResult = await executeDynamically(
      parallelTasks.map((t) => t.id),
      parallelGraph!,
      schedulerOps,
      workerOps,
      judgeOps,
      taskStore,
      maxWorkers,
      schedulerState,
      blockedTaskIdsSet,
      baseBranchResolver,
      plannerDeps,
    );

    // スケジューラ状態を更新
    schedulerState = dynamicResult.updatedSchedulerState;

    // 結果を集計
    completedTaskIds.push(...dynamicResult.completed.map((id) => String(id)));
    failedTaskIds.push(...dynamicResult.failed.map((id) => String(id)));
    blockedTaskIds.push(...dynamicResult.blocked.map((id) => String(id)));

    console.log(
      `  ✅ Dynamic execution completed: ${dynamicResult.completed.length} succeeded, ${dynamicResult.failed.length} failed, ${dynamicResult.blocked.length} blocked`,
    );
  }

  return {
    completedTaskIds,
    failedTaskIds,
    blockedTaskIds,
    schedulerState,
  };
}
