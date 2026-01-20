/**
 * Base Branch Resolver
 *
 * タスクの依存関係に基づいてベースブランチを解決し、
 * 複数依存の場合は一時マージブランチを作成する。
 * コンフリクト発生時はコンフリクト解消タスクを生成する。
 */

import type { Result } from 'option-t/plain_result';
import { createOk, createErr, isErr } from 'option-t/plain_result';
import type { Task } from '../../types/task.ts';
import { createInitialTask } from '../../types/task.ts';
import type { BranchName, RepoPath } from '../../types/branded.ts';
import { branchName, taskId } from '../../types/branded.ts';
import type { OrchestratorError } from '../../types/errors.ts';
import { conflictResolutionRequired } from '../../types/errors.ts';
import type { GitEffects } from '../../adapters/vcs/git-effects.ts';
import type { TaskStore } from '../task-store/interface.ts';
import type { ConflictContent } from '../../types/integration.ts';
import { randomUUID } from 'node:crypto';

/**
 * ベースブランチ解決結果
 */
export interface BaseBranchResolution {
  /** ベースブランチ名（依存なしの場合はundefined） */
  baseBranch: BranchName | undefined;
  /** 一時ブランチかどうか */
  isTemporary: boolean;
  /** 一時ブランチ名（isTemporary=trueの場合のみ） */
  temporaryBranchName?: BranchName;
}

/**
 * BaseBranchResolver依存関係
 */
export interface BaseBranchResolverDeps {
  readonly gitEffects: GitEffects;
  readonly taskStore: TaskStore;
  readonly appRepoPath: RepoPath;
}

/**
 * BaseBranchResolverを生成
 *
 * WHY: タスクの依存関係からベースブランチを解決し、複数依存の場合は一時マージブランチを作成
 */
