/**
 * Worker Operations - タスク実装を担当する関数群
 *
 * Workerクラスを関数型パターンで再実装。
 * タスクごとにworktreeを作成し、エージェントを実行して実装を行う。
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr, isErr } from 'option-t/plain_result';
import type { Task } from '../../types/task.ts';
import { createInitialTask } from '../../types/task.ts';
import type { TaskId, WorktreePath, RepoPath, BranchName } from '../../types/branded.ts';
import { runId, repoPath, taskId } from '../../types/branded.ts';
import type { GitEffects } from '../../adapters/vcs/git-effects.ts';
import type { RunnerEffects } from '../runner/runner-effects.ts';
import type { TaskStore } from '../task-store/interface.ts';
import type { OrchestratorError } from '../../types/errors.ts';
import { conflictResolutionRequired } from '../../types/errors.ts';
import { createInitialRun, RunStatus } from '../../types/run.ts';
import type { Config } from '../../types/config.ts';
import type { ConflictContent } from '../../types/integration.ts';
import type { BaseBranchResolution } from './base-branch-resolver.ts';

/**
 * Worker依存関係
 */
export interface WorkerDeps {
  readonly gitEffects: GitEffects;
  readonly runnerEffects: RunnerEffects;
  readonly taskStore: TaskStore;
  readonly appRepoPath: RepoPath;
  readonly agentCoordPath: string;
  readonly agentType: 'claude' | 'codex';
  readonly model: string;
  readonly config: Config;
}

/**
 * Worker実行結果
 */
export interface WorkerResult {
  /** 実行ID */
  readonly runId: string;
  /** 成功したか */
  readonly success: boolean;
  /** エラーメッセージ（失敗時） */
  readonly error?: string;
}

/**
 * エージェント種別
 */
export type AgentType = 'claude' | 'codex';

/**
 * コミットメッセージを生成（純粋関数）
 */
export const generateCommitMessage = (task: Task): string => {
  return `feat: ${task.acceptance}

Task ID: ${task.id}
Branch: ${task.branch}

🤖 Generated with Agent Orchestrator
`;
};

/**
 * Worker操作を生成するファクトリ関数
 */
