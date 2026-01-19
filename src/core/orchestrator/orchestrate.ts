import type { TaskStore } from '../task-store/interface.ts';
import type { GitEffects } from '../../adapters/vcs/git-effects.ts';
import type { RunnerEffects } from '../runner/runner-effects.ts';
import type { Config } from '../../types/config.ts';
import { createSchedulerOperations } from './scheduler-operations.ts';
import { createPlannerOperations } from './planner-operations.ts';
import { createWorkerOperations, type WorkerDeps } from './worker-operations.ts';
import { createJudgeOperations } from './judge-operations.ts';
import { createIntegrationOperations } from './integration-operations.ts';
import { initialSchedulerState } from './scheduler-state.ts';
import { taskId, repoPath, branchName, type TaskId } from '../../types/branded.ts';
import { getAgentType, getModel } from '../config/models.ts';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr, isErr } from 'option-t/plain_result';
import {
  buildDependencyGraph,
  computeExecutionLevels,
  detectSerialChains,
} from './dependency-graph.ts';
import { computeBlockedTasks } from './parallel-executor.ts';
import { executeSerialChain } from './serial-executor.ts';
import { executeDynamically } from './dynamic-scheduler.ts';
import type { Task } from '../../types/task.ts';
import { TaskState } from '../../types/task.ts';
import type { PlannerSessionEffects } from './planner-session-effects.ts';

/**
 * Orchestrator依存関係
 */
export interface OrchestrateDeps {
  readonly taskStore: TaskStore;
  readonly gitEffects: GitEffects;
  readonly runnerEffects: RunnerEffects;
  readonly sessionEffects: PlannerSessionEffects;
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
  /** 失敗したタスクID配列（実際に実行して失敗したタスクのみ） */
  failedTaskIds: string[];
  /** ブロックされたタスクID配列（依存関係により実行されなかったタスク） */
  blockedTaskIds: string[];
  /** 全体の成功可否 */
  success: boolean;
}

/**
 * Continue実行結果
 *
 * WHY: agent continue コマンドの実行結果を返すための型定義
 */
export interface ContinueResult {
  /** 完了したかどうか */
  isComplete: boolean;
  /** 実行した反復回数 */
  iterationsPerformed: number;
  /** 完了スコア（0-100） */
  completionScore?: number;
  /** 残っている未完了の側面 */
  remainingMissingAspects: string[];
  /** 全タスクID（累積） */
  allTaskIds: string[];
  /** 完了タスクID（累積） */
  completedTaskIds: string[];
  /** 失敗タスクID（累積） */
  failedTaskIds: string[];
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
    sessionEffects: deps.sessionEffects,
    appRepoPath: deps.config.appRepoPath,
    coordRepoPath: deps.config.agentCoordPath,
    agentType: getAgentType(deps.config, 'planner'),
    model: getModel(deps.config, 'planner'),
    judgeModel: getModel(deps.config, 'judge'),
    plannerQualityRetries: deps.config.iterations.plannerQualityRetries,
    qualityThreshold: deps.config.planning.qualityThreshold,
    strictContextValidation: deps.config.planning.strictContextValidation,
    maxTaskDuration: deps.config.planning.maxTaskDuration,
    maxTasks: deps.config.planning.maxTasks,
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
  const judgeOps = createJudgeOperations({
    taskStore: deps.taskStore,
    runnerEffects: deps.runnerEffects,
    appRepoPath: deps.config.appRepoPath,
    agentType: getAgentType(deps.config, 'judge'),
    model: getModel(deps.config, 'judge') ?? 'claude-haiku-4-5',
    judgeTaskRetries: deps.config.iterations.judgeTaskRetries,
  });
  const integrationOps = createIntegrationOperations({
    taskStore: deps.taskStore,
    gitEffects: deps.gitEffects,
    appRepoPath: deps.config.appRepoPath,
  });

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
    const blockedTaskIds: string[] = [];
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

