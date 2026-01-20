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
import { taskId } from '../../types/branded.ts';
import type { OrchestratorError } from '../../types/errors.ts';
import type { GitEffects } from '../../adapters/vcs/git-effects.ts';
import type { TaskStore } from '../task-store/interface.ts';
import type { ConflictContent } from '../../types/integration.ts';
import { randomUUID } from 'node:crypto';

/**
 * ベースブランチ解決結果（Discriminated Union型）
 *
 * WHY: 依存関係のパターンを型で明示し、不正な状態を型で防ぐ
 * - none: 依存なし（HEADから分岐）
 * - single: 単一依存（依存先ブランチを直接使用）
 * - multi: 複数依存（worktree内でマージが必要）
 */
export type BaseBranchResolution =
  | { readonly type: 'none' }
  | { readonly type: 'single'; readonly baseBranch: BranchName }
  | { readonly type: 'multi'; readonly dependencyBranches: readonly BranchName[] };

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
   * WHY: 依存タスクの成果物を引き継ぐため、依存先ブランチ情報を収集
   * - 依存なし: { type: 'none' }（HEADから分岐）
   * - 単一依存: { type: 'single', baseBranch }（依存先ブランチを直接使用）
   * - 複数依存: { type: 'multi', dependencyBranches }（worktree内でマージ）
   *
   * 注: 複数依存時のマージ処理はworktree内で実行するため、
   *     メインリポジトリのHEADを変更しない
   *
   * @param task タスク
   * @returns ベースブランチ解決結果
   */
  const resolveBaseBranch = async (
    task: Task,
  ): Promise<Result<BaseBranchResolution, OrchestratorError>> => {
    const { dependencies } = task;

    // 依存なし: type='none'
    if (dependencies.length === 0) {
      return createOk({ type: 'none' });
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

    // 単一依存: type='single'
    if (dependencyBranches.length === 1) {
      return createOk({ type: 'single', baseBranch: dependencyBranches[0]! });
    }

    // 複数依存: type='multi'（マージ処理はworktree内で実行）
    return createOk({ type: 'multi', dependencyBranches });
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

  return {
    resolveBaseBranch,
    createAndStoreConflictResolutionTask,
    buildConflictResolutionPrompt,
  };
};
