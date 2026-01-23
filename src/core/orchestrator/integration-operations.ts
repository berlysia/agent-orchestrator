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
  IntegrationWorktreeInfo,
  IntegrationMergeResult,
} from '../../types/integration.ts';
import type { GitEffects } from '../../adapters/vcs/git-effects.ts';
import type { TaskStore } from '../task-store/interface.ts';
import type { OrchestratorError } from '../../types/errors.ts';
import { ioError } from '../../types/errors.ts';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Config } from '../../types/config.ts';
import { shouldSkipAutoResolution } from './worker-operations.ts';
import type { GitHubEffects } from '../../types/github.ts';

/**
 * Integration依存関係
 */
export interface IntegrationDeps {
  readonly taskStore: TaskStore;
  readonly gitEffects: GitEffects;
  readonly appRepoPath: string;
  readonly config: Config;
  readonly githubEffects?: GitHubEffects;
}

/**
 * 統合設定
 */
export interface IntegrationConfig {
  /** 統合方法: 'pr' | 'command' | 'auto' (default: 'auto') */
  readonly method: 'pr' | 'command' | 'auto';
}

/**
 * Pull Request情報
 */
export interface PullRequestInfo {
  readonly title: string;
  readonly body: string;
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
   *
   * @param completedTasks 完了タスクのリスト
   * @param baseBranch ベースブランチ名
   * @param sessionShort セッション短縮ID（コンフリクト解決タスク生成用、省略時は空文字列で旧形式のIDを使用）
   */
  const integrateTasks = async (
    completedTasks: Task[],
    baseBranch: BranchName,
    sessionShort: string = '',
  ): Promise<Result<IntegrationResult, OrchestratorError>> => {
    const repo = repoPath(appRepoPath);

    // WHY: タスク実行中にベースブランチが更新される可能性があるため、
    // 統合ブランチを作成する前に最新のベースブランチを取得する
    const switchToBaseResult = await gitEffects.switchBranch(repo, baseBranch);
    if (isErr(switchToBaseResult)) {
      return createErr(switchToBaseResult.err);
    }

    // リモートがあれば最新の変更を取得
    // WHY: リモートがない場合（ローカルリポジトリのみ）でも動作するようにエラーは無視
    const hasRemoteResult = await gitEffects.hasRemote(repo, 'origin');
    if (hasRemoteResult.ok && hasRemoteResult.val) {
      const pullResult = await gitEffects.pull(repo, 'origin', baseBranch);
      if (isErr(pullResult)) {
        // pullに失敗しても続行（例: リモートに変更がない、認証失敗など）
        console.warn(`  ⚠️  Failed to pull latest changes from origin: ${pullResult.err.message}`);
      }
    }

    // 統合ブランチを作成（最新のbaseBranchから）
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

    // 署名設定に基づいてマージオプションを構築
    // NOTE: グローバルgit設定に依存しないよう、明示的に指定
    const mergeOptions: string[] = deps.config.commit.autoSignature ? ['--gpg-sign'] : ['--no-gpg-sign'];

    // 各タスクのブランチを順番にマージ
    for (const task of completedTasks) {
      const mergeResult = await gitEffects.merge(repo, task.branch, mergeOptions);

      if (isErr(mergeResult)) {
        // マージエラー: マージ状態をクリーンにしてから次へ
        // WHY: マージ状態が残ったまま次のマージを試みると "unmerged files" エラーになる
        await gitEffects.abortMerge(repo);
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
        // コンフリクト発生: カテゴリ別に分類して処理
        const lockfileConflicts: string[] = [];
        const nodeModulesConflicts: string[] = [];
        const binaryConflicts: string[] = [];
        const textConflicts: string[] = [];

        for (const conflict of merge.conflicts) {
          const resolution = shouldSkipAutoResolution(conflict.filePath);
          if (resolution.isLockfile) {
            lockfileConflicts.push(conflict.filePath);
          } else if (resolution.isNodeModules) {
            nodeModulesConflicts.push(conflict.filePath);
          } else if (resolution.skip && resolution.reason === 'binary file') {
            binaryConflicts.push(conflict.filePath);
          } else if (!resolution.skip) {
            textConflicts.push(conflict.filePath);
          } else {
            nodeModulesConflicts.push(conflict.filePath);
          }
        }

        // バイナリファイルのコンフリクトが含まれる場合
        if (binaryConflicts.length > 0) {
          console.log(
            `  ⚠️  Binary file conflicts in ${task.id}: ${binaryConflicts.join(', ')}`,
          );
          await gitEffects.abortMerge(repo);
          conflictedTaskIds.push(task.id);
          failedMerges.push({
            taskId: task.id,
            sourceBranch: task.branch,
            conflicts: merge.conflicts,
          });
          mergeDetails.push({
            taskId: task.id,
            sourceBranch: task.branch,
            targetBranch: integrationBranch,
            result: merge,
          });
          continue;
        }

        // lockfile/node_modulesコンフリクトを自動解決
        const autoResolvedCount = lockfileConflicts.length + nodeModulesConflicts.length;
        if (autoResolvedCount > 0) {
          console.log(`  🔧 Auto-resolving ${autoResolvedCount} generated file conflicts for ${task.id}`);

          for (const filePath of [...lockfileConflicts, ...nodeModulesConflicts]) {
            const checkoutResult = await gitEffects.raw?.(repo, ['checkout', '--ours', filePath]);
            if (checkoutResult && !checkoutResult.ok) {
              console.log(`  ⚠️  Failed to checkout --ours for ${filePath}`);
            }

            const markResult = await gitEffects.markConflictResolved(repo, filePath);
            if (!markResult.ok) {
              console.log(`  ⚠️  Failed to mark ${filePath} as resolved`);
            }
          }
        }

        // テキストファイルのコンフリクトがある場合
        if (textConflicts.length > 0) {
          console.log(`  ⚠️  Text file conflicts in ${task.id}: ${textConflicts.join(', ')}`);
          await gitEffects.abortMerge(repo);
          conflictedTaskIds.push(task.id);
          failedMerges.push({
            taskId: task.id,
            sourceBranch: task.branch,
            conflicts: merge.conflicts.filter((c) => textConflicts.includes(c.filePath)),
          });
          mergeDetails.push({
            taskId: task.id,
            sourceBranch: task.branch,
            targetBranch: integrationBranch,
            result: merge,
          });
          continue;
        }

        // 自動生成ファイルのみのコンフリクトだった場合
        if (autoResolvedCount > 0 && textConflicts.length === 0) {
          console.log(`  ✅ All conflicts auto-resolved for ${task.id}`);

          const commitResult = await gitEffects.commit(
            repo,
            `Merge ${task.branch}: auto-resolved generated file conflicts`,
            { gpgSign: deps.config.commit.autoSignature },
          );

          if (!commitResult.ok) {
            console.log(`  ❌ Failed to commit auto-resolved conflicts`);
            await gitEffects.abortMerge(repo);
            conflictedTaskIds.push(task.id);
            failedMerges.push({
              taskId: task.id,
              sourceBranch: task.branch,
              conflicts: merge.conflicts,
            });
            mergeDetails.push({
              taskId: task.id,
              sourceBranch: task.branch,
              targetBranch: integrationBranch,
              result: merge,
            });
            continue;
          }

          integratedTaskIds.push(task.id);
          mergeDetails.push({
            taskId: task.id,
            sourceBranch: task.branch,
            targetBranch: integrationBranch,
            result: { ...merge, hasConflicts: false, status: 'success' },
          });
          continue;
        }
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
        sessionShort,
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
   *
   * @param _conflictedTaskIds コンフリクトが発生したタスクIDの配列
   * @param failedMerges マージ失敗情報の配列
   * @param integrationBranch 統合ブランチ名
   * @param sessionShort セッション短縮ID（タスクIDの一意性を保証するため）
   */
  const createConflictResolutionTask = async (
    _conflictedTaskIds: TaskId[],
    failedMerges: Array<{ taskId: TaskId; sourceBranch: BranchName; conflicts: any[] }>,
    integrationBranch: BranchName,
    sessionShort: string,
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
    // WHY: セッションフィルタで除外されないよう、task-${sessionShort}-* 形式を使用
    const resolutionTaskId = taskId(`task-${sessionShort}-conflict-resolution-${randomUUID().slice(0, 8)}`);
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
   * 統合用worktreeを作成
   *
   * WHY: 統合後評価のために、baseBranchから新しいworktreeを作成し、
   *      そこで完了タスクをマージして評価を行う
   *
   * @param baseBranch ベースブランチ
   * @returns 統合worktree情報
   */
  const createIntegrationWorktree = async (
    baseBranch: BranchName,
  ): Promise<Result<IntegrationWorktreeInfo, OrchestratorError>> => {
    const repo = repoPath(appRepoPath);

    // WHY: タスク実行中にベースブランチが更新される可能性があるため、
    // 統合ブランチを作成する前に最新のベースブランチを取得する
    const switchToBaseResult = await gitEffects.switchBranch(repo, baseBranch);
    if (isErr(switchToBaseResult)) {
      return createErr(switchToBaseResult.err);
    }

    // リモートがあれば最新の変更を取得
    const hasRemoteResult = await gitEffects.hasRemote(repo, 'origin');
    if (hasRemoteResult.ok && hasRemoteResult.val) {
      const pullResult = await gitEffects.pull(repo, 'origin', baseBranch);
      if (isErr(pullResult)) {
        console.warn(`  ⚠️  Failed to pull latest changes from origin: ${pullResult.err.message}`);
      }
    }

    // 統合ブランチを作成
    const timestamp = Date.now();
    const integrationBranch = branchName(`integration/evaluation-${timestamp}`);

    // 統合用worktreeを作成（ブランチも同時に作成）
    const worktreeResult = await gitEffects.createWorktree(
      repo,
      taskId(`integration-${timestamp}`),
      integrationBranch,
      true, // createBranch
      baseBranch, // baseBranch
    );

    if (isErr(worktreeResult)) {
      return createErr(worktreeResult.err);
    }

    return createOk({
      worktreePath: worktreeResult.val,
      integrationBranch,
    });
  };

  /**
   * 統合worktree内でタスクをマージ
   *
   * WHY: 完了タスクを統合worktreeにマージし、コンフリクトがあれば検出する
   *
   * @param worktreeInfo 統合worktree情報
   * @param completedTasks 完了タスクのリスト
   * @param sessionShort セッション短縮ID（コンフリクト解決タスク生成用）
   * @returns 統合マージ結果
   */
  const mergeTasksInWorktree = async (
    worktreeInfo: IntegrationWorktreeInfo,
    completedTasks: Task[],
    sessionShort: string,
  ): Promise<Result<IntegrationMergeResult, OrchestratorError>> => {
    const { worktreePath: wtPath, integrationBranch } = worktreeInfo;
    const repo = repoPath(String(wtPath));

    const mergedTaskIds: TaskId[] = [];
    const conflictedTaskIds: TaskId[] = [];
    const failedMerges: Array<{ taskId: TaskId; sourceBranch: BranchName; conflicts: any[] }> = [];

    // マージ戦略に基づいてオプションを構築
    // WHY: 'ff-prefer' はグラフ簡素化のためff可能ならff、'no-ff' は各タスクを明示的に記録
    const worktreeMergeOptions: string[] = ['--no-commit'];
    if (deps.config.integration.mergeStrategy === 'no-ff') {
      worktreeMergeOptions.push('--no-ff');
    }
    // NOTE: グローバルgit設定に依存しないよう、明示的に指定
    worktreeMergeOptions.push(deps.config.commit.autoSignature ? '--gpg-sign' : '--no-gpg-sign');

    // 各タスクのブランチを順番にマージ
    for (const task of completedTasks) {
      const sourceBranch = task.branch;

      const mergeResult = await gitEffects.merge(repo, sourceBranch, worktreeMergeOptions);

      if (isErr(mergeResult)) {
        // マージエラー: マージ状態をクリーンにしてからエラーを返す
        await gitEffects.abortMerge(repo);
        return createErr(mergeResult.err);
      }

      if (mergeResult.val.success) {
        // 差分なしマージの検出
        // WHY: ブランチが既に統合済みの場合、コミット作成をスキップして効率化
        if (mergeResult.val.mergedFiles.length === 0) {
          console.log(
            `  ⚠️  No-op merge for task ${task.id}: branch already contains all changes`,
          );
          mergedTaskIds.push(task.id);
          continue;
        }

        // マージ成功: コミットを作成
        const commitMessage = `Merge task ${task.id}: ${task.acceptance}`;
        const commitResult = await gitEffects.commit(repo, commitMessage, { gpgSign: deps.config.commit.autoSignature });

        if (isErr(commitResult)) {
          // WHY: コミット失敗時はMERGE_HEADが残る可能性があるため、
          //      クリーンアップして次のマージに備える
          console.log(
            `  ❌ Commit failed, cleaning up merge state: ${commitResult.err.message}`,
          );
          await gitEffects.abortMerge(repo);
          return createErr(commitResult.err);
        }

        mergedTaskIds.push(task.id);
      } else if (mergeResult.val.hasConflicts) {
        // コンフリクト発生: カテゴリ別に分類して処理
        // WHY: node_modules/lockfileは自動解決可能、テキストファイルのみ手動解決が必要
        const lockfileConflicts: string[] = [];
        const nodeModulesConflicts: string[] = [];
        const binaryConflicts: string[] = [];
        const textConflicts: string[] = [];

        for (const conflict of mergeResult.val.conflicts) {
          const resolution = shouldSkipAutoResolution(conflict.filePath);
          if (resolution.isLockfile) {
            lockfileConflicts.push(conflict.filePath);
          } else if (resolution.isNodeModules) {
            nodeModulesConflicts.push(conflict.filePath);
          } else if (resolution.skip && resolution.reason === 'binary file') {
            binaryConflicts.push(conflict.filePath);
          } else if (!resolution.skip) {
            textConflicts.push(conflict.filePath);
          } else {
            // その他の自動解決スキップ対象（拡張子なし実行ファイルなど）
            nodeModulesConflicts.push(conflict.filePath);
          }
        }

        // バイナリファイルのコンフリクトが含まれる場合はエラー
        if (binaryConflicts.length > 0) {
          console.log(
            `  ⚠️  Binary file conflicts in ${task.id}: ${binaryConflicts.join(', ')} (cannot auto-resolve)`,
          );
          await gitEffects.abortMerge(repo);
          conflictedTaskIds.push(task.id);
          failedMerges.push({
            taskId: task.id,
            sourceBranch,
            conflicts: mergeResult.val.conflicts,
          });
          continue;
        }

        // lockfile/node_modulesコンフリクトを自動解決
        const autoResolvedCount = lockfileConflicts.length + nodeModulesConflicts.length;
        if (autoResolvedCount > 0) {
          console.log(`  🔧 Auto-resolving ${autoResolvedCount} generated file conflicts for ${task.id}`);

          for (const filePath of [...lockfileConflicts, ...nodeModulesConflicts]) {
            // --ours を採用（どちらでも良い、後で再生成される）
            const checkoutResult = await gitEffects.raw?.(repo, ['checkout', '--ours', filePath]);
            if (checkoutResult && !checkoutResult.ok) {
              console.log(`  ⚠️  Failed to checkout --ours for ${filePath}: ${checkoutResult.err.message}`);
            }

            const markResult = await gitEffects.markConflictResolved(repo, filePath);
            if (!markResult.ok) {
              console.log(`  ⚠️  Failed to mark ${filePath} as resolved: ${markResult.err.message}`);
            }
          }
        }

        // テキストファイルのコンフリクトがある場合はconflictResolutionTaskに委任
        if (textConflicts.length > 0) {
          console.log(`  ⚠️  Text file conflicts in ${task.id}: ${textConflicts.join(', ')}`);
          await gitEffects.abortMerge(repo);
          conflictedTaskIds.push(task.id);
          failedMerges.push({
            taskId: task.id,
            sourceBranch,
            conflicts: mergeResult.val.conflicts.filter((c) => textConflicts.includes(c.filePath)),
          });
          continue;
        }

        // 自動生成ファイルのみのコンフリクトだった場合
        if (autoResolvedCount > 0 && textConflicts.length === 0) {
          console.log(`  ✅ All conflicts auto-resolved for ${task.id}`);

          // コミットして続行
          const commitMessage = `Merge task ${task.id}: ${task.acceptance} (auto-resolved conflicts)`;
          const commitResult = await gitEffects.commit(repo, commitMessage, { gpgSign: deps.config.commit.autoSignature });

          if (!commitResult.ok) {
            // コミット失敗時はマージを中断
            console.log(`  ❌ Failed to commit auto-resolved conflicts: ${commitResult.err.message}`);
            await gitEffects.abortMerge(repo);
            conflictedTaskIds.push(task.id);
            failedMerges.push({
              taskId: task.id,
              sourceBranch,
              conflicts: mergeResult.val.conflicts,
            });
            continue;
          }

          mergedTaskIds.push(task.id);
        }
      }
    }

    // コンフリクトがある場合は解決タスクを生成
    let conflictResolutionTaskId: TaskId | null = null;
    if (failedMerges.length > 0) {
      const conflictTaskResult = await createConflictResolutionTask(
        conflictedTaskIds,
        failedMerges,
        integrationBranch,
        sessionShort,
      );

      if (conflictTaskResult.ok) {
        conflictResolutionTaskId = conflictTaskResult.val.id;
      }
    }

    return createOk({
      success: conflictedTaskIds.length === 0,
      mergedTaskIds,
      conflictedTaskIds,
      conflictResolutionTaskId,
    });
  };

  /**
   * 統合worktreeのコード差分を取得
   *
   * WHY: 統合後評価のために、baseBranchとの差分を取得する
   *
   * @param worktreeInfo 統合worktree情報
   * @param baseBranch ベースブランチ
   * @returns git diff結果（文字列）
   */
  const getIntegrationDiff = async (
    worktreeInfo: IntegrationWorktreeInfo,
    baseBranch: BranchName,
  ): Promise<Result<string, OrchestratorError>> => {
    const { worktreePath: wtPath } = worktreeInfo;
    const repo = repoPath(String(wtPath));

    // WHY: --stat でファイル一覧と変更行数を含む差分を取得
    const diffResult = await gitEffects.getDiff(repo, ['--stat', String(baseBranch)]);

    if (isErr(diffResult)) {
      return createErr(diffResult.err);
    }

    return createOk(diffResult.val);
  };

  /**
   * 統合worktreeをクリーンアップ
   *
   * WHY: 評価完了後、統合worktreeを削除してディスクスペースを解放する
   *
   * @param worktreeInfo 統合worktree情報
   * @returns 成功可否
   */
  const cleanupIntegrationWorktree = async (
    worktreeInfo: IntegrationWorktreeInfo,
  ): Promise<Result<void, OrchestratorError>> => {
    const { worktreePath: wtPath } = worktreeInfo;
    const repo = repoPath(appRepoPath);

    // worktreeを削除
    // WHY: removeWorktreeはworktree名を期待するが、wtPathは絶対パスなのでbasenameで抽出
    const worktreeName = basename(String(wtPath));
    const removeResult = await gitEffects.removeWorktree(repo, worktreeName);

    if (isErr(removeResult)) {
      return createErr(removeResult.err);
    }

    return createOk(undefined);
  };

  /**
   * 統合ブランチの取り込み方法を決定し、結果を返す
   *
   * WHY: 統合ブランチ全体に署名を付けてベースブランチにマージする。
   *      config.commit.integrationSignatureで署名の有無を制御。
   */
  const finalizeIntegration = async (
    integrationBranch: BranchName,
    baseBranch: BranchName,
    config: IntegrationConfig,
    prInfo?: PullRequestInfo,
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

      // GitHub config確認
      if (!deps.config.github) {
        return createErr(
          ioError('finalizeIntegration', new Error('GitHub config is required for PR creation')),
        );
      }

      // GitHubEffects確認
      if (!deps.githubEffects) {
        return createErr(
          ioError('finalizeIntegration', new Error('GitHubEffects is not configured')),
        );
      }

      // ブランチをリモートにpush
      const pushResult = await gitEffects.push(repo, 'origin', integrationBranch);
      if (isErr(pushResult)) {
        return createErr(pushResult.err);
      }

      // PRを作成
      const prResult = await deps.githubEffects.createPullRequest({
        config: deps.config.github,
        title: prInfo?.title ?? 'Integration: ' + integrationBranch,
        body: prInfo?.body ?? 'Auto-generated by Agent Orchestrator',
        head: String(integrationBranch),
        base: String(baseBranch),
        draft: false,
      });

      if (isErr(prResult)) {
        return createErr(prResult.err);
      }

      return createOk({
        method: 'pr',
        prUrl: prResult.val.url,
      });
    } else if (config.method === 'command') {
      // コマンド出力（手動マージ）
      const mergeCommand = `git checkout ${baseBranch} && git merge ${integrationBranch}`;
      return createOk({
        method: 'command',
        mergeCommand,
      });
    } else {
      // auto: 自動統合を実行
      // WHY: integrationSignature=true の場合、GPG署名にはユーザー認証が必要なため、
      //      自動rebaseではなくコマンド出力に切り替えてユーザーが手動で署名できるようにする

      if (deps.config.commit.integrationSignature) {
        // 署名が必要な場合はコマンド出力に切り替え
        // WHY: 長時間オーケストレーション後にユーザーが不在の場合、
        //      pinentry等の認証がタイムアウトするため、遅延実行を可能にする
        const mergeCommand = `agent finalize --base ${baseBranch} --branch ${integrationBranch}`;
        return createOk({
          method: 'command',
          mergeCommand,
        });
      }

      // 署名不要の場合は自動マージを実行
      // 統合ブランチに切り替え
      const switchToIntegrationResult = await gitEffects.switchBranch(repo, integrationBranch);
      if (isErr(switchToIntegrationResult)) {
        return createErr(switchToIntegrationResult.err);
      }

      // 統合ブランチをベースブランチに対してrebase（署名なし）
      const rebaseResult = await gitEffects.rebase(repo, baseBranch, { gpgSign: false });
      if (isErr(rebaseResult)) {
        return createErr(rebaseResult.err);
      }

      // ベースブランチに切り替え
      const switchToBaseResult = await gitEffects.switchBranch(repo, baseBranch);
      if (isErr(switchToBaseResult)) {
        return createErr(switchToBaseResult.err);
      }

      // Fast-forward merge
      const mergeResult = await gitEffects.merge(repo, integrationBranch, ['--ff-only']);
      if (isErr(mergeResult)) {
        return createErr(mergeResult.err);
      }

      if (!mergeResult.val.success) {
        return createErr(ioError('finalizeIntegration', new Error('Fast-forward merge failed')));
      }

      return createOk({
        method: 'auto',
        merged: true,
      });
    }
  };

  return {
    integrateTasks,
    createConflictResolutionTask,
    buildConflictResolutionPrompt,
    collectConflictDetails,
    createIntegrationWorktree,
    mergeTasksInWorktree,
    getIntegrationDiff,
    cleanupIntegrationWorktree,
    finalizeIntegration,
  };
};