      const { taskIds, runId: sessionId } = planningResult.val;
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

      // 依存関係を表示
      console.log('\n📊 Task dependencies:');
      for (const task of tasks) {
        const deps = task.dependencies;
        if (deps.length === 0) {
          console.log(`  ${String(task.id)}: no dependencies`);
        } else {
          console.log(
            `  ${String(task.id)}: depends on [${deps.map((d) => String(d)).join(', ')}]`,
          );
        }
      }

      // 3. 循環依存をチェック
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

      // 7. 直列チェーンを順番に実行
      const serialChainFailedTasks: TaskId[] = [];
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
            deps.config.iterations.serialChainTaskRetries,
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

      // 8. レベルごとに並列実行（直列チェーンを除外）
      const blockedTaskIdsSet = new Set(graph.cyclicDependencies ?? []);
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
          deps.taskStore,
          deps.maxWorkers ?? 3,
          schedulerState,
          blockedTaskIdsSet,
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

      // 9. 統合フェーズ（並列実行されたタスクが複数ある場合のみ）
      if (completedTaskIds.length > 1) {
        console.log('\n🔗 Integration phase: merging parallel task branches...');

        // 完了したタスクを取得
        const completedTasks: Task[] = [];
        for (const rawTaskId of completedTaskIds) {
          const taskResult = await deps.taskStore.readTask(taskId(rawTaskId));
          if (taskResult.ok && taskResult.val.state === TaskState.DONE) {
            completedTasks.push(taskResult.val);
          }
        }

        if (completedTasks.length > 1) {
          // ベースブランチを取得
          const currentBranchResult = await deps.gitEffects.getCurrentBranch(
            repoPath(deps.config.appRepoPath),
          );
          const baseBranch = currentBranchResult.ok ? currentBranchResult.val : branchName('main');

          // タスクを統合
          const integrationResult = await integrationOps.integrateTasks(completedTasks, baseBranch);

          if (integrationResult.ok) {
            const result = integrationResult.val;
            if (result.success) {
              console.log(`  ✅ Successfully integrated ${result.integratedTaskIds.length} tasks`);

              // 統合ブランチの取り込み方法を提示（設定に基づく）
              const finalResult = await integrationOps.finalizeIntegration(
                result.integrationBranch,
                baseBranch,
                { method: deps.config.integration?.method ?? 'auto' },
              );

              if (finalResult.ok) {
                if (finalResult.val.method === 'pr') {
                  console.log(`  🔀 Pull Request created: ${finalResult.val.prUrl}`);
                } else {
                  console.log(`  📋 To merge the integration branch, run:`);
                  console.log(`     ${finalResult.val.mergeCommand}`);
                }
              } else {
                console.warn(`  ⚠️  Failed to finalize integration: ${finalResult.err.message}`);
              }
            } else {
              console.log(`  ⚠️  Integration completed with conflicts`);
              console.log(`    Integrated: ${result.integratedTaskIds.length} tasks`);
              console.log(`    Conflicted: ${result.conflictedTaskIds.length} tasks`);
              if (result.conflictResolutionTaskId) {
                console.log(`    Resolution task: ${result.conflictResolutionTaskId}`);
              }
            }
          } else {
            console.warn(`  ⚠️  Integration failed: ${integrationResult.err.message}`);
          }
        }
      }

