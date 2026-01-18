import type { TaskStore } from '../task-store/interface.ts';
import type { Runner, AgentType } from '../runner/index.ts';
import { createInitialTask } from '../../types/task.ts';
import { randomUUID } from 'node:crypto';

/**
 * Plannerのオプション
 */
export interface PlannerOptions {
  /** タスクストアインスタンス */
  taskStore: TaskStore;
  /** Runnerインスタンス */
  runner: Runner;
  /** 使用するエージェント種別 */
  agentType: AgentType;
  /** アプリケーションリポジトリのパス */
  appRepoPath: string;
}

/**
 * タスク分解結果
 */
export interface PlanningResult {
  /** 生成されたタスクIDの配列 */
  taskIds: string[];
  /** 実行ログ */
  runId: string;
}

/**
 * タスク分解情報（エージェントが返すべき形式）
 */
interface TaskBreakdown {
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
 * Planner - タスク分解を担当
 *
 * ユーザーの指示を受け取り、実装タスクに分解してTaskStoreに保存
 */
export class Planner {
  private taskStore: TaskStore;
  private appRepoPath: string;

  // TODO: 実際のエージェント統合時に使用
  // private runner: Runner;
  // private agentType: AgentType;

  constructor(options: PlannerOptions) {
    this.taskStore = options.taskStore;
    this.appRepoPath = options.appRepoPath;

    // TODO: 実際のエージェント統合時に使用
    // this.runner = options.runner;
    // this.agentType = options.agentType;
  }

  /**
   * ユーザー指示からタスクを分解
   *
   * @param userInstruction ユーザーの指示（例: "TODOアプリを作る"）
   * @returns タスク分解結果
   */
  async planTasks(userInstruction: string): Promise<PlanningResult> {
    // TODO: 実際のエージェント実行を統合
    // 現時点では簡易的にダミーのタスク分解を使用

    const plannerTaskId = `planner-${randomUUID()}`;

    // TODO: エージェント実行
    // const plannerTask = createInitialTask({
    //   id: plannerTaskId,
    //   repo: this.appRepoPath,
    //   branch: 'main',
    //   scopePaths: ['.'],
    //   acceptance: `Plan tasks for: ${userInstruction}`,
    // });
    // const result = await this.runner.runTask(this.agentType, plannerTask, this.appRepoPath);

    // 現時点ではダミーのタスク分解を使用
    const taskBreakdowns = this.createDummyTaskBreakdown(userInstruction);

    // タスクをTaskStoreに保存
    const taskIds: string[] = [];
    for (const breakdown of taskBreakdowns) {
      const taskId = `task-${randomUUID()}`;
      const task = createInitialTask({
        id: taskId,
        repo: this.appRepoPath,
        branch: breakdown.branch,
        scopePaths: breakdown.scopePaths,
        acceptance: breakdown.acceptance,
      });

      await this.taskStore.createTask(task);
      taskIds.push(taskId);
    }

    return {
      taskIds,
      runId: plannerTaskId, // 現時点ではplannerTaskIdを返す
    };
  }

  /**
   * ダミーのタスク分解を生成（開発用）
   *
   * @param userInstruction ユーザー指示
   * @returns タスク分解情報の配列
   */
  private createDummyTaskBreakdown(userInstruction: string): TaskBreakdown[] {
    // TODO: 実際のエージェント統合時に削除
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
  // private buildPlanningPrompt(userInstruction: string): string { ... }
  // private parseAgentOutput(output: string): TaskBreakdown[] { ... }
}
