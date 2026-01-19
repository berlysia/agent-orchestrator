/**
 * Integration Operations
 *
 * 並列実行されたタスクの変更を統合し、マージ時のコンフリクトを検出・解決する機能。
 */

import type { Result } from 'option-t/plain_result';
import { createOk, createErr, isErr } from 'option-t/plain_result';
import type { Task } from '../../types/task.ts';
import { createInitialTask } from '../../types/task.ts';
import type { BranchName, TaskId } from '../../types/branded.ts';
import { branchName, taskId, repoPath } from '../../types/branded.ts';
import type {
  IntegrationResult,
  IntegrationFinalResult,
  MergeDetail,
  ConflictResolutionInfo,
} from '../../types/integration.ts';
import type { GitEffects } from '../../adapters/vcs/git-effects.ts';
import type { TaskStore } from '../task-store/interface.ts';
import type { OrchestratorError } from '../../types/errors.ts';
import { ioError } from '../../types/errors.ts';
import { randomUUID } from 'node:crypto';

/**
 * Integration依存関係
 */
export interface IntegrationDeps {
  readonly taskStore: TaskStore;
  readonly gitEffects: GitEffects;
  readonly appRepoPath: string;
}

/**
 * 統合設定
 */
export interface IntegrationConfig {
  /** 統合方法: 'pr' | 'command' | 'auto' (default: 'auto') */
  readonly method: 'pr' | 'command' | 'auto';
}

/**
 * Integration操作を生成
 */