      // 10. 最終完了判定フェーズ
      if (completedTaskIds.length > 0 || failedTaskIds.length > 0) {
        console.log('\n🎯 Final completion evaluation...');

        // 完了タスクと失敗タスクの詳細を取得
        const completedTaskDescriptions: string[] = [];
        const failedTaskDescriptions: string[] = [];

        for (const rawTaskId of completedTaskIds) {
          const taskResult = await deps.taskStore.readTask(taskId(rawTaskId));
          if (taskResult.ok) {
            completedTaskDescriptions.push(
              `[${rawTaskId}] ${taskResult.val.acceptance || taskResult.val.branch}`,
            );
          }
        }

        for (const rawTaskId of failedTaskIds) {
          const taskResult = await deps.taskStore.readTask(taskId(rawTaskId));
          if (taskResult.ok) {
            failedTaskDescriptions.push(
              `[${rawTaskId}] ${taskResult.val.acceptance || taskResult.val.branch}`,
            );
          }
        }

        // 最終判定を実行
        const finalJudgement = await plannerOps.judgeFinalCompletion(
          userInstruction,
          completedTaskDescriptions,
          failedTaskDescriptions,
        );

        if (finalJudgement.completionScore !== undefined) {
          console.log(`  Completion score: ${finalJudgement.completionScore}%`);
        }

        if (finalJudgement.isComplete) {
          console.log('  ✅ Original instruction fully satisfied');
        } else {
          console.log('  ⚠️  Original instruction not fully satisfied');

          if (finalJudgement.missingAspects.length > 0) {
            console.log('  Missing aspects:');
            finalJudgement.missingAspects.forEach((aspect, idx) => {
              console.log(`    ${idx + 1}. ${aspect}`);
            });
          }

          if (finalJudgement.additionalTaskSuggestions.length > 0) {
            console.log('  Suggested additional tasks:');
            finalJudgement.additionalTaskSuggestions.forEach((suggestion, idx) => {
              console.log(`    ${idx + 1}. ${suggestion}`);
            });
          }

          // 継続実行の提案
          console.log('\n  💡 Tip: Run the following command to generate additional tasks:');
          console.log(`\n     agent continue --session ${sessionId}\n`);
        }

        // 最終判定結果をセッションに保存
        const sessionResult = await deps.sessionEffects.loadSession(sessionId);
        if (!isErr(sessionResult)) {
          const session = sessionResult.val;
          session.finalJudgement = {
            isComplete: finalJudgement.isComplete,
            missingAspects: finalJudgement.missingAspects,
            additionalTaskSuggestions: finalJudgement.additionalTaskSuggestions,
            completionScore: finalJudgement.completionScore,
            evaluatedAt: new Date().toISOString(),
          };

          const saveResult = await deps.sessionEffects.saveSession(session);
          if (isErr(saveResult)) {
            console.warn(
              `⚠️  Failed to save final judgement to session: ${saveResult.err.message}`,
            );
          }
        }
      }

      const success = failedTaskIds.length === 0;
      console.log(
        `\n${success ? '🎉' : '⚠️ '} Orchestration ${success ? 'completed' : 'finished with errors'}`,
      );
      console.log(`  Completed: ${completedTaskIds.length}`);
      console.log(`  Failed: ${failedTaskIds.length}`);
      if (blockedTaskIds.length > 0) {
        console.log(`  Blocked: ${blockedTaskIds.length}`);
      }

