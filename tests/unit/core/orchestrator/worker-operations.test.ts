import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import {
  createWorkerOperations,
  type WorkerDeps,
} from '../../../../src/core/orchestrator/worker-operations.ts';
import { createInitialTask } from '../../../../src/types/task.ts';
import { TaskState } from '../../../../src/types/task.ts';
import { taskId, branchName, repoPath, worktreePath } from '../../../../src/types/branded.ts';
import { createOk, createErr } from 'option-t/plain_result';
import { gitCommandFailed } from '../../../../src/types/errors.ts';
import type { TaskStore } from '../../../../src/core/task-store/interface.ts';
import type { RunnerEffects } from '../../../../src/core/runner/runner-effects.ts';
import type { GitEffects } from '../../../../src/adapters/vcs/git-effects.ts';
import { createDefaultConfig } from '../../../../src/types/config.ts';

/**
 * GitEffectsモックを生成
 */
const createMockGitEffects = (): GitEffects => ({
  getCurrentBranch: mock.fn(async () => createOk(branchName('main'))),
  listBranches: mock.fn(async () => createOk([])),
  createBranch: mock.fn(async () => createOk(branchName('feature/test'))),
  deleteBranch: mock.fn(async () => createOk(undefined)),
  switchBranch: mock.fn(async () => createOk(undefined)),
  createWorktree: mock.fn(),
  removeWorktree: mock.fn(async () => createOk(undefined)),
  pruneWorktrees: mock.fn(async () => createOk(undefined)),
  listWorktrees: mock.fn(async () => createOk([])),
  getWorktreePath: mock.fn(async () => createOk(worktreePath('/tmp/worktree'))),
  stageAll: mock.fn(async () => createOk(undefined)),
  stageFiles: mock.fn(async () => createOk(undefined)),
  commit: mock.fn(async () => createOk(undefined)),
  push: mock.fn(async () => createOk(undefined)),
  pull: mock.fn(async () => createOk(undefined)),
  hasRemote: mock.fn(async () => createOk(true)),
  merge: mock.fn(),
  rebase: mock.fn(async () => createOk(undefined)),
  abortMerge: mock.fn(async () => createOk(undefined)),
  getStatus: mock.fn(async () =>
    createOk({
      staged: ['src/index.ts'],
      modified: [],
      untracked: [],
      currentBranch: branchName('main'),
    }),
  ),
  getDiff: mock.fn(async () => createOk('')),
  getConflictContent: mock.fn(),
  getConflictedFiles: mock.fn(async () => createOk([])),
  markConflictResolved: mock.fn(async () => createOk(undefined)),
  raw: mock.fn(async () => createOk('')),
});

const createMockTaskStore = (): TaskStore => ({
  readTask: mock.fn(),
  updateTaskCAS: mock.fn(),
  listTasks: mock.fn(),
  createTask: mock.fn(),
  deleteTask: mock.fn(),
  writeRun: mock.fn(),
  writeCheck: mock.fn(),
});

const createMockRunnerEffects = (): RunnerEffects => ({
  readLog: mock.fn(async () => createOk('')),
  runClaudeAgent: mock.fn(),
  runCodexAgent: mock.fn(),
  ensureRunsDir: mock.fn(),
  initializeLogFile: mock.fn(),
  appendLog: mock.fn(),
  saveRunMetadata: mock.fn(),
  loadRunMetadata: mock.fn(),
  listRunLogs: mock.fn(),
});