export const createIntegrationOperations = (deps: IntegrationDeps) => {
  const { taskStore, gitEffects, appRepoPath } = deps;

  /**
   * 複数タスクブランチを統合
   *
   * WHY: 並列実行されたタスクの変更を統合し、コンフリクトがあれば解決タスクを生成
   */
  const integrateTasks = async (
    completedTasks: Task[],
    baseBranch: BranchName,
  ): Promise<Result<IntegrationResult, OrchestratorError>> => {
    const repo = repoPath(appRepoPath);

    // 統合ブランチを作成
    const timestamp = Date.now();
    const integrationBranch = branchName(`integration/merge-${timestamp}`);

    const createBranchResult = await gitEffects.createBranch(repo, integrationBranch, baseBranch);
    if (isErr(createBranchResult)) {
      return createErr(createBranchResult.err);
    }

    // 統合ブランチに切り替え
    const switchResult = await gitEffects.switchBranch(repo, integrationBranch);
    if (isErr(switchResult)) {
      return createErr(switchResult.err);
    }

    const integratedTaskIds: TaskId[] = [];
    const conflictedTaskIds: TaskId[] = [];
    const mergeDetails: MergeDetail[] = [];
    const failedMerges: Array<{ taskId: TaskId; sourceBranch: BranchName; conflicts: any[] }> = [];

    // 各タスクのブランチを順番にマージ
    for (const task of completedTasks) {
      const mergeResult = await gitEffects.merge(repo, task.branch);

      if (isErr(mergeResult)) {
        // マージエラー
        conflictedTaskIds.push(task.id);
        mergeDetails.push({
          taskId: task.id,
          sourceBranch: task.branch,
          targetBranch: integrationBranch,
          result: {
            success: false,
            mergedFiles: [],
            hasConflicts: false,
            conflicts: [],
            status: 'failed',
          },
        });
        continue;
      }

      const merge = mergeResult.val;

      if (merge.hasConflicts) {
        // コンフリクトが発生
        conflictedTaskIds.push(task.id);
        failedMerges.push({
          taskId: task.id,
          sourceBranch: task.branch,
          conflicts: merge.conflicts,
        });

        // マージをアボート
        await gitEffects.abortMerge(repo);

        mergeDetails.push({
          taskId: task.id,
          sourceBranch: task.branch,
          targetBranch: integrationBranch,
          result: merge,
        });
      } else {
        // マージ成功
        integratedTaskIds.push(task.id);
        mergeDetails.push({
          taskId: task.id,
          sourceBranch: task.branch,
          targetBranch: integrationBranch,
          result: merge,
        });
      }
    }

    // コンフリクト解決タスクを生成（必要な場合）
    let conflictResolutionTaskId: TaskId | null = null;

    if (conflictedTaskIds.length > 0) {
      const resolutionTaskResult = await createConflictResolutionTask(
        conflictedTaskIds,
        failedMerges,
        integrationBranch,
      );

      if (!isErr(resolutionTaskResult)) {
        conflictResolutionTaskId = resolutionTaskResult.val.id;
      }
    }

    const result: IntegrationResult = {
      success: conflictedTaskIds.length === 0,
      integratedTaskIds,
      conflictedTaskIds,
      integrationBranch,
      conflictResolutionTaskId,
      mergeDetails,
    };

    return createOk(result);
  };

  /**
   * コンフリクト解決タスクを生成
   *
   * WHY: コンフリクトが発生したタスクをまとめて解決するための専用タスクを作成
   */
  const createConflictResolutionTask = async (
    _conflictedTaskIds: TaskId[],
    failedMerges: Array<{ taskId: TaskId; sourceBranch: BranchName; conflicts: any[] }>,
    integrationBranch: BranchName,
  ): Promise<Result<Task, OrchestratorError>> => {
    // コンフリクト詳細を収集
    const conflictDetails: ConflictResolutionInfo[] = [];

    for (const failed of failedMerges) {
      const detailResult = await collectConflictDetails(
        failed.taskId,
        failed.sourceBranch,
        integrationBranch,
      );

      if (!isErr(detailResult)) {
        conflictDetails.push(detailResult.val);
      }
    }

    // コンフリクト解決プロンプトを構築
    const prompt = await buildConflictResolutionPrompt(conflictDetails);

    // 解決タスクを作成
    const resolutionTaskId = taskId(`conflict-resolution-${randomUUID()}`);
    const resolutionTask = createInitialTask({
      id: resolutionTaskId,
      repo: repoPath(appRepoPath),
      branch: integrationBranch,
      scopePaths: conflictDetails.flatMap((c) => c.conflicts.map((cf) => cf.filePath)),
      acceptance: 'All merge conflicts are resolved and changes are successfully integrated',
      taskType: 'integration',
      context: prompt,
    });

    // タスクストアに保存
    const saveResult = await taskStore.createTask(resolutionTask);
    if (isErr(saveResult)) {
      return createErr(saveResult.err);
    }

    return createOk(resolutionTask);
  };

  /**
   * コンフリクト解決プロンプトを構築
   *
   * WHY: 解決タスクにコンフリクトの詳細情報を提供し、自動解決を支援
   */
  const buildConflictResolutionPrompt = async (
    conflicts: ConflictResolutionInfo[],
  ): Promise<string> => {
    const lines: string[] = [
      '# Merge Conflict Resolution',
      '',
      'The following merge conflicts occurred during task integration:',
      '',
    ];

    for (const conflict of conflicts) {
      lines.push(`## Task: ${conflict.taskId}`);
      lines.push(`Branch: ${conflict.sourceBranch} -> ${conflict.targetBranch}`);
      lines.push('');
      lines.push('### Conflicted Files:');

      for (const file of conflict.conflicts) {
        lines.push(`- ${file.filePath} (${file.type})`);
        lines.push(`  Reason: ${file.reason}`);
      }

      lines.push('');

      // コンフリクト内容の詳細
      if (conflict.conflictContents.length > 0) {
        lines.push('### Conflict Details:');
        for (const content of conflict.conflictContents) {
          lines.push('');
          lines.push(`#### ${content.filePath}`);
          lines.push('');
          lines.push('**Ours (current branch):**');
          lines.push('```');
          lines.push(content.oursContent || '(empty)');
          lines.push('```');
          lines.push('');
          lines.push('**Theirs (merging branch):**');
          lines.push('```');
          lines.push(content.theirsContent || '(empty)');
          lines.push('```');
          lines.push('');
          if (content.baseContent) {
            lines.push('**Base (common ancestor):**');
            lines.push('```');
            lines.push(content.baseContent);
            lines.push('```');
            lines.push('');
          }
        }
      }
    }

    lines.push('');
    lines.push('## Resolution Instructions');
    lines.push('');
    lines.push('1. Review each conflict carefully and understand the intent of both changes');
    lines.push('2. Resolve conflicts by merging the changes appropriately');
    lines.push('3. Ensure all tests pass after resolution');
    lines.push('4. Stage and commit the resolved files');

    return lines.join('\n');
  };

  /**
   * コンフリクト詳細を収集
   *
   * WHY: コンフリクトの詳細内容を取得し、解決タスクに提供
   */
  const collectConflictDetails = async (
    taskId: TaskId,
    sourceBranch: BranchName,
    targetBranch: BranchName,
  ): Promise<Result<ConflictResolutionInfo, OrchestratorError>> => {
    const repo = repoPath(appRepoPath);

    // コンフリクトファイルを取得
    const conflictedFilesResult = await gitEffects.getConflictedFiles(repo);
    if (isErr(conflictedFilesResult)) {
      return createErr(conflictedFilesResult.err);
    }

    const conflictedFiles = conflictedFilesResult.val;
    const conflicts = conflictedFiles.map((filePath) => ({
      reason: 'merge conflict',
      filePath,
      type: 'content' as const,
    }));

    // 各ファイルのコンフリクト内容を取得
    const conflictContents = [];
    for (const filePath of conflictedFiles) {
      const contentResult = await gitEffects.getConflictContent(repo, filePath);
      if (!isErr(contentResult)) {
        conflictContents.push(contentResult.val);
      }
    }

    const info: ConflictResolutionInfo = {
      taskId,
      sourceBranch,
      targetBranch,
      conflicts,
      conflictContents,
    };

    return createOk(info);
  };

  /**
   * 統合ブランチの取り込み方法を決定し、結果を返す
   *
   * WHY: リモートの有無と設定に基づいて、PR作成またはコマンド出力を選択
   */
  const finalizeIntegration = async (
    integrationBranch: BranchName,
    baseBranch: BranchName,
    config: IntegrationConfig,
  ): Promise<Result<IntegrationFinalResult, OrchestratorError>> => {
    const repo = repoPath(appRepoPath);

    // リモートの有無を確認
    const hasRemoteResult = await gitEffects.hasRemote(repo, 'origin');
    if (isErr(hasRemoteResult)) {
      return createErr(hasRemoteResult.err);
    }

    const hasRemote = hasRemoteResult.val;

    // 設定に基づいて処理を分岐
    if (config.method === 'pr') {
      if (!hasRemote) {
        return createErr(
          ioError(
            'finalizeIntegration',
            new Error('PR creation requires a remote repository, but no remote found'),
          ),
        );
      }

      // PRを作成（TODO: GitHub CLI統合）
      // 現時点では未実装のため、エラーを返す
      return createErr(
        ioError('finalizeIntegration', new Error('PR creation is not yet implemented')),
      );
    } else if (config.method === 'command') {
      // コマンド出力
      const mergeCommand = `git checkout ${baseBranch} && git merge ${integrationBranch}`;
      return createOk({
        method: 'command',
        mergeCommand,
      });
    } else {
      // auto: リモートがあればPR、なければコマンド
      if (hasRemote) {
        // PRを作成（TODO: GitHub CLI統合）
        // 現時点では未実装のため、コマンド出力にフォールバック
        const mergeCommand = `git checkout ${baseBranch} && git merge ${integrationBranch}`;
        return createOk({
          method: 'command',
          mergeCommand,
        });
      } else {
        const mergeCommand = `git checkout ${baseBranch} && git merge ${integrationBranch}`;
        return createOk({
          method: 'command',
          mergeCommand,
        });
      }
    }
  };

  return {
    integrateTasks,
    createConflictResolutionTask,
    buildConflictResolutionPrompt,
    collectConflictDetails,
    finalizeIntegration,
  };
};
