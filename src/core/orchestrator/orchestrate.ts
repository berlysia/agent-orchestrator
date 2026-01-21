import type { TaskStore } from '../task-store/interface.ts';
import type { GitEffects } from '../../adapters/vcs/git-effects.ts';
import type { RunnerEffects } from '../runner/runner-effects.ts';
import type { Config } from '../../types/config.ts';
import { createSchedulerOperations } from './scheduler-operations.ts';
import { createPlannerOperations } from './planner-operations.ts';
import { createWorkerOperations, type WorkerDeps } from './worker-operations.ts';
import { createJudgeOperations } from './judge-operations.ts';
import { createBaseBranchResolver } from './base-branch-resolver.ts';
import { createIntegrationOperations } from './integration-operations.ts';
import { initialSchedulerState } from './scheduler-state.ts';
import { taskId, repoPath, branchName } from '../../types/branded.ts';
import { getAgentType, getModel } from '../config/models.ts';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr, isErr } from 'option-t/plain_result';
import type { Task } from '../../types/task.ts';
import { TaskState } from '../../types/task.ts';
import type { PlannerSessionEffects } from './planner-session-effects.ts';
import type { IntegrationWorktreeInfo } from '../../types/integration.ts';
import {
  loadTasks,
  collectCompletedTaskSummaries,
  collectFailedTaskDescriptions,
} from './task-helpers.ts';
import { executeTaskPipeline } from './task-execution-pipeline.ts';
import { truncateSummary } from './utils/log-utils.ts';

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
    config: deps.config,
  };
  const workerOps = createWorkerOperations(workerDeps);
  const judgeOps = createJudgeOperations({
    taskStore: deps.taskStore,
    runnerEffects: deps.runnerEffects,
    appRepoPath: deps.config.appRepoPath,
    agentType: getAgentType(deps.config, 'judge'),
    model: getModel(deps.config, 'judge'),
    judgeTaskRetries: deps.config.iterations.judgeTaskRetries,
  });
  const baseBranchResolver = createBaseBranchResolver({
    gitEffects: deps.gitEffects,
    taskStore: deps.taskStore,
    appRepoPath: repoPath(deps.config.appRepoPath),
  });
  const integrationOps = createIntegrationOperations({
    taskStore: deps.taskStore,
    gitEffects: deps.gitEffects,
    appRepoPath: deps.config.appRepoPath,
    config: deps.config,
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

      // 2. すべてのタスクを取得
      const loadResult = await loadTasks(taskIds, deps.taskStore);
      const tasks = loadResult.tasks;
      failedTaskIds.push(...loadResult.failedTaskIds);

      // 生成されたタスクを表示
      console.log(`📋 Generated ${tasks.length} tasks`);
      if (tasks.length > 0) {
        for (const task of tasks) {
          const summaryText = task.summary ? ` - ${truncateSummary(task.summary)}` : '';
          console.log(`  - ${task.id}${summaryText}`);
        }
      }

      // 3. タスク実行パイプライン
      const pipelineResult = await executeTaskPipeline({
        tasks,
        taskStore: deps.taskStore,
        schedulerOps,
        workerOps,
        judgeOps,
        gitEffects: deps.gitEffects,
        baseBranchResolver,
        config: deps.config,
        maxWorkers: deps.maxWorkers ?? 3,
        initialSchedulerState: schedulerState,
        runnerEffects: deps.runnerEffects,
        sessionEffects: deps.sessionEffects,
        appRepoPath: deps.config.appRepoPath,
        coordRepoPath: deps.config.agentCoordPath,
        plannerAgentType: deps.config.agents.planner.type,
        plannerModel: deps.config.agents.planner.model,
        judgeModel: deps.config.agents.judge.model,
      });

      schedulerState = pipelineResult.schedulerState;
      completedTaskIds.push(...pipelineResult.completedTaskIds);
      failedTaskIds.push(...pipelineResult.failedTaskIds);
      blockedTaskIds.push(...pipelineResult.blockedTaskIds);

      // 9. 統合後評価フェーズ
      if (completedTaskIds.length > 0 || failedTaskIds.length > 0) {
        console.log('\n🎯 Integration and final completion evaluation...');

        // ベースブランチを取得
        const repo = repoPath(deps.config.appRepoPath);
        const currentBranchResult = await deps.gitEffects.getCurrentBranch(repo);
        const baseBranch = currentBranchResult.ok ? currentBranchResult.val : branchName('main');

        // 完了タスクを取得
        const completedTasks: Task[] = [];
        for (const rawTaskId of completedTaskIds) {
          const taskResult = await deps.taskStore.readTask(taskId(rawTaskId));
          if (taskResult.ok && taskResult.val.state === TaskState.DONE) {
            completedTasks.push(taskResult.val);
          }
        }

        // 完了タスクのサマリ収集
        const completedSummary = await collectCompletedTaskSummaries(
          completedTaskIds,
          deps.taskStore,
          deps.runnerEffects,
        );
        const completedTaskDescriptions = completedSummary.descriptions;
        const completedTaskRunSummaries = completedSummary.runSummaries;

        // 失敗タスクの説明収集
        const failedTaskDescriptions = await collectFailedTaskDescriptions(
          failedTaskIds,
          deps.taskStore,
        );

        let codeChanges = '';
        let integrationWorktreeInfo: IntegrationWorktreeInfo | null = null;

        // WHY: 統合後評価を有効化している場合、統合worktree上でコード差分を取得して評価する
        if (deps.config.integration.postIntegrationEvaluation && completedTasks.length > 1) {
          console.log('  📦 Creating integration worktree...');

          // 統合worktreeを作成
          const worktreeResult = await integrationOps.createIntegrationWorktree(baseBranch);
          if (isErr(worktreeResult)) {
            console.warn(
              `  ⚠️  Failed to create integration worktree: ${worktreeResult.err.message}`,
            );
            console.warn('  Falling back to regular evaluation without integration...');
          } else {
            const worktreeInfo = worktreeResult.val;
            integrationWorktreeInfo = worktreeInfo; // Phase 5: 追加タスクループで再利用するため保持

            console.log(`  ✅ Integration worktree created: ${worktreeInfo.worktreePath}`);
            console.log(`  🔗 Merging ${completedTasks.length} tasks...`);

            // 完了タスクを統合worktreeにマージ
            const mergeResult = await integrationOps.mergeTasksInWorktree(
              worktreeInfo,
              completedTasks,
            );

            if (isErr(mergeResult)) {
              console.warn(`  ⚠️  Failed to merge tasks: ${mergeResult.err.message}`);
            } else {
              const merge = mergeResult.val;
              console.log(
                `  ✅ Merged ${merge.mergedTaskIds.length}/${completedTasks.length} tasks`,
              );

              if (merge.conflictedTaskIds.length > 0) {
                console.log(`  ⚠️  ${merge.conflictedTaskIds.length} tasks have conflicts`);
                merge.conflictedTaskIds.forEach((tid) => {
                  console.log(`    - ${tid}`);
                });

                if (merge.conflictResolutionTaskId) {
                  console.log(
                    `  💡 Conflict resolution task created: ${merge.conflictResolutionTaskId}`,
                  );
                }
              }

              // 統合worktree上でコード差分を取得
              const diffResult = await integrationOps.getIntegrationDiff(
                worktreeInfo,
                baseBranch,
              );
              if (diffResult.ok) {
                codeChanges = diffResult.val;
              }
            }

            // Phase 5: クリーンアップは追加タスクループ完了後に移動
          }
        } else {
          // 統合後評価が無効、または単一タスクの場合は通常のdiff取得
          const diffResult = await deps.gitEffects.getDiff(repo, ['--stat', String(baseBranch)]);
          codeChanges = diffResult.ok ? diffResult.val : '';
        }

        // 最終判定を実行（統合後のコード差分を含む）
        console.log('  📊 Evaluating completion...');
        let finalJudgement = await plannerOps.judgeFinalCompletionWithContext(
          userInstruction,
          completedTasks,
          completedTaskDescriptions,
          failedTaskDescriptions,
          completedTaskRunSummaries,
          codeChanges,
        );

        // Phase 5: 追加タスクループ（統合後評価が不完全な場合に自動実行）
        let iterationsPerformed = 0;
        const maxIterations = deps.config.integration.maxAdditionalTaskIterations;

        // WHY: 統合worktreeが存在し、評価が不完全な場合のみループを実行
        while (
          integrationWorktreeInfo &&
          !finalJudgement.isComplete &&
          finalJudgement.missingAspects.length > 0 &&
          iterationsPerformed < maxIterations
        ) {
          iterationsPerformed++;
          console.log(
            `\n🔄 Starting additional task iteration ${iterationsPerformed}/${maxIterations}...`,
          );

          // 追加タスクを生成
          console.log('  📝 Planning additional tasks...');
          const additionalTasksResult = await plannerOps.planAdditionalTasks(
            sessionId,
            finalJudgement.missingAspects,
          );

          if (isErr(additionalTasksResult)) {
            console.error(
              `  ❌ Failed to plan additional tasks: ${additionalTasksResult.err.message}`,
            );
            break;
          }

          const additionalTaskIds = additionalTasksResult.val.taskIds;

          // WHY: Phase 2 - 再実行タスクと新規タスクを区別してログ表示
          //      planAdditionalTasks は再実行タスクIDと新規タスクIDの両方を返す
          const allTasks = await loadTasks(additionalTaskIds, deps.taskStore);
          const retryTaskIds = allTasks.tasks.filter(t => t.integrationRetried).map(t => String(t.id));
          const newTaskIds = allTasks.tasks.filter(t => !t.integrationRetried).map(t => String(t.id));

          console.log(`  ✅ Generated ${additionalTaskIds.length} tasks (${retryTaskIds.length} retry, ${newTaskIds.length} new)`);

          if (retryTaskIds.length > 0) {
            console.log(`  🔄 Retry tasks from integration branch:`);
            for (const tid of retryTaskIds) {
              console.log(`    - ${tid}`);
            }
          }

          if (newTaskIds.length > 0) {
            console.log(`  ✨ New tasks:`);
            for (const tid of newTaskIds) {
              console.log(`    - ${tid}`);
            }
          }

          if (additionalTaskIds.length === 0) {
            console.log('  ⚠️  No additional tasks generated, stopping loop');
            break;
          }

          // 追加タスクを統合ブランチから実行
          console.log('  🔨 Executing additional tasks from integration branch...');

          // タスクを読み込み
          const additionalLoadResult = await loadTasks(additionalTaskIds, deps.taskStore);
          const additionalTasks = additionalLoadResult.tasks;

          // WHY: 統合ブランチから実行するため、カスタムBaseBranchResolverを作成
          const integrationBaseBranchResolver = {
            resolveBaseBranch: async (_task: Task) =>
              createOk({ type: 'single', baseBranch: integrationWorktreeInfo.integrationBranch }),
            // Phase 5の追加タスクはコンフリクト解決タスクを作成しないため、ダミー実装
            createAndStoreConflictResolutionTask: async (_parentTask: Task, _conflictInfo: any) =>
              createErr({ type: 'UNKNOWN_ERROR', message: 'Not implemented' } as any),
            buildConflictResolutionPrompt: (_parentTask: Task, _mergedBranches: any, _conflictDetails: any) => '',
          } as unknown as ReturnType<typeof createBaseBranchResolver>;

          // タスク実行パイプライン
          const additionalPipelineResult = await executeTaskPipeline({
            tasks: additionalTasks,
            taskStore: deps.taskStore,
            schedulerOps,
            workerOps,
            judgeOps,
            gitEffects: deps.gitEffects,
            baseBranchResolver: integrationBaseBranchResolver,
            config: deps.config,
            maxWorkers: deps.maxWorkers ?? 3,
            initialSchedulerState: initialSchedulerState(deps.maxWorkers ?? 3),
            runnerEffects: deps.runnerEffects,
            sessionEffects: deps.sessionEffects,
            appRepoPath: deps.config.appRepoPath,
            coordRepoPath: deps.config.agentCoordPath,
            plannerAgentType: deps.config.agents.planner.type,
            plannerModel: deps.config.agents.planner.model,
            judgeModel: deps.config.agents.judge.model,
          });

          const additionalCompletedIds = additionalPipelineResult.completedTaskIds;
          const additionalFailedIds = [
            ...additionalLoadResult.failedTaskIds,
            ...additionalPipelineResult.failedTaskIds,
            ...additionalPipelineResult.blockedTaskIds,
          ];

          console.log(
            `  ✅ Additional tasks executed: ${additionalCompletedIds.length} succeeded, ${additionalFailedIds.length} failed`,
          );

          // 完了した追加タスクを統合worktreeに再マージ
          if (additionalCompletedIds.length > 0) {
            console.log('  🔗 Merging additional tasks into integration worktree...');
            const additionalTasks: Task[] = [];
            for (const rawTaskId of additionalCompletedIds) {
              const taskResult = await deps.taskStore.readTask(taskId(rawTaskId));
              if (taskResult.ok && taskResult.val.state === TaskState.DONE) {
                additionalTasks.push(taskResult.val);
              }
            }

            const mergeResult = await integrationOps.mergeTasksInWorktree(
              integrationWorktreeInfo,
              additionalTasks,
            );

            if (isErr(mergeResult)) {
              console.warn(`  ⚠️  Failed to merge additional tasks: ${mergeResult.err.message}`);
            } else {
              const merge = mergeResult.val;
              console.log(
                `  ✅ Merged ${merge.mergedTaskIds.length}/${additionalTasks.length} additional tasks`,
              );

              if (merge.conflictedTaskIds.length > 0) {
                console.log(`  ⚠️  ${merge.conflictedTaskIds.length} tasks have conflicts`);
              }
            }

            // 再度コード差分を取得
            const diffResult = await integrationOps.getIntegrationDiff(
              integrationWorktreeInfo,
              baseBranch,
            );
            if (diffResult.ok) {
              codeChanges = diffResult.val;
            }
          }

          // タスクリストを累積
          completedTaskIds.push(...additionalCompletedIds);
          failedTaskIds.push(...additionalFailedIds);

          // 完了タスクオブジェクトを更新
          for (const rawTaskId of additionalCompletedIds) {
            const taskResult = await deps.taskStore.readTask(taskId(rawTaskId));
            if (taskResult.ok && taskResult.val.state === TaskState.DONE) {
              completedTasks.push(taskResult.val);
            }
          }

          // 完了タスクの説明とサマリーを更新
          const additionalCompletedSummary = await collectCompletedTaskSummaries(
            additionalCompletedIds,
            deps.taskStore,
            deps.runnerEffects,
          );
          completedTaskDescriptions.push(...additionalCompletedSummary.descriptions);
          completedTaskRunSummaries.push(...additionalCompletedSummary.runSummaries);

          // 失敗タスクの説明を更新
          const additionalFailedDescriptions = await collectFailedTaskDescriptions(
            additionalFailedIds,
            deps.taskStore,
          );
          failedTaskDescriptions.push(...additionalFailedDescriptions);

          // 再評価
          console.log('  📊 Re-evaluating completion...');
          finalJudgement = await plannerOps.judgeFinalCompletionWithContext(
            userInstruction,
            completedTasks,
            completedTaskDescriptions,
            failedTaskDescriptions,
            completedTaskRunSummaries,
            codeChanges,
          );

          if (finalJudgement.completionScore !== undefined) {
            console.log(`  Completion score: ${finalJudgement.completionScore}%`);
          }

          if (finalJudgement.isComplete) {
            console.log('  ✅ Original instruction fully satisfied after iteration');
            break;
          } else {
            console.log('  ⚠️  Still not complete, continuing loop...');
          }
        }

        // ループ終了後の結果表示
        if (finalJudgement.completionScore !== undefined) {
          console.log(`  Completion score: ${finalJudgement.completionScore}%`);
        }

        if (finalJudgement.isComplete) {
          console.log('  ✅ Original instruction fully satisfied');
          if (iterationsPerformed > 0) {
            console.log(`  🔄 Completed after ${iterationsPerformed} additional iteration(s)`);
          }
        } else {
          console.log('  ⚠️  Original instruction not fully satisfied');

          if (iterationsPerformed >= maxIterations) {
            console.log(
              `  ⚠️  Reached maximum iteration limit (${maxIterations}), stopping additional task loop`,
            );
          }

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

          if (!integrationWorktreeInfo) {
            // 統合worktreeが無効な場合のみ継続実行の提案
            console.log('\n  💡 Tip: Run the following command to generate additional tasks:');
            console.log(`\n     agent continue --session ${sessionId}\n`);
          }
        }

        // 統合worktreeのクリーンアップ（Phase 5実装完了）
        if (integrationWorktreeInfo) {
          console.log('  🧹 Cleaning up integration worktree...');
          const cleanupResult = await integrationOps.cleanupIntegrationWorktree(
            integrationWorktreeInfo,
          );
          if (isErr(cleanupResult)) {
            console.warn(
              `  ⚠️  Failed to cleanup integration worktree: ${cleanupResult.err.message}`,
            );
          }
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
      const loadResult = await loadTasks(taskIds, deps.taskStore);
      const tasks = loadResult.tasks;
      failedTaskIds.push(...loadResult.failedTaskIds);

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

      // 6. タスク実行パイプライン
      // WHY: 既にスキップ済みのタスクIDを初期ブロック対象として渡す
      const initialBlockedTaskIds = new Set(failedTaskIds.map((id) => taskId(id)));

      const pipelineResult = await executeTaskPipeline({
        tasks,
        taskStore: deps.taskStore,
        schedulerOps,
        workerOps,
        judgeOps,
        gitEffects: deps.gitEffects,
        baseBranchResolver,
        config: deps.config,
        maxWorkers: deps.maxWorkers ?? 3,
        initialSchedulerState: schedulerState,
        initialBlockedTaskIds,
        runnerEffects: deps.runnerEffects,
        sessionEffects: deps.sessionEffects,
        appRepoPath: deps.config.appRepoPath,
        coordRepoPath: deps.config.agentCoordPath,
        plannerAgentType: deps.config.agents.planner.type,
        plannerModel: deps.config.agents.planner.model,
        judgeModel: deps.config.agents.judge.model,
      });

      schedulerState = pipelineResult.schedulerState;
      completedTaskIds.push(...pipelineResult.completedTaskIds);
      failedTaskIds.push(...pipelineResult.failedTaskIds);
      blockedTaskIds.push(...pipelineResult.blockedTaskIds);

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

        // 9. 新しいタスクを実行
        console.log('\n🚀 Executing additional tasks...');

        const loadResult = await loadTasks(newTaskIds, deps.taskStore);
        const tasks = loadResult.tasks;
        allFailedTaskIds.push(...loadResult.failedTaskIds);

        // タスク実行パイプライン
        const pipelineResult = await executeTaskPipeline({
          tasks,
          taskStore: deps.taskStore,
          schedulerOps,
          workerOps,
          judgeOps,
          gitEffects: deps.gitEffects,
          baseBranchResolver,
          config: deps.config,
          maxWorkers: deps.maxWorkers ?? 3,
          initialSchedulerState: initialSchedulerState(deps.maxWorkers ?? 3),
          runnerEffects: deps.runnerEffects,
          sessionEffects: deps.sessionEffects,
          appRepoPath: deps.config.appRepoPath,
          coordRepoPath: deps.config.agentCoordPath,
          plannerAgentType: deps.config.agents.planner.type,
          plannerModel: deps.config.agents.planner.model,
          judgeModel: deps.config.agents.judge.model,
        });

        allCompletedTaskIds.push(...pipelineResult.completedTaskIds);
        allFailedTaskIds.push(...pipelineResult.failedTaskIds);
        allFailedTaskIds.push(...pipelineResult.blockedTaskIds);

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