export const createBaseBranchResolver = (deps: BaseBranchResolverDeps) => {
  const { gitEffects, taskStore, appRepoPath } = deps;

  /**
   * タスクの依存関係からベースブランチを解決
   *
   * WHY: 依存タスクの成果物を引き継ぐため、依存先ブランチをベースにする
   * - 依存なし: undefined（HEADから分岐）
   * - 単一依存: 依存先ブランチ
   * - 複数依存: 一時マージブランチを作成（コンフリクト時はエラー）
   *
   * @param task タスク
   * @returns ベースブランチ解決結果、またはConflictResolutionRequiredエラー
   */
  const resolveBaseBranch = async (
    task: Task,
  ): Promise<Result<BaseBranchResolution, OrchestratorError>> => {
    const { dependencies } = task;

    // 依存なし: undefined
    if (dependencies.length === 0) {
      return createOk({ baseBranch: undefined, isTemporary: false });
    }

    // 依存先タスクのブランチを収集
    const dependencyBranches: BranchName[] = [];
    for (const depId of dependencies) {
      const depTaskResult = await taskStore.readTask(depId);
      if (isErr(depTaskResult)) {
        return createErr(depTaskResult.err);
      }
      dependencyBranches.push(depTaskResult.val.branch);
    }

    // 単一依存: 依存先ブランチ
    if (dependencyBranches.length === 1) {
      return createOk({ baseBranch: dependencyBranches[0], isTemporary: false });
    }

    // 複数依存: 一時マージブランチを作成
    const tempBranch = branchName(`temp-merge-${task.id}-${Date.now()}`);

    // 最初の依存ブランチから一時ブランチを作成
    const firstBranch = dependencyBranches[0]!; // 配列長は既にチェック済み
    const createBranchResult = await gitEffects.createBranch(
      appRepoPath,
      tempBranch,
      firstBranch,
    );
    if (isErr(createBranchResult)) {
      return createErr(createBranchResult.err);
    }

    // 一時ブランチに切り替え
    const switchResult = await gitEffects.switchBranch(appRepoPath, tempBranch);
    if (isErr(switchResult)) {
      // 作成した一時ブランチをクリーンアップ
      await cleanupTemporaryBranch(tempBranch);
      return createErr(switchResult.err);
    }

    const mergedBranches: BranchName[] = [firstBranch];

    // 残りの依存ブランチを順次マージ
    for (let i = 1; i < dependencyBranches.length; i++) {
      const branchToMerge = dependencyBranches[i]!; // インデックスは範囲内で保証済み
      const mergeResult = await gitEffects.merge(appRepoPath, branchToMerge);

      if (isErr(mergeResult)) {
        // マージエラー: 一時ブランチをクリーンアップしてエラーを返す
        await gitEffects.abortMerge(appRepoPath);
        await cleanupTemporaryBranch(tempBranch);
        return createErr(mergeResult.err);
      }

      const merge = mergeResult.val;

      if (merge.hasConflicts) {
        // コンフリクト発生: 解消タスクを生成
        const conflictTaskResult = await createAndStoreConflictResolutionTask(task, {
          tempBranch,
          mergedBranches: [...mergedBranches, branchToMerge],
          conflicts: merge.conflicts,
        });

        if (isErr(conflictTaskResult)) {
          // 解消タスク生成失敗: 一時ブランチをクリーンアップしてエラーを返す
          await gitEffects.abortMerge(appRepoPath);
          await cleanupTemporaryBranch(tempBranch);
          return createErr(conflictTaskResult.err);
        }

        // ConflictResolutionRequiredエラーを返す
        return createErr(
          conflictResolutionRequired(task.id, conflictTaskResult.val.id, tempBranch),
        );
      }

      mergedBranches.push(branchToMerge);
    }

    // 全てのマージが成功
    return createOk({ baseBranch: tempBranch, isTemporary: true, temporaryBranchName: tempBranch });
  };

  /**
   * コンフリクト解消タスクを生成してタスクストアに追加
   *
   * WHY: コンフリクトが発生した場合、エージェントに解消させるための専用タスクを作成
   * integration-operations.tsのcreateConflictResolutionTask（L185-227）を参考
   *
   * @param parentTask 親タスク（コンフリクトが発生したタスク）
   * @param conflictInfo コンフリクト情報
   * @returns 作成されたコンフリクト解消タスク
   */
  const createAndStoreConflictResolutionTask = async (
    parentTask: Task,
    conflictInfo: {
      tempBranch: BranchName;
      mergedBranches: BranchName[];
      conflicts: Array<{ filePath: string; reason: string }>;
    },
  ): Promise<Result<Task, OrchestratorError>> => {
    const { tempBranch, mergedBranches, conflicts } = conflictInfo;

    // コンフリクト内容を取得
    const conflictDetails: ConflictContent[] = [];
    for (const conflict of conflicts) {
      const contentResult = await gitEffects.getConflictContent(appRepoPath, conflict.filePath);
      if (contentResult.ok) {
        conflictDetails.push(contentResult.val);
      }
    }

    // プロンプト生成
    const prompt = buildConflictResolutionPrompt(parentTask, mergedBranches, conflictDetails);

    // コンフリクト解消タスクを作成
    const conflictTaskId = taskId(`conflict-resolution-${randomUUID()}`);
    const conflictTask = createInitialTask({
      id: conflictTaskId,
      repo: parentTask.repo,
      branch: tempBranch, // コンフリクト状態の一時ブランチをそのまま使用
      scopePaths: conflicts.map((c) => c.filePath),
      acceptance: `All merge conflicts in ${conflicts.map((c) => c.filePath).join(', ')} are resolved. The code compiles and tests pass.`,
      taskType: 'integration',
      context: prompt,
      dependencies: [], // 親タスクの依存は既に完了済み
    });

    // タスクストアに保存
    const saveResult = await taskStore.createTask(conflictTask);
    if (isErr(saveResult)) {
      return createErr(saveResult.err);
    }

    return createOk(conflictTask);
  };

  /**
   * コンフリクト解消プロンプトを構築
   *
   * WHY: 解決タスクにコンフリクトの詳細情報を提供し、自動解決を支援
   *
   * @param parentTask 親タスク
   * @param mergedBranches マージされたブランチリスト
   * @param conflictDetails コンフリクトの詳細内容
   * @returns プロンプト文字列
   */
  const buildConflictResolutionPrompt = (
    parentTask: Task,
    mergedBranches: BranchName[],
    conflictDetails: ConflictContent[],
  ): string => {
    const lines: string[] = [
      '# Merge Conflict Resolution',
      '',
      `Task: ${parentTask.id}`,
      `Merging branches: ${mergedBranches.join(', ')}`,
      '',
      'The following merge conflicts occurred while preparing the base branch:',
      '',
    ];

    for (const detail of conflictDetails) {
      lines.push(`## File: ${detail.filePath}`);
      lines.push(`Conflicting branch: ${detail.theirBranch}`);
      lines.push('');
      lines.push('### Our version (current branch):');
      lines.push('```');
      lines.push(detail.oursContent);
      lines.push('```');
      lines.push('');
      lines.push('### Their version (incoming branch):');
      lines.push('```');
      lines.push(detail.theirsContent);
      lines.push('```');
      lines.push('');
      if (detail.baseContent) {
        lines.push('### Base version (common ancestor):');
        lines.push('```');
        lines.push(detail.baseContent);
        lines.push('```');
        lines.push('');
      }
    }

    lines.push('## Instructions');
    lines.push('');
    lines.push('1. Resolve all merge conflicts in the listed files');
    lines.push('2. Ensure the code compiles and tests pass');
    lines.push('3. Commit the resolved changes');
    lines.push('');
    lines.push(
      'Note: This is a temporary merge branch. Once conflicts are resolved, the parent task will continue.',
    );

    return lines.join('\n');
  };

  /**
   * 一時ブランチをクリーンアップ
   *
   * WHY: エラー時やマージ完了後に一時ブランチを削除
   *
   * @param tempBranch 一時ブランチ名
   */
  const cleanupTemporaryBranch = async (
    tempBranch: BranchName,
  ): Promise<Result<void, OrchestratorError>> => {
    // HEADに戻る
    const currentBranchResult = await gitEffects.getCurrentBranch(appRepoPath);
    if (isErr(currentBranchResult)) {
      return createErr(currentBranchResult.err);
    }

    // 一時ブランチにいる場合は別のブランチに切り替え
    if (currentBranchResult.val === tempBranch) {
      // masterまたはmainに切り替え
      const branches = await gitEffects.listBranches(appRepoPath);
      if (isErr(branches)) {
        return createErr(branches.err);
      }

      const defaultBranch =
        branches.val.find((b) => b.name === 'master' || b.name === 'main')?.name ??
        branchName('main');

      const switchResult = await gitEffects.switchBranch(appRepoPath, defaultBranch);
      if (isErr(switchResult)) {
        return createErr(switchResult.err);
      }
    }

    // 一時ブランチを削除
    const deleteResult = await gitEffects.deleteBranch(appRepoPath, tempBranch, true);
    if (isErr(deleteResult)) {
      return createErr(deleteResult.err);
    }

    return createOk(undefined);
  };

  return {
    resolveBaseBranch,
    createAndStoreConflictResolutionTask,
    cleanupTemporaryBranch,
  };
};