      return createOk({
        taskIds,
        completedTaskIds,
        failedTaskIds,
        blockedTaskIds,
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

  /**
   * 既存セッションからタスクを再開
   *
   * WHY: 失敗・停止したタスクを含むセッションから、実行を再開する
   *
   * @param sessionId セッションID
   * @param failedTaskHandling 失敗タスクの処理方法（retry/continue/skip）
   * @returns 実行結果（Result型）
   */
  const resumeFromSession = async (
    sessionId: string,
    failedTaskHandling: Map<string, 'retry' | 'continue' | 'skip'>,
  ): Promise<Result<OrchestrationResult, OrchestratorError>> => {
    const completedTaskIds: string[] = [];
    const failedTaskIds: string[] = [];
    const blockedTaskIds: string[] = [];
    let schedulerState = initialSchedulerState(deps.maxWorkers ?? 3);

    try {
      // 1. セッションを読み込み
      console.log(`📂 Loading session: ${sessionId}`);
      const sessionResult = await deps.sessionEffects.loadSession(sessionId);
      if (isErr(sessionResult)) {
        return createErr({
          type: 'PLANNING_ERROR',
          message: `Failed to load session: ${sessionResult.err.message}`,
          cause: sessionResult.err,
        });
      }

      const session = sessionResult.val;
      console.log(`📋 Session instruction: ${session.instruction}`);
      console.log(`📋 Tasks in session: ${session.generatedTasks.length}`);

      // 3. セッションのタスクIDを抽出
      const taskIds: string[] = session.generatedTasks.map((t: { id: string }) => t.id);

      // 4. すべてのタスクを取得して状態を確認
      console.log('\n🔍 Checking task states...');
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

      // 5. 失敗/停止タスクの処理を適用
      for (const task of tasks) {
        const handling = failedTaskHandling.get(String(task.id));

        if (task.state === TaskState.BLOCKED || task.state === TaskState.CANCELLED) {
          if (handling === 'retry') {
            console.log(`  🔄 Resetting task ${task.id} for retry`);
            // Worktreeをクリーンアップ
            await workerOps.cleanupWorktree(task.id);
            // タスクをREADY状態にリセット
            await schedulerOps.resetTaskToReady(task.id);
          } else if (handling === 'continue') {
            console.log(`  ➡️  Task ${task.id} will continue from existing state`);
            // タスクをREADY状態にリセット（worktreeはそのまま）
            await schedulerOps.resetTaskToReady(task.id);
          } else if (handling === 'skip') {
            console.log(`  ⏭️  Skipping task ${task.id}`);
            failedTaskIds.push(String(task.id));
          }
        } else if (task.state === TaskState.DONE) {
          completedTaskIds.push(String(task.id));
        }
      }

      // 6. 依存関係グラフを構築して実行（executeInstructionと同じロジック）
      console.log('\n🔗 Building dependency graph...');
      const allTasks: Task[] = [];
      for (const rawTaskId of taskIds) {
        const taskResult = await deps.taskStore.readTask(taskId(rawTaskId));
        if (taskResult.ok) {
          allTasks.push(taskResult.val);
        }
      }

      const graph = buildDependencyGraph(allTasks);

      // 依存関係を表示
      console.log('\n📊 Task dependencies:');
      for (const task of allTasks) {
        const deps = task.dependencies;
        if (deps.length === 0) {
          console.log(`  ${String(task.id)}: no dependencies`);
        } else {
          console.log(
            `  ${String(task.id)}: depends on [${deps.map((d) => String(d)).join(', ')}]`,
          );
        }
      }

      // 7. 実行（既に完了したタスクはスキップ）
      const blockedTaskIdsSet = new Set([
        ...(graph.cyclicDependencies ?? []),
        ...failedTaskIds.map((id) => taskId(id)),
      ]);

      // 直列チェーンを検出
      const serialChains = detectSerialChains(graph);
      const serialTaskIds = new Set(graph.cyclicDependencies ?? []);
      for (const chain of serialChains) {
        for (const tid of chain) {
          serialTaskIds.add(tid);
        }
      }

      const parallelTasks = allTasks.filter((task) => !serialTaskIds.has(task.id));
      const parallelGraph =
        parallelTasks.length > 0 ? buildDependencyGraph(parallelTasks, graph.allTaskIds) : null;

      // 8. 直列チェーンを実行
      const resumeSerialChainFailedTasks: TaskId[] = [];
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
            deps.config.iterations.serialChainTaskRetries,
          );
          schedulerState = result.updatedSchedulerState;

          completedTaskIds.push(...result.completed.map((id) => String(id)));
          failedTaskIds.push(...result.failed.map((id) => String(id)));
          resumeSerialChainFailedTasks.push(...result.failed);

          if (result.worktreePath && chain[0]) {
            const firstTaskId = chain[0];
            await workerOps.cleanupWorktree(firstTaskId);
          }
        }

        // Serial chainで失敗したタスクの依存先を自動的にブロック
        if (resumeSerialChainFailedTasks.length > 0) {
          const dependentTasks = computeBlockedTasks(resumeSerialChainFailedTasks, graph);
          if (dependentTasks.length > 0) {
            console.log(
              `  ⚠️  Blocking ${dependentTasks.length} dependent tasks due to serial chain failures: ${dependentTasks.map((id) => String(id)).join(', ')}`,
            );
            for (const tid of dependentTasks) {
              blockedTaskIdsSet.add(tid);
              await schedulerOps.blockTask(tid);
              blockedTaskIds.push(String(tid));
            }
          }
        }
      }

      // 9. 並列タスクを動的スケジューリングで実行
      if (parallelTasks.length > 0) {
        console.log(`\n📍 Executing parallel tasks with dynamic scheduling...`);

        const dynamicResult = await executeDynamically(
          parallelTasks.map((t) => t.id),
          parallelGraph!,
          schedulerOps,
          workerOps,
          judgeOps,
          deps.taskStore,
          deps.maxWorkers ?? 3,
          schedulerState,
          blockedTaskIdsSet,
        );

        schedulerState = dynamicResult.updatedSchedulerState;
        completedTaskIds.push(...dynamicResult.completed.map((id) => String(id)));
        failedTaskIds.push(...dynamicResult.failed.map((id) => String(id)));
        blockedTaskIds.push(...dynamicResult.blocked.map((id) => String(id)));

        console.log(
          `  ✅ Dynamic execution completed: ${dynamicResult.completed.length} succeeded, ${dynamicResult.failed.length} failed, ${dynamicResult.blocked.length} blocked`,
        );
      }

      const success = failedTaskIds.length === 0;
      console.log(
        `\n${success ? '🎉' : '⚠️ '} Session resumption ${success ? 'completed' : 'finished with errors'}`,
      );
      console.log(`  Completed: ${completedTaskIds.length}`);
      console.log(`  Failed: ${failedTaskIds.length}`);
      if (blockedTaskIds.length > 0) {
        console.log(`  Blocked: ${blockedTaskIds.length}`);
      }

      return createOk({
        taskIds,
        completedTaskIds,
        failedTaskIds,
        blockedTaskIds,
        success,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ Session resumption error: ${errorMessage}`);

      return createErr({
        type: 'UNKNOWN_ERROR',
        message: errorMessage,
        cause: error,
      });
    }
  };

  /**
   * 失敗/未完了セッションから継続実行
   *
   * WHY: 最終判定で未完了と判定されたセッションから、追加タスクを生成して実行を続ける
   *
   * @param sessionId セッションID
   * @param options 実行オプション
   * @returns 継続実行結果（Result型）
   */
  const continueFromSession = async (
    sessionId: string,
    options: {
      maxIterations: number;
      autoConfirm: boolean;
      dryRun: boolean;
    },
  ): Promise<Result<ContinueResult, OrchestratorError>> => {
    const allTaskIds: string[] = [];
    const allCompletedTaskIds: string[] = [];
    const allFailedTaskIds: string[] = [];
    let iterationsPerformed = 0;

    const HARD_CAP_ITERATIONS = 10;
    const maxIterations = Math.min(options.maxIterations, HARD_CAP_ITERATIONS);

    try {
      console.log(`🔄 Continue from session: ${sessionId}`);
      console.log(`   Max iterations: ${maxIterations}`);

      // 反復ループ
      while (iterationsPerformed < maxIterations) {
        // 1. セッションを読み込み
        const sessionResult = await deps.sessionEffects.loadSession(sessionId);
        if (isErr(sessionResult)) {
          return createErr({
            type: 'PLANNING_ERROR',
            message: `Failed to load session: ${sessionResult.err.message}`,
            cause: sessionResult.err,
          });
        }

        const session = sessionResult.val;
        const currentIteration = session.continueIterationCount ?? 0;

        console.log(`\n📊 Iteration ${currentIteration + 1}/${maxIterations}`);

        // 既存のタスクを収集
        const existingTaskIds = session.generatedTasks.map((t: { id: string }) => t.id);
        allTaskIds.push(...existingTaskIds);

        // 3. 既に完了している場合はチェック
        if (session.finalJudgement?.isComplete) {
          console.log('✅ Session already complete');
          return createOk({
            isComplete: true,
            iterationsPerformed,
            completionScore: session.finalJudgement.completionScore,
            remainingMissingAspects: [],
            allTaskIds,
            completedTaskIds: allCompletedTaskIds,
            failedTaskIds: allFailedTaskIds,
          });
        }

        // 4. 最終判定を実行して現在の状態を確認
        console.log('🎯 Evaluating current completion status...');

        const completedTaskDescriptions: string[] = [];
        const failedTaskDescriptions: string[] = [];

        for (const rawTaskId of existingTaskIds) {
          const taskResult = await deps.taskStore.readTask(taskId(rawTaskId));
          if (taskResult.ok) {
            const task = taskResult.val;
            const description = `[${rawTaskId}] ${task.acceptance || task.branch}`;

            if (task.state === TaskState.DONE) {
              completedTaskDescriptions.push(description);
              if (!allCompletedTaskIds.includes(rawTaskId)) {
                allCompletedTaskIds.push(rawTaskId);
              }
            } else if (task.state === TaskState.BLOCKED || task.state === TaskState.CANCELLED) {
              failedTaskDescriptions.push(description);
              if (!allFailedTaskIds.includes(rawTaskId)) {
                allFailedTaskIds.push(rawTaskId);
              }
            }
          }
        }

        const currentJudgement = await plannerOps.judgeFinalCompletion(
          session.instruction,
          completedTaskDescriptions,
          failedTaskDescriptions,
        );

        console.log(`   Completion score: ${currentJudgement.completionScore ?? 'N/A'}%`);
        console.log(`   Complete: ${currentJudgement.isComplete ? 'Yes' : 'No'}`);

        if (currentJudgement.isComplete) {
          console.log('✅ Current tasks satisfy the original instruction');

          // セッションを更新
          session.finalJudgement = {
            isComplete: true,
            missingAspects: [],
            additionalTaskSuggestions: [],
            completionScore: currentJudgement.completionScore,
            evaluatedAt: new Date().toISOString(),
          };
          await deps.sessionEffects.saveSession(session);

          return createOk({
            isComplete: true,
            iterationsPerformed,
            completionScore: currentJudgement.completionScore,
            remainingMissingAspects: [],
            allTaskIds,
            completedTaskIds: allCompletedTaskIds,
            failedTaskIds: allFailedTaskIds,
          });
        }

        // 5. 未完了の側面を表示
        if (currentJudgement.missingAspects.length > 0) {
          console.log('   Missing aspects:');
          currentJudgement.missingAspects.forEach((aspect, idx) => {
            console.log(`     ${idx + 1}. ${aspect}`);
          });
        }

        if (currentJudgement.additionalTaskSuggestions.length > 0) {
          console.log('   Suggested additional tasks:');
          currentJudgement.additionalTaskSuggestions.forEach((suggestion, idx) => {
            console.log(`     ${idx + 1}. ${suggestion}`);
          });
        }

        // 6. ドライランの場合はここで終了
        if (options.dryRun) {
          console.log('\n🔍 Dry-run mode: stopping before generating additional tasks');
          return createOk({
            isComplete: false,
            iterationsPerformed,
            completionScore: currentJudgement.completionScore,
            remainingMissingAspects: currentJudgement.missingAspects,
            allTaskIds,
            completedTaskIds: allCompletedTaskIds,
            failedTaskIds: allFailedTaskIds,
          });
        }

        // 7. ユーザー確認（autoConfirm=falseの場合）
        if (!options.autoConfirm) {
          // TODO: 実際の確認プロンプトを実装
          // 今は自動的に続行
          console.log('   [Auto-proceeding without confirmation]');
        }

        // 8. 追加タスクを生成
        console.log('\n🔍 Generating additional tasks...');
        const additionalPlanningResult = await plannerOps.planAdditionalTasks(
          sessionId,
          currentJudgement.missingAspects,
        );

        if (isErr(additionalPlanningResult)) {
          console.warn(
            `⚠️  Failed to generate additional tasks: ${additionalPlanningResult.err.message}`,
          );

          // セッションを更新（判定結果のみ）
          session.finalJudgement = {
            isComplete: false,
            missingAspects: currentJudgement.missingAspects,
            additionalTaskSuggestions: currentJudgement.additionalTaskSuggestions,
            completionScore: currentJudgement.completionScore,
            evaluatedAt: new Date().toISOString(),
          };
          session.continueIterationCount = currentIteration + 1;
          await deps.sessionEffects.saveSession(session);

          return createErr({
            type: 'PLANNING_ERROR',
            message: `Failed to generate additional tasks: ${additionalPlanningResult.err.message}`,
            cause: additionalPlanningResult.err,
          });
        }

        const { taskIds: newTaskIds } = additionalPlanningResult.val;
        console.log(`📋 Generated ${newTaskIds.length} additional tasks`);

        if (newTaskIds.length === 0) {
          console.log('⚠️  No additional tasks generated, stopping');

          // セッションを更新
          session.finalJudgement = {
            isComplete: false,
            missingAspects: currentJudgement.missingAspects,
            additionalTaskSuggestions: currentJudgement.additionalTaskSuggestions,
            completionScore: currentJudgement.completionScore,
            evaluatedAt: new Date().toISOString(),
          };
          session.continueIterationCount = currentIteration + 1;
          await deps.sessionEffects.saveSession(session);

          return createOk({
            isComplete: false,
            iterationsPerformed: currentIteration + 1,
            completionScore: currentJudgement.completionScore,
            remainingMissingAspects: currentJudgement.missingAspects,
            allTaskIds,
            completedTaskIds: allCompletedTaskIds,
            failedTaskIds: allFailedTaskIds,
          });
        }

        allTaskIds.push(...newTaskIds);

        // 9. 新しいタスクを実行（既存の実行ロジックを再利用）
        console.log('\n🚀 Executing additional tasks...');

        const tasks: Task[] = [];
        for (const rawTaskId of newTaskIds) {
          const taskResult = await deps.taskStore.readTask(taskId(rawTaskId));
          if (!taskResult.ok) {
            console.warn(`⚠️  Failed to load task ${rawTaskId}: ${taskResult.err.message}`);
            allFailedTaskIds.push(rawTaskId);
            continue;
          }
          tasks.push(taskResult.val);
        }

        // 依存関係グラフを構築して実行
        const graph = buildDependencyGraph(tasks);
        const serialChains = detectSerialChains(graph);
        const serialTaskIds = new Set<string>();
        for (const chain of serialChains) {
          for (const tid of chain) {
            serialTaskIds.add(String(tid));
          }
        }

        const parallelTasks = tasks.filter((task) => !serialTaskIds.has(String(task.id)));
        const parallelGraph =
          parallelTasks.length > 0 ? buildDependencyGraph(parallelTasks, graph.allTaskIds) : null;

        let schedulerState = initialSchedulerState(deps.maxWorkers ?? 3);
        const blockedTaskIds = new Set(graph.cyclicDependencies ?? []);

        // 直列チェーンを実行
        const continueSerialChainFailedTasks: TaskId[] = [];
        if (serialChains.length > 0) {
          for (const chain of serialChains) {
            const result = await executeSerialChain(
              chain,
              deps.taskStore,
              schedulerOps,
              workerOps,
              judgeOps,
              schedulerState,
              deps.config.iterations.serialChainTaskRetries,
            );
            schedulerState = result.updatedSchedulerState;

            allCompletedTaskIds.push(...result.completed.map((id) => String(id)));
            allFailedTaskIds.push(...result.failed.map((id) => String(id)));
            continueSerialChainFailedTasks.push(...result.failed);

            if (result.worktreePath && chain[0]) {
              await workerOps.cleanupWorktree(chain[0]);
            }
          }

          // Serial chainで失敗したタスクの依存先を自動的にブロック
          if (continueSerialChainFailedTasks.length > 0) {
            const dependentTasks = computeBlockedTasks(continueSerialChainFailedTasks, graph);
            if (dependentTasks.length > 0) {
              console.log(
                `  ⚠️  Blocking ${dependentTasks.length} dependent tasks due to serial chain failures: ${dependentTasks.map((id) => String(id)).join(', ')}`,
              );
              for (const tid of dependentTasks) {
                blockedTaskIds.add(tid);
                await schedulerOps.blockTask(tid);
                allFailedTaskIds.push(String(tid));
              }
            }
          }
        }

        // 並列タスクを動的スケジューリングで実行
        if (parallelTasks.length > 0) {
          console.log(`\n📍 Executing parallel tasks with dynamic scheduling...`);

          const dynamicResult = await executeDynamically(
            parallelTasks.map((t) => t.id),
            parallelGraph!,
            schedulerOps,
            workerOps,
            judgeOps,
            deps.taskStore,
            deps.maxWorkers ?? 3,
            schedulerState,
            blockedTaskIds,
          );

          schedulerState = dynamicResult.updatedSchedulerState;
          allCompletedTaskIds.push(...dynamicResult.completed.map((id) => String(id)));
          allFailedTaskIds.push(...dynamicResult.failed.map((id) => String(id)));
          allFailedTaskIds.push(...dynamicResult.blocked.map((id) => String(id)));

          console.log(
            `  ✅ Dynamic execution completed: ${dynamicResult.completed.length} succeeded, ${dynamicResult.failed.length} failed, ${dynamicResult.blocked.length} blocked`,
          );
        }

        console.log(
          `✅ Additional tasks executed: ${allCompletedTaskIds.length} completed, ${allFailedTaskIds.length} failed`,
        );

        // 10. セッションを更新（反復カウント、判定結果）
        session.continueIterationCount = currentIteration + 1;
        await deps.sessionEffects.saveSession(session);

        iterationsPerformed = currentIteration + 1;
      }

      // 反復上限に達した
      console.log(`\n⚠️  Reached maximum iteration limit (${maxIterations})`);

      // 最終状態を再評価
      const sessionResult = await deps.sessionEffects.loadSession(sessionId);
      if (!isErr(sessionResult)) {
        const session = sessionResult.val;

        return createOk({
          isComplete: session.finalJudgement?.isComplete ?? false,
          iterationsPerformed,
          completionScore: session.finalJudgement?.completionScore,
          remainingMissingAspects: session.finalJudgement?.missingAspects ?? [],
          allTaskIds,
          completedTaskIds: allCompletedTaskIds,
          failedTaskIds: allFailedTaskIds,
        });
      }

      return createOk({
        isComplete: false,
        iterationsPerformed,
        remainingMissingAspects: [],
        allTaskIds,
        completedTaskIds: allCompletedTaskIds,
        failedTaskIds: allFailedTaskIds,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ Continue from session error: ${errorMessage}`);

      return createErr({
        type: 'UNKNOWN_ERROR',
        message: errorMessage,
        cause: error,
      });
    }
  };

  return {
    executeInstruction,
    resumeFromSession,
    continueFromSession,
  };
};

/**
 * Orchestrator操作型
 */
export type OrchestratorOperations = ReturnType<typeof createOrchestrator>;
