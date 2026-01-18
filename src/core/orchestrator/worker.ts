import type { TaskStore } from '../task-store/interface.ts';
import type { Runner, AgentType } from '../runner/index.ts';
import type { Task } from '../../types/task.ts';
import { WorktreeAdapter } from '../../adapters/vcs/worktree-adapter.ts';
import { GitAdapter } from '../../adapters/vcs/git-adapter.ts';

/**
 * Workerのオプション
 */
export interface WorkerOptions {
  /** タスクストアインスタンス */
  taskStore: TaskStore;
  /** Runnerインスタンス */
  runner: Runner;
  /** 使用するエージェント種別 */
  agentType: AgentType;
  /** アプリケーションリポジトリのパス */
  appRepoPath: string;
  /** Worktreeの基底ディレクトリ（デフォルト: <appRepoPath>/.git/worktree） */
  worktreeBaseDir?: string;
}

/**
 * Worker実行結果
 */
export interface WorkerResult {
  /** 実行ID */
  runId: string;
  /** 成功したか */
  success: boolean;
  /** エラーメッセージ（失敗時） */
  error?: string;
}

/**
 * Worker - タスク実装を担当
 *
 * タスクごとにworktreeを作成し、エージェントを実行して実装を行う
 */
export class Worker {
  private runner: Runner;
  private agentType: AgentType;
  private worktreeAdapter: WorktreeAdapter;
  private gitAdapter: GitAdapter;

  // TODO: 将来使用する可能性があるフィールド
  // private taskStore: TaskStore;
  // private appRepoPath: string;
  // private worktreeBaseDir: string;

  constructor(options: WorkerOptions) {
    this.runner = options.runner;
    this.agentType = options.agentType;

    this.worktreeAdapter = new WorktreeAdapter({ baseDir: options.appRepoPath });
    this.gitAdapter = new GitAdapter({ baseDir: options.appRepoPath });
  }

  /**
   * タスクを実行
   *
   * 1. worktreeを作成
   * 2. Workerエージェントを起動
   * 3. 変更をコミット
   * 4. リモートにpush
   *
   * @param task 実行するタスク
   * @returns 実行結果
   */
  async executeTask(task: Task): Promise<WorkerResult> {
    try {
      // 1. Worktreeを作成（パスが返される）
      const worktreePath = await this.createWorktreeForTask(task);

      // 2. Workerエージェントを起動
      const runResult = await this.runner.runTask(this.agentType, task, worktreePath);

      if (!runResult.success) {
        return {
          runId: runResult.runId,
          success: false,
          error: runResult.error ?? 'Agent execution failed',
        };
      }

      // 3. 変更をコミット
      await this.commitChanges(task, worktreePath);

      // 4. リモートにpush
      await this.pushChanges(task, worktreePath);

      return {
        runId: runResult.runId,
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        runId: `error-${task.id}`,
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * タスク用のworktreeを作成
   *
   * @param task タスク
   * @returns worktreeのパス
   */
  private async createWorktreeForTask(task: Task): Promise<string> {
    // ブランチが存在しない場合は作成
    const branches = await this.gitAdapter.listBranches();
    const branchExists = branches.all.includes(task.branch);

    // Worktreeを作成（createBranchフラグでブランチも同時作成）
    const worktreePath = await this.worktreeAdapter.createWorktree(
      task.id,
      task.branch,
      !branchExists,
    );

    return worktreePath;
  }

  /**
   * 変更をコミット
   *
   * @param task タスク
   * @param worktreePath worktreeのパス
   */
  private async commitChanges(task: Task, worktreePath: string): Promise<void> {
    const worktreeGit = new GitAdapter({ baseDir: worktreePath });

    // 変更をステージング
    await worktreeGit.addAll();

    // コミットメッセージを生成
    const commitMessage = this.generateCommitMessage(task);

    // コミット
    await worktreeGit.commit(commitMessage);
  }

  /**
   * リモートにpush
   *
   * @param task タスク
   * @param worktreePath worktreeのパス
   */
  private async pushChanges(task: Task, worktreePath: string): Promise<void> {
    const worktreeGit = new GitAdapter({ baseDir: worktreePath });

    // リモートにpush
    await worktreeGit.push('origin', task.branch);
  }

  /**
   * コミットメッセージを生成
   *
   * @param task タスク
   * @returns コミットメッセージ
   */
  private generateCommitMessage(task: Task): string {
    return `feat: ${task.acceptance}

Task ID: ${task.id}
Branch: ${task.branch}

🤖 Generated with Agent Orchestrator

Co-Authored-By: AI Agent <noreply@agent-orchestrator>`;
  }

  /**
   * Worktreeをクリーンアップ（削除）
   *
   * @param taskId タスクID
   */
  async cleanupWorktree(taskId: string): Promise<void> {
    try {
      await this.worktreeAdapter.removeWorktree(taskId);
    } catch (error) {
      console.warn(`Failed to cleanup worktree for task ${taskId}:`, error);
    }
  }
}