export const createWorkerOperations = (deps: WorkerDeps) => {
  const toRelativePath = (targetPath: string): string => {
    const absolutePath = path.resolve(targetPath);
    const relativePath = path.relative(process.cwd(), absolutePath);
    return relativePath === '' ? '.' : relativePath;
  };

  const getRunDisplayPath = (runIdValue: string, ext: 'log' | 'json'): string => {
    return toRelativePath(path.join(deps.agentCoordPath, 'runs', `${runIdValue}.${ext}`));
  };

  /**
   * タスク用のworktreeを作成
   *
   * ブランチが存在しない場合は新規作成します。
   *
   * WHY: ブランチ名にタスクIDを含めることで、並列実行時の衝突を防ぐ
   * 例: feature/auth → feature/auth-task-2b8c0253-1
   *
   * @param task タスク
   * @param baseBranch 起点となるブランチ（新規ブランチ作成時のみ使用）
   * @returns worktreeのパス（Result型）
   */
  const setupWorktree = async (
    task: Task,
    baseBranch?: BranchName,
  ): Promise<Result<WorktreePath, OrchestratorError>> => {
    // タスクのブランチ名を取得（Plannerが既にタスクIDを含めている）
    const taskBranchName = task.branch;

    // ブランチが存在するか確認
    const branchesResult = await deps.gitEffects.listBranches(deps.appRepoPath);
    if (isErr(branchesResult)) {
      return createErr(branchesResult.err);
    }

    const branches = branchesResult.val;
    const branchExists = branches.some((b) => b.name === taskBranchName);

    // Worktreeを作成（createBranchフラグでブランチも同時作成）
    // WHY: baseBranch指定時は、そのブランチから分岐（依存関係を反映）
    const worktreeResult = await deps.gitEffects.createWorktree(
      deps.appRepoPath,
      task.id,
      taskBranchName,
      !branchExists,
      baseBranch,
    );

    return worktreeResult;
  };

  /**
   * コンフリクト解消タスクを生成してタスクストアに追加
   *
   * WHY: コンフリクトが発生した場合、エージェントに解消させるための専用タスクを作成
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
      const contentResult = await deps.gitEffects.getConflictContent(
        deps.appRepoPath,
        conflict.filePath,
      );
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
    const saveResult = await deps.taskStore.createTask(conflictTask);
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
   * 複数依存タスク用のworktreeを作成し、依存ブランチをマージ
   *
   * WHY: メインリポジトリのHEADを変更せず、worktree内でマージを実行することで
   *      並列実行時のGit操作競合を防ぐ
   *
   * @param task タスク
   * @param dependencyBranches 依存ブランチのリスト
   * @returns worktreeのパス、またはConflictResolutionRequiredエラー
   */
  const setupWorktreeWithMerge = async (
    task: Task,
    dependencyBranches: readonly BranchName[],
  ): Promise<Result<WorktreePath, OrchestratorError>> => {
    if (dependencyBranches.length === 0) {
      return createErr({
        type: 'ValidationError',
        details: 'dependencyBranches must not be empty',
        message: 'setupWorktreeWithMerge called with empty dependencyBranches',
      });
    }

    // 1. 最初の依存ブランチからworktree作成
    const firstBranch = dependencyBranches[0]!;
    const worktreeResult = await setupWorktree(task, firstBranch);
    if (isErr(worktreeResult)) {
      return createErr(worktreeResult.err);
    }

    const worktreePath = worktreeResult.val;

    // 依存が1つだけの場合はマージ不要
    if (dependencyBranches.length === 1) {
      return createOk(worktreePath);
    }

    const mergedBranches: BranchName[] = [firstBranch];

    // 2. worktree内で残りの依存ブランチを順次マージ
    for (let i = 1; i < dependencyBranches.length; i++) {
      const branchToMerge = dependencyBranches[i]!;
      const mergeResult = await deps.gitEffects.merge(repoPath(worktreePath), branchToMerge);

      if (isErr(mergeResult)) {
        // マージエラー: マージを中断し、worktreeをクリーンアップしてエラーを返す
        await deps.gitEffects.abortMerge(repoPath(worktreePath));
        await cleanupWorktree(task.id);
        return createErr(mergeResult.err);
      }

      const merge = mergeResult.val;

      if (merge.hasConflicts) {
        // コンフリクト発生: 解消タスクを生成
        const conflictTaskResult = await createAndStoreConflictResolutionTask(task, {
          tempBranch: task.branch, // タスクのブランチをそのまま使用
          mergedBranches: [...mergedBranches, branchToMerge],
          conflicts: merge.conflicts,
        });

        if (isErr(conflictTaskResult)) {
          // 解消タスク生成失敗: マージを中断し、worktreeをクリーンアップしてエラーを返す
          await deps.gitEffects.abortMerge(repoPath(worktreePath));
          await cleanupWorktree(task.id);
          return createErr(conflictTaskResult.err);
        }

        // ConflictResolutionRequiredエラーを返す
        // WHY: マージは中断せず、コンフリクト状態のworktreeを解消タスクに引き継ぐ
        return createErr(
          conflictResolutionRequired(task.id, conflictTaskResult.val.id, task.branch),
        );
      }

      mergedBranches.push(branchToMerge);
    }

    // 全てのマージが成功
    return createOk(worktreePath);
  };

  /**
   * タスクを実行（エージェント実行のみ）
   *
   * エージェントを起動してタスクを実行します。
   * 実行ログとメタデータをrunsディレクトリに保存します。
   * Git操作（commit、push）は別の関数で行います。
   *
   * @param task タスク
   * @param worktreePath worktreeのパス
   * @returns 実行結果（runIdと成功/失敗）
   */
  const executeTask = async (
    task: Task,
    worktreePath: WorktreePath,
  ): Promise<Result<WorkerResult, OrchestratorError>> => {
    // 1. runsディレクトリを確保
    const ensureResult = await deps.runnerEffects.ensureRunsDir();
    if (isErr(ensureResult)) {
      return createErr(ensureResult.err);
    }

    // 2. RunID生成（タスクIDベース）
    const timestamp = Date.now();
    const theRunId = runId(`run-${task.id}-${timestamp}`);
    const logPath = path.join(deps.agentCoordPath, 'runs', `${theRunId}.log`);

    // 3. 実行メタデータを初期化
    const run = createInitialRun({
      id: theRunId,
      taskId: task.id,
      agentType: deps.agentType,
      logPath,
      plannerRunId: task.plannerRunId ?? null,
      plannerLogPath: task.plannerLogPath ?? null,
      plannerMetadataPath: task.plannerMetadataPath ?? null,
    });

    // メタデータ保存
    const saveMetaResult = await deps.runnerEffects.saveRunMetadata(run);
    if (isErr(saveMetaResult)) {
      return createErr(saveMetaResult.err);
    }

    // ログファイルのヘッダーを初期化
    const initLogResult = await deps.runnerEffects.initializeLogFile(run);
    if (isErr(initLogResult)) {
      return createErr(initLogResult.err);
    }

    console.log(`  📝 Execution log: ${getRunDisplayPath(theRunId, 'log')}`);
    console.log(`  📊 Metadata: ${getRunDisplayPath(theRunId, 'json')}`);

    // 4. ログにタスク開始を記録
    await deps.runnerEffects.appendLog(
      theRunId,
      `[${new Date().toISOString()}] Starting task: ${task.acceptance}\n`,
    );
    await deps.runnerEffects.appendLog(theRunId, `Agent Type: ${deps.agentType}\n`);
    await deps.runnerEffects.appendLog(theRunId, `Worktree: ${worktreePath}\n\n`);

    // 5. エージェントを実行
    // WHY: 役割ごとに最適なモデルを使用（Config から取得）
    let agentPrompt = `Execute task: ${task.acceptance}`;

    // フィードバックがある場合は追加（継続実行のため）
    // WHY: 前回の判定で指摘された問題を明示することで、エージェントが適切に対処できる
    if (task.judgementFeedback) {
      agentPrompt += `\n\n⚠️  Previous attempt (iteration ${task.judgementFeedback.iteration}/${task.judgementFeedback.maxIterations}):`;
      agentPrompt += `\nReason: ${task.judgementFeedback.lastJudgement.reason}`;
      if (task.judgementFeedback.lastJudgement.missingRequirements.length > 0) {
        agentPrompt += `\n\nMissing requirements:`;
        for (const req of task.judgementFeedback.lastJudgement.missingRequirements) {
          agentPrompt += `\n  - ${req}`;
        }
      }
      agentPrompt += `\n\nPlease address these issues and complete the task.`;
    }

    const agentResult =
      deps.agentType === 'claude'
        ? await deps.runnerEffects.runClaudeAgent(agentPrompt, worktreePath as string, deps.model!)
        : await deps.runnerEffects.runCodexAgent(agentPrompt, worktreePath as string, deps.model);

    // 6. 結果をログに記録
    if (isErr(agentResult)) {
      const errorMsg = agentResult.err.message;
      await deps.runnerEffects.appendLog(
        theRunId,
        `[${new Date().toISOString()}] ❌ Agent execution failed\n`,
      );
      await deps.runnerEffects.appendLog(theRunId, `Error: ${errorMsg}\n`);

      // メタデータ更新（失敗）
      const failedRun = {
        ...run,
        status: RunStatus.FAILURE,
        finishedAt: new Date().toISOString(),
        errorMessage: errorMsg,
      };
      await deps.runnerEffects.saveRunMetadata(failedRun);

      return createOk({
        runId: theRunId,
        success: false,
        error: errorMsg,
      });
    }

    // 7. 成功時の処理
    const output = agentResult.val;

    await deps.runnerEffects.appendLog(
      theRunId,
      `[${new Date().toISOString()}] ✅ Agent execution completed\n`,
    );
    await deps.runnerEffects.appendLog(theRunId, `Final Response:\n${output.finalResponse}\n`);

    // メタデータ更新（成功）
    const completedRun = {
      ...run,
      status: RunStatus.SUCCESS,
      finishedAt: new Date().toISOString(),
    };
    await deps.runnerEffects.saveRunMetadata(completedRun);

    return createOk({
      runId: theRunId,
      success: true,
    });
  };

  /**
   * 変更をコミット
   *
   * WHY: config.commit.autoSignatureで自動コミット時の署名を制御。
   *      Worker実行時の各タスクコミットはデフォルトで署名なし（開発効率重視）。
   *
   * @param task タスク
   * @param worktreePath worktreeのパス
   * @returns Result型
   */
  const commitChanges = async (
    task: Task,
    worktreePath: WorktreePath,
  ): Promise<Result<void, OrchestratorError>> => {
    // 変更をステージング
    const stageResult = await deps.gitEffects.stageAll(worktreePath);
    if (isErr(stageResult)) {
      return createErr(stageResult.err);
    }

    // コミットメッセージを生成
    const commitMessage = generateCommitMessage(task);

    // コミットオプション設定（署名制御）
    const noGpgSign = !deps.config.commit.autoSignature;

    // コミット
    const commitResult = await deps.gitEffects.commit(worktreePath, commitMessage, { noGpgSign });
    if (isErr(commitResult)) {
      return createErr(commitResult.err);
    }

    return createOk(undefined);
  };

  /**
   * リモートにpush
   *
   * WHY: worktreeの現在のブランチ名を取得してpushすることで、serial chain実行時の
   *      ブランチ名の不一致を防ぐ（最初のタスクのブランチ名を使用）
   *
   * @param worktreePath worktreeのパス
   * @returns Result型
   */
  const pushChanges = async (
    worktreePath: WorktreePath,
  ): Promise<Result<void, OrchestratorError>> => {
    // worktreeの現在のブランチ名を取得
    const currentBranchResult = await deps.gitEffects.getCurrentBranch(repoPath(worktreePath));
    if (isErr(currentBranchResult)) {
      return createErr(currentBranchResult.err);
    }

    const currentBranch = currentBranchResult.val;
    const pushResult = await deps.gitEffects.push(worktreePath, 'origin', currentBranch);

    if (isErr(pushResult)) {
      return createErr(pushResult.err);
    }

    return createOk(undefined);
  };

  /**
   * Worktreeをクリーンアップ（削除）
   *
   * @param taskId タスクID
   * @returns Result型
   */
  const cleanupWorktree = async (taskId: TaskId): Promise<Result<void, OrchestratorError>> => {
    const removeResult = await deps.gitEffects.removeWorktree(deps.appRepoPath, taskId);
    return removeResult;
  };

  /**
   * 既存のworktreeでタスクを実行
   *
   * WHY: 直列チェーンのタスクは同じworktreeを共有することで、前のタスクの変更を引き継げる
   *
   * @param task タスク
   * @param worktreePath 既存のworktreeパス
   * @param previousFeedback 前のタスクのフィードバック（任意）
   * @returns 実行結果
   */
  const executeTaskInExistingWorktree = async (
    task: Task,
    worktreePath: WorktreePath,
    previousFeedback?: string,
  ): Promise<Result<WorkerResult, OrchestratorError>> => {
    // 1. runsディレクトリを確保
    const ensureResult = await deps.runnerEffects.ensureRunsDir();
    if (isErr(ensureResult)) {
      return createErr(ensureResult.err);
    }

    // 2. RunID生成（タスクIDベース）
    const timestamp = Date.now();
    const theRunId = runId(`run-${task.id}-${timestamp}`);
    const logPath = path.join(deps.agentCoordPath, 'runs', `${theRunId}.log`);

    // 3. 実行メタデータを初期化
    const run = createInitialRun({
      id: theRunId,
      taskId: task.id,
      agentType: deps.agentType,
      logPath,
      plannerRunId: task.plannerRunId ?? null,
      plannerLogPath: task.plannerLogPath ?? null,
      plannerMetadataPath: task.plannerMetadataPath ?? null,
    });

    // メタデータ保存
    const saveMetaResult = await deps.runnerEffects.saveRunMetadata(run);
    if (isErr(saveMetaResult)) {
      return createErr(saveMetaResult.err);
    }

    // ログファイルのヘッダーを初期化
    const initLogResult = await deps.runnerEffects.initializeLogFile(run);
    if (isErr(initLogResult)) {
      return createErr(initLogResult.err);
    }

    console.log(`  📝 Execution log: ${getRunDisplayPath(theRunId, 'log')}`);
    console.log(`  📊 Metadata: ${getRunDisplayPath(theRunId, 'json')}`);

    // 4. ログにタスク開始を記録
    await deps.runnerEffects.appendLog(
      theRunId,
      `[${new Date().toISOString()}] Starting task: ${task.acceptance}\n`,
    );
    await deps.runnerEffects.appendLog(theRunId, `Agent Type: ${deps.agentType}\n`);
    await deps.runnerEffects.appendLog(theRunId, `Worktree: ${worktreePath} (reused)\n`);

    if (previousFeedback) {
      await deps.runnerEffects.appendLog(
        theRunId,
        `Previous task feedback:\n${previousFeedback}\n\n`,
      );
    }

    // 5. エージェントを実行（プロンプトにフィードバックを追加）
    let agentPrompt = `Execute task: ${task.acceptance}`;

    if (previousFeedback) {
      agentPrompt += `\n\nPrevious task feedback:\n${previousFeedback}`;
    }

    // Judge判定フィードバックがある場合は追加（継続実行のため）
    // WHY: 前回の判定で指摘された問題を明示することで、エージェントが適切に対処できる
    if (task.judgementFeedback) {
      agentPrompt += `\n\n⚠️  Previous attempt (iteration ${task.judgementFeedback.iteration}/${task.judgementFeedback.maxIterations}):`;
      agentPrompt += `\nReason: ${task.judgementFeedback.lastJudgement.reason}`;
      if (task.judgementFeedback.lastJudgement.missingRequirements.length > 0) {
        agentPrompt += `\n\nMissing requirements:`;
        for (const req of task.judgementFeedback.lastJudgement.missingRequirements) {
          agentPrompt += `\n  - ${req}`;
        }
      }
      agentPrompt += `\n\nPlease address these issues and complete the task.`;
    }

    const agentResult =
      deps.agentType === 'claude'
        ? await deps.runnerEffects.runClaudeAgent(agentPrompt, worktreePath as string, deps.model!)
        : await deps.runnerEffects.runCodexAgent(agentPrompt, worktreePath as string, deps.model);

    // 6. 結果をログに記録
    if (isErr(agentResult)) {
      const errorMsg = agentResult.err.message;
      await deps.runnerEffects.appendLog(
        theRunId,
        `[${new Date().toISOString()}] ❌ Agent execution failed\n`,
      );
      await deps.runnerEffects.appendLog(theRunId, `Error: ${errorMsg}\n`);

      // メタデータ更新（失敗）
      const failedRun = {
        ...run,
        status: RunStatus.FAILURE,
        finishedAt: new Date().toISOString(),
        errorMessage: errorMsg,
      };
      await deps.runnerEffects.saveRunMetadata(failedRun);

      return createOk({
        runId: theRunId,
        success: false,
        error: errorMsg,
      });
    }

    // 7. 成功時の処理
    const output = agentResult.val;

    await deps.runnerEffects.appendLog(
      theRunId,
      `[${new Date().toISOString()}] ✅ Agent execution completed\n`,
    );
    await deps.runnerEffects.appendLog(theRunId, `Final Response:\n${output.finalResponse}\n`);

    // メタデータ更新（成功）
    const completedRun = {
      ...run,
      status: RunStatus.SUCCESS,
      finishedAt: new Date().toISOString(),
    };
    await deps.runnerEffects.saveRunMetadata(completedRun);

    return createOk({
      runId: theRunId,
      success: true,
    });
  };

  /**
   * タスクを実行（全体のオーケストレーション）
   *
   * 1. worktreeを作成（依存関係に応じた処理）
   * 2. Workerエージェントを起動
   * 3. 変更をコミット
   * 4. リモートにpush
   *
   * @param task 実行するタスク
   * @param resolution ベースブランチ解決結果（依存関係のパターン）
   * @returns 実行結果
   */
  const executeTaskWithWorktree = async (
    task: Task,
    resolution: BaseBranchResolution,
  ): Promise<Result<WorkerResult, OrchestratorError>> => {
    try {
      // 1. Worktreeを作成（resolutionの型に応じて処理を分岐）
      let worktreeResult: Result<WorktreePath, OrchestratorError>;

      switch (resolution.type) {
        case 'none':
          // 依存なし: HEADから分岐
          worktreeResult = await setupWorktree(task);
          break;
        case 'single':
          // 単一依存: 依存先ブランチから分岐
          worktreeResult = await setupWorktree(task, resolution.baseBranch);
          break;
        case 'multi':
          // 複数依存: worktree内でマージ
          worktreeResult = await setupWorktreeWithMerge(task, resolution.dependencyBranches);
          break;
      }

      if (isErr(worktreeResult)) {
        return createErr(worktreeResult.err);
      }

      const worktreePath = worktreeResult.val;

      // 2. タスクを実行
      const runResult = await executeTask(task, worktreePath);
      if (isErr(runResult)) {
        return createErr(runResult.err);
      }

      const result = runResult.val;

      if (!result.success) {
        // エージェント実行失敗時はWorkerResultをそのまま返す
        return createOk(result);
      }

      // 3. 変更をコミット
      const commitResult = await commitChanges(task, worktreePath);
      if (isErr(commitResult)) {
        return createErr(commitResult.err);
      }

      // 4. リモートにpush
      const pushResult = await pushChanges(worktreePath);
      if (isErr(pushResult)) {
        return createErr(pushResult.err);
      }

      return createOk(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return createOk({
        runId: `error-${task.id}`,
        success: false,
        error: errorMessage,
      });
    }
  };

  /**
   * 既存worktreeの状態を維持してタスクを続行
   *
   * WHY: 失敗したタスクを「続きから引き継ぐ」際、既存のworktreeとログを利用して続行する
   *
   * @param task 実行するタスク
   * @returns 実行結果
   */
  const continueTask = async (task: Task): Promise<Result<WorkerResult, OrchestratorError>> => {
    try {
      // 1. 既存worktreeの存在を確認（listWorktreesを使用）
      const worktreesResult = await deps.gitEffects.listWorktrees(deps.appRepoPath);
      if (isErr(worktreesResult)) {
        console.log(`  ⚠️  Failed to list worktrees, falling back to normal execution`);
        // 継続実行に失敗した場合は、依存関係なしとして通常実行
        return await executeTaskWithWorktree(task, { type: 'none' });
      }

      const worktrees = worktreesResult.val;
      const taskWorktree = worktrees.find((wt) => {
        // Worktreeのパスに task.id が含まれているかチェック
        return String(wt.path).includes(String(task.id));
      });

      if (!taskWorktree) {
        console.log(
          `  ⚠️  Worktree for task ${task.id} not found, falling back to normal execution`,
        );
        // 継続実行に失敗した場合は、依存関係なしとして通常実行
        return await executeTaskWithWorktree(task, { type: 'none' });
      }

      const existingWorktreePath = taskWorktree.path;

      // 2. 前回の実行ログを読み込む（存在する場合）
      let previousLog: string | undefined;
      const logFilesResult = await deps.runnerEffects.listRunLogs();
      const logFiles = logFilesResult.ok ? logFilesResult.val : [];

      // タスクIDに関連するログファイルを検索
      const taskLogs = logFiles.filter((logFile) => logFile.includes(String(task.id)));

      if (taskLogs.length > 0) {
        // 最新のログを取得（ファイル名から.logを除去してrunIdとして使用）
        const latestLogFile = taskLogs[taskLogs.length - 1];
        const runIdStr = latestLogFile?.replace('.log', '') ?? '';

        const logContentResult = await deps.runnerEffects.readLog(runIdStr);
        if (logContentResult.ok) {
          previousLog = logContentResult.val;
          console.log(`  📋 Loaded previous execution log: ${latestLogFile}`);
        }
      }

      // 3. エージェントを実行（previousLogをフィードバックとして渡す）
      const runResult = await executeTaskInExistingWorktree(
        task,
        existingWorktreePath,
        previousLog,
      );

      if (isErr(runResult)) {
        return createErr(runResult.err);
      }

      const result = runResult.val;

      if (!result.success) {
        return createOk(result);
      }

      // 4. 変更をコミット
      const commitResult = await commitChanges(task, existingWorktreePath);
      if (isErr(commitResult)) {
        return createErr(commitResult.err);
      }

      // 5. リモートにpush
      const pushResult = await pushChanges(existingWorktreePath);
      if (isErr(pushResult)) {
        return createErr(pushResult.err);
      }

      return createOk(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return createOk({
        runId: `error-${task.id}`,
        success: false,
        error: errorMessage,
      });
    }
  };

  return {
    setupWorktree,
    executeTask,
    executeTaskInExistingWorktree,
    commitChanges,
    pushChanges,
    cleanupWorktree,
    executeTaskWithWorktree,
    continueTask,
  };
};