describe('Worker Operations', () => {
  describe('commitChanges - stageFiles fallback', () => {
    it('should fallback to stageAll when stageFiles fails', async () => {
      // scopePathsが存在しないディレクトリを指している場合のテスト
      const tid = taskId('task-1');
      const task = createInitialTask({
        id: tid,
        repo: repoPath('/app'),
        branch: branchName('feature/test'),
        scopePaths: ['tests/nonexistent/'], // 存在しないパス
        acceptance: 'Feature works correctly',
        context: 'Test context',
        taskType: 'implementation',
      });
      task.state = TaskState.RUNNING;

      const mockGitEffects = createMockGitEffects();

      // カウンターでモック呼び出しを追跡
      let stageFilesCallCount = 0;
      let stageAllCallCount = 0;

      // stageFilesはエラーを返す（パスが存在しない）
      mockGitEffects.stageFiles = async () => {
        stageFilesCallCount++;
        return createErr(gitCommandFailed('stageFiles', 'fatal: pathspec did not match any files', -1));
      };

      // stageAllは成功する
      mockGitEffects.stageAll = async () => {
        stageAllCallCount++;
        return createOk(undefined);
      };

      const deps: WorkerDeps = {
        gitEffects: mockGitEffects,
        runnerEffects: createMockRunnerEffects(),
        taskStore: createMockTaskStore(),
        appRepoPath: repoPath('/app'),
        agentCoordPath: '/home/user/.agent',
        agentType: 'claude',
        model: 'sonnet',
        config: createDefaultConfig({ appRepoPath: '/app', agentCoordPath: '/home/user/.agent' }),
      };

      const workerOps = createWorkerOperations(deps);
      const wtPath = worktreePath('/tmp/worktree');

      const result = await workerOps.commitChanges(task, wtPath);

      // stageFilesが呼ばれたことを確認
      assert.strictEqual(stageFilesCallCount, 1);

      // stageAllがフォールバックとして呼ばれたことを確認
      assert.strictEqual(stageAllCallCount, 1);

      // commitChangesが成功したことを確認
      assert.strictEqual(result.ok, true);
    });

    it('should return error when both stageFiles and stageAll fail', async () => {
      const tid = taskId('task-2');
      const task = createInitialTask({
        id: tid,
        repo: repoPath('/app'),
        branch: branchName('feature/test'),
        scopePaths: ['tests/nonexistent/'],
        acceptance: 'Feature works correctly',
        context: 'Test context',
        taskType: 'implementation',
      });
      task.state = TaskState.RUNNING;

      const mockGitEffects = createMockGitEffects();

      let stageFilesCallCount = 0;
      let stageAllCallCount = 0;

      // stageFilesはエラーを返す
      mockGitEffects.stageFiles = async () => {
        stageFilesCallCount++;
        return createErr(gitCommandFailed('stageFiles', 'fatal: pathspec did not match any files', -1));
      };

      // stageAllもエラーを返す
      mockGitEffects.stageAll = async () => {
        stageAllCallCount++;
        return createErr(gitCommandFailed('stageAll', 'fatal: unable to stage changes', -1));
      };

      const deps: WorkerDeps = {
        gitEffects: mockGitEffects,
        runnerEffects: createMockRunnerEffects(),
        taskStore: createMockTaskStore(),
        appRepoPath: repoPath('/app'),
        agentCoordPath: '/home/user/.agent',
        agentType: 'claude',
        model: 'sonnet',
        config: createDefaultConfig({ appRepoPath: '/app', agentCoordPath: '/home/user/.agent' }),
      };

      const workerOps = createWorkerOperations(deps);
      const wtPath = worktreePath('/tmp/worktree');

      const result = await workerOps.commitChanges(task, wtPath);

      // stageFilesが呼ばれたことを確認
      assert.strictEqual(stageFilesCallCount, 1);

      // stageAllがフォールバックとして呼ばれたことを確認
      assert.strictEqual(stageAllCallCount, 1);

      // commitChangesがエラーを返したことを確認
      assert.strictEqual(result.ok, false);
    });

    it('should not use fallback when stageFiles succeeds', async () => {
      const tid = taskId('task-3');
      const task = createInitialTask({
        id: tid,
        repo: repoPath('/app'),
        branch: branchName('feature/test'),
        scopePaths: ['src/'],
        acceptance: 'Feature works correctly',
        context: 'Test context',
        taskType: 'implementation',
      });
      task.state = TaskState.RUNNING;

      const mockGitEffects = createMockGitEffects();

      let stageFilesCallCount = 0;
      let stageAllCallCount = 0;

      // stageFilesは成功する
      mockGitEffects.stageFiles = async () => {
        stageFilesCallCount++;
        return createOk(undefined);
      };

      // stageAllも定義（呼ばれないはず）
      mockGitEffects.stageAll = async () => {
        stageAllCallCount++;
        return createOk(undefined);
      };

      const deps: WorkerDeps = {
        gitEffects: mockGitEffects,
        runnerEffects: createMockRunnerEffects(),
        taskStore: createMockTaskStore(),
        appRepoPath: repoPath('/app'),
        agentCoordPath: '/home/user/.agent',
        agentType: 'claude',
        model: 'sonnet',
        config: createDefaultConfig({ appRepoPath: '/app', agentCoordPath: '/home/user/.agent' }),
      };

      const workerOps = createWorkerOperations(deps);
      const wtPath = worktreePath('/tmp/worktree');

      const result = await workerOps.commitChanges(task, wtPath);

      // stageFilesが呼ばれたことを確認
      assert.strictEqual(stageFilesCallCount, 1);

      // stageAllはフォールバックとして呼ばれていないことを確認
      // WHY: stageFilesが成功し、変更がステージングされている場合はstageAllは不要
      assert.strictEqual(stageAllCallCount, 0);

      // commitChangesが成功したことを確認
      assert.strictEqual(result.ok, true);
    });

    it('should use stageAll directly when scopePaths is empty', async () => {
      const tid = taskId('task-4');
      const task = createInitialTask({
        id: tid,
        repo: repoPath('/app'),
        branch: branchName('feature/test'),
        scopePaths: [], // 空のscopePaths
        acceptance: 'Feature works correctly',
        context: 'Test context',
        taskType: 'implementation',
      });
      task.state = TaskState.RUNNING;

      const mockGitEffects = createMockGitEffects();

      let stageFilesCallCount = 0;
      let stageAllCallCount = 0;

      // stageFilesは定義（呼ばれないはず）
      mockGitEffects.stageFiles = async () => {
        stageFilesCallCount++;
        return createOk(undefined);
      };

      // stageAllは成功する
      mockGitEffects.stageAll = async () => {
        stageAllCallCount++;
        return createOk(undefined);
      };

      const deps: WorkerDeps = {
        gitEffects: mockGitEffects,
        runnerEffects: createMockRunnerEffects(),
        taskStore: createMockTaskStore(),
        appRepoPath: repoPath('/app'),
        agentCoordPath: '/home/user/.agent',
        agentType: 'claude',
        model: 'sonnet',
        config: createDefaultConfig({ appRepoPath: '/app', agentCoordPath: '/home/user/.agent' }),
      };

      const workerOps = createWorkerOperations(deps);
      const wtPath = worktreePath('/tmp/worktree');

      const result = await workerOps.commitChanges(task, wtPath);

      // stageFilesは呼ばれないことを確認
      assert.strictEqual(stageFilesCallCount, 0);

      // stageAllが呼ばれたことを確認
      assert.strictEqual(stageAllCallCount, 1);

      // commitChangesが成功したことを確認
      assert.strictEqual(result.ok, true);
    });

    it('should handle combined fallback scenario: stageFiles error -> stageAll success -> staged=0 -> existing fallback', async () => {
      // WHY: stageFilesエラー → 新フォールバックでstageAll（staged=0） → 既存フォールバックで再stageAll
      //      stageAllは冪等なので、2回実行しても安全
      const tid = taskId('task-5');
      const task = createInitialTask({
        id: tid,
        repo: repoPath('/app'),
        branch: branchName('feature/test'),
        scopePaths: ['tests/nonexistent/'],
        acceptance: 'Feature works correctly',
        context: 'Test context',
        taskType: 'implementation',
      });
      task.state = TaskState.RUNNING;

      const mockGitEffects = createMockGitEffects();

      let stageFilesCallCount = 0;
      let stageAllCallCount = 0;
      let getStatusCallCount = 0;

      // stageFilesはエラーを返す
      mockGitEffects.stageFiles = async () => {
        stageFilesCallCount++;
        return createErr(gitCommandFailed('stageFiles', 'fatal: pathspec did not match any files', -1));
      };

      // stageAllは成功する（冪等なので何度呼んでも同じ結果）
      mockGitEffects.stageAll = async () => {
        stageAllCallCount++;
        return createOk(undefined);
      };

      // getStatusは常にstaged=0を返す
      // WHY: このケースでは実際に変更がないので、最終的にwarningが出力される
      mockGitEffects.getStatus = async () => {
        getStatusCallCount++;
        return createOk({
          staged: [], // 常にstaged=0
          modified: [],
          untracked: [],
          currentBranch: branchName('main'),
        });
      };

      const deps: WorkerDeps = {
        gitEffects: mockGitEffects,
        runnerEffects: createMockRunnerEffects(),
        taskStore: createMockTaskStore(),
        appRepoPath: repoPath('/app'),
        agentCoordPath: '/home/user/.agent',
        agentType: 'claude',
        model: 'sonnet',
        config: createDefaultConfig({ appRepoPath: '/app', agentCoordPath: '/home/user/.agent' }),
      };

      const workerOps = createWorkerOperations(deps);
      const wtPath = worktreePath('/tmp/worktree');

      const result = await workerOps.commitChanges(task, wtPath);

      // stageFilesが1回呼ばれたことを確認
      assert.strictEqual(stageFilesCallCount, 1);

      // stageAllが2回呼ばれたことを確認（新フォールバック + 既存フォールバック）
      // WHY: stageAllは冪等なので、2回実行しても安全
      assert.strictEqual(stageAllCallCount, 2);

      // getStatusが2回呼ばれたことを確認（既存フォールバック前後）
      assert.strictEqual(getStatusCallCount, 2);

      // commitChangesは成功（変更がなくてもエラーではない）
      // WHY: Workerが既にコミットした場合や、変更がない場合も正常として扱う
      assert.strictEqual(result.ok, true);
    });

    it('should handle stageFiles error -> stageAll success -> staged>0 (no existing fallback needed)', async () => {
      // WHY: stageFilesエラー → 新フォールバックでstageAll（staged>0） → 既存フォールバックは不要
      const tid = taskId('task-6');
      const task = createInitialTask({
        id: tid,
        repo: repoPath('/app'),
        branch: branchName('feature/test'),
        scopePaths: ['tests/nonexistent/'],
        acceptance: 'Feature works correctly',
        context: 'Test context',
        taskType: 'implementation',
      });
      task.state = TaskState.RUNNING;

      const mockGitEffects = createMockGitEffects();

      let stageFilesCallCount = 0;
      let stageAllCallCount = 0;

      // stageFilesはエラーを返す
      mockGitEffects.stageFiles = async () => {
        stageFilesCallCount++;
        return createErr(gitCommandFailed('stageFiles', 'fatal: pathspec did not match any files', -1));
      };

      // stageAllは成功する
      mockGitEffects.stageAll = async () => {
        stageAllCallCount++;
        return createOk(undefined);
      };

      // getStatusはstaged>0を返す（変更がステージングされている）
      mockGitEffects.getStatus = async () =>
        createOk({
          staged: ['src/index.ts'], // 変更あり
          modified: [],
          untracked: [],
          currentBranch: branchName('main'),
        });

      const deps: WorkerDeps = {
        gitEffects: mockGitEffects,
        runnerEffects: createMockRunnerEffects(),
        taskStore: createMockTaskStore(),
        appRepoPath: repoPath('/app'),
        agentCoordPath: '/home/user/.agent',
        agentType: 'claude',
        model: 'sonnet',
        config: createDefaultConfig({ appRepoPath: '/app', agentCoordPath: '/home/user/.agent' }),
      };

      const workerOps = createWorkerOperations(deps);
      const wtPath = worktreePath('/tmp/worktree');

      const result = await workerOps.commitChanges(task, wtPath);

      // stageFilesが1回呼ばれたことを確認
      assert.strictEqual(stageFilesCallCount, 1);

      // stageAllが1回だけ呼ばれたことを確認（新フォールバックのみ、既存フォールバックは不要）
      assert.strictEqual(stageAllCallCount, 1);

      // commitChangesが成功したことを確認
      assert.strictEqual(result.ok, true);
    });
  });
});
