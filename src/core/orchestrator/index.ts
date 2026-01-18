import type { TaskStore } from '../task-store/interface.ts';
import type { Runner, AgentType } from '../runner/index.ts';
import { Scheduler } from './scheduler.ts';
import { Planner } from './planner.ts';
import { Worker } from './worker.ts';
import { Judge } from './judge.ts';
import { taskId } from '../../types/branded.ts';

/**
 * Orchestratorのオプション
 */
export interface OrchestratorOptions {
  /** タスクストアインスタンス */
  taskStore: TaskStore;
  /** Runnerインスタンス */
  runner: Runner;
  /** 使用するエージェント種別 */
  agentType: AgentType;
  /** アプリケーションリポジトリのパス */
  appRepoPath: string;
  /** 最大Worker並列数（デフォルト: 3） */
  maxWorkers?: number;
}

/**
 * Orchestrator実行結果
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
 * Orchestrator - Planner/Worker/Judgeの統合管理
 *
 * ユーザー指示を受け取り、Planner→Worker→Judgeのサイクルを実行
 */
export class Orchestrator {
  private scheduler: Scheduler;
  private planner: Planner;
  private worker: Worker;
  private judge: Judge;

  constructor(options: OrchestratorOptions) {

    this.scheduler = new Scheduler({
      taskStore: options.taskStore,
      maxWorkers: options.maxWorkers,
    });

    this.planner = new Planner({
      taskStore: options.taskStore,
      runner: options.runner,
      agentType: options.agentType,
      appRepoPath: options.appRepoPath,
    });

    this.worker = new Worker({
      taskStore: options.taskStore,
      runner: options.runner,
      agentType: options.agentType,
      appRepoPath: options.appRepoPath,
    });

    this.judge = new Judge({
      taskStore: options.taskStore,
    });
  }

  /**
   * ユーザー指示を実行
   *
   * 1. Planner: タスク分解
   * 2. Scheduler: タスク割り当て
   * 3. Worker: タスク実行
   * 4. Judge: 完了判定
   *
   * @param userInstruction ユーザーの指示
   * @returns 実行結果
   */
  async executeInstruction(userInstruction: string): Promise<OrchestrationResult> {
    const completedTaskIds: string[] = [];
    const failedTaskIds: string[] = [];

    try {
      // 1. Planner: タスク分解
      console.log('🔍 Planning tasks...');
      const planningResult = await this.planner.planTasks(userInstruction);
      console.log(`📋 Generated ${planningResult.taskIds.length} tasks`);

      // 2-4. 各タスクを順次実行（Scheduler→Worker→Judge）
      for (const rawTaskId of planningResult.taskIds) {
        console.log(`\n🔨 Processing task: ${rawTaskId}`);

        // 2. Scheduler: タスク割り当て
        const workerId = `worker-${rawTaskId}`;
        const claimedTask = await this.scheduler.claimTask(rawTaskId, workerId);

        if (!claimedTask) {
          console.log(`⚠️  Failed to claim task: ${rawTaskId}`);
          failedTaskIds.push(rawTaskId);
          continue;
        }

        const tid = taskId(rawTaskId);

        try {
          // 3. Worker: タスク実行
          console.log(`  🚀 Executing task...`);
          const workerResult = await this.worker.executeTask(claimedTask);

          if (!workerResult.success) {
            console.log(`  ❌ Task execution failed: ${workerResult.error}`);
            await this.scheduler.blockTask(tid);
            failedTaskIds.push(rawTaskId);
            continue;
          }

          // 4. Judge: 完了判定
          console.log(`  ⚖️  Judging task...`);
          const judgement = await this.judge.judgeTask(tid);

          if (judgement.success) {
            console.log(`  ✅ Task completed: ${judgement.reason}`);
            await this.judge.markTaskAsCompleted(tid);
            completedTaskIds.push(rawTaskId);
          } else {
            console.log(`  ❌ Task failed judgement: ${judgement.reason}`);
            await this.judge.markTaskAsBlocked(tid);
            failedTaskIds.push(rawTaskId);
          }
        } finally {
          // Worktreeをクリーンアップ
          await this.worker.cleanupWorktree(rawTaskId);
        }
      }

      const success = failedTaskIds.length === 0;
      console.log(`\n${success ? '🎉' : '⚠️ '} Orchestration ${success ? 'completed' : 'finished with errors'}`);
      console.log(`  Completed: ${completedTaskIds.length}`);
      console.log(`  Failed: ${failedTaskIds.length}`);

      return {
        taskIds: planningResult.taskIds,
        completedTaskIds,
        failedTaskIds,
        success,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ Orchestration error: ${errorMessage}`);

      return {
        taskIds: [],
        completedTaskIds,
        failedTaskIds,
        success: false,
      };
    }
  }
}

// Re-export components
export { Scheduler } from './scheduler.ts';
export { Planner } from './planner.ts';
export { Worker } from './worker.ts';
export { Judge } from './judge.ts';
