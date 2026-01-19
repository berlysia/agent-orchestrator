import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { createIntegrationOperations } from '../../../../src/core/orchestrator/integration-operations.ts';
import type { Task } from '../../../../src/types/task.ts';
import { createInitialTask, TaskState } from '../../../../src/types/task.ts';
import { taskId, repoPath, branchName } from '../../../../src/types/branded.ts';
import { createOk, createErr } from 'option-t/plain_result';
import type { MergeResult } from '../../../../src/types/integration.ts';

describe('Integration Operations', () => {
  describe('integrateTasks', () => {
    it('should successfully integrate tasks without conflicts', async () => {
      // モックの依存関係
      const mockTaskStore = {
        createTask: mock.fn(async (task: Task) => createOk(undefined)),
        readTask: mock.fn(async (id) =>
          createErr({ type: 'TaskNotFoundError', taskId: id, message: 'Not found' }),
        ),
      };

      const mockGitEffects = {
        createBranch: mock.fn(async () => createOk(branchName('integration/merge-123'))),
        switchBranch: mock.fn(async () => createOk(undefined)),
        merge: mock.fn(async () => {
          const mergeResult: MergeResult = {
            success: true,
            mergedFiles: ['file1.ts', 'file2.ts'],
            hasConflicts: false,
            conflicts: [],
            status: 'success',
          };
          return createOk(mergeResult);
        }),
        abortMerge: mock.fn(async () => createOk(undefined)),
        getConflictedFiles: mock.fn(async () => createOk([])),
        getConflictContent: mock.fn(async () =>
          createErr({
            type: 'GitCommandFailedError',
            command: 'show',
            stderr: '',
            exitCode: 1,
            message: '',
          }),
        ),
        getCurrentBranch: mock.fn(async () => createOk(branchName('main'))),
        hasRemote: mock.fn(async () => createOk(false)),
      };

      const integrationOps = createIntegrationOperations({
        taskStore: mockTaskStore as any,
        gitEffects: mockGitEffects as any,
        appRepoPath: '/test/repo',
      });

      // テスト用のタスク
      const task1 = createInitialTask({
        id: taskId('task-1'),
        repo: repoPath('/test/repo'),
        branch: branchName('feature/task-1'),
        scopePaths: ['src/file1.ts'],
        acceptance: 'Task 1 complete',
        taskType: 'implementation',
        context: 'Test task 1',
      });

      const task2 = createInitialTask({
        id: taskId('task-2'),
        repo: repoPath('/test/repo'),
        branch: branchName('feature/task-2'),
        scopePaths: ['src/file2.ts'],
        acceptance: 'Task 2 complete',
        taskType: 'implementation',
        context: 'Test task 2',
      });

      const baseBranch = branchName('main');
      const result = await integrationOps.integrateTasks([task1, task2], baseBranch);

      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.strictEqual(result.val.success, true);
        assert.strictEqual(result.val.integratedTaskIds.length, 2);
        assert.strictEqual(result.val.conflictedTaskIds.length, 0);
        assert.strictEqual(result.val.conflictResolutionTaskId, null);
      }

      // createBranch, switchBranch, mergeが呼ばれたことを確認
      assert.strictEqual(mockGitEffects.createBranch.mock.calls.length, 1);
      assert.strictEqual(mockGitEffects.switchBranch.mock.calls.length, 2);
      assert.strictEqual(mockGitEffects.merge.mock.calls.length, 2);
    });

    it('should detect conflicts and create resolution task', async () => {
      // モックの依存関係
      const mockTaskStore = {
        createTask: mock.fn(async (task: Task) => createOk(undefined)),
        readTask: mock.fn(async (id) =>
          createErr({ type: 'TaskNotFoundError', taskId: id, message: 'Not found' }),
        ),
      };

      const mockGitEffects = {
        createBranch: mock.fn(async () => createOk(branchName('integration/merge-123'))),
        switchBranch: mock.fn(async () => createOk(undefined)),
        merge: mock.fn(async () => {
          const mergeResult: MergeResult = {
            success: false,
            mergedFiles: [],
            hasConflicts: true,
            conflicts: [{ reason: 'merge conflict', filePath: 'src/shared.ts', type: 'content' }],
            status: 'conflicts',
          };
          return createOk(mergeResult);
        }),
        abortMerge: mock.fn(async () => createOk(undefined)),
        getConflictedFiles: mock.fn(async () => createOk(['src/shared.ts'])),
        getConflictContent: mock.fn(async (path, filePath) => {
          return createOk({
            filePath,
            oursContent: 'const x = 1;',
            theirsContent: 'const x = 2;',
            baseContent: 'const x = 0;',
            theirBranch: branchName('feature/task-2'),
          });
        }),
        getCurrentBranch: mock.fn(async () => createOk(branchName('integration/merge-123'))),
        hasRemote: mock.fn(async () => createOk(false)),
      };

      const integrationOps = createIntegrationOperations({
        taskStore: mockTaskStore as any,
        gitEffects: mockGitEffects as any,
        appRepoPath: '/test/repo',
      });

      // テスト用のタスク（両方とも同じファイルを変更）
      const task1 = createInitialTask({
        id: taskId('task-1'),
        repo: repoPath('/test/repo'),
        branch: branchName('feature/task-1'),
        scopePaths: ['src/shared.ts'],
        acceptance: 'Task 1 complete',
        taskType: 'implementation',
        context: 'Test task 1',
      });

      const task2 = createInitialTask({
        id: taskId('task-2'),
        repo: repoPath('/test/repo'),
        branch: branchName('feature/task-2'),
        scopePaths: ['src/shared.ts'],
        acceptance: 'Task 2 complete',
        taskType: 'implementation',
        context: 'Test task 2',
      });

      const baseBranch = branchName('main');
      const result = await integrationOps.integrateTasks([task1, task2], baseBranch);

      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.strictEqual(result.val.success, false);
        assert.strictEqual(result.val.conflictedTaskIds.length, 2);
        assert.notStrictEqual(result.val.conflictResolutionTaskId, null);
      }

      // abortMergeが呼ばれたことを確認
      assert.strictEqual(mockGitEffects.abortMerge.mock.calls.length, 2);
    });
  });

  describe('buildConflictResolutionPrompt', () => {
    it('should build a comprehensive conflict resolution prompt', async () => {
      const mockTaskStore = {
        createTask: mock.fn(async (task: Task) => createOk(undefined)),
      };

      const mockGitEffects = {
        getCurrentBranch: mock.fn(async () => createOk(branchName('main'))),
        hasRemote: mock.fn(async () => createOk(false)),
      };

      const integrationOps = createIntegrationOperations({
        taskStore: mockTaskStore as any,
        gitEffects: mockGitEffects as any,
        appRepoPath: '/test/repo',
      });

      const conflictInfo = [
        {
          taskId: taskId('task-1'),
          sourceBranch: branchName('feature/task-1'),
          targetBranch: branchName('integration/merge-123'),
          conflicts: [
            { reason: 'merge conflict', filePath: 'src/file.ts', type: 'content' as const },
          ],
          conflictContents: [
            {
              filePath: 'src/file.ts',
              oursContent: 'const x = 1;',
              theirsContent: 'const x = 2;',
              baseContent: 'const x = 0;',
              theirBranch: branchName('feature/task-1'),
            },
          ],
        },
      ];

      const prompt = await integrationOps.buildConflictResolutionPrompt(conflictInfo);

      assert(prompt.includes('Merge Conflict Resolution'));
      assert(prompt.includes('task-1'));
      assert(prompt.includes('src/file.ts'));
      assert(prompt.includes('const x = 1;'));
      assert(prompt.includes('const x = 2;'));
      assert(prompt.includes('const x = 0;'));
    });
  });

  describe('finalizeIntegration', () => {
    it('should return command when method is "command"', async () => {
      const mockTaskStore = {
        createTask: mock.fn(async (task: Task) => createOk(undefined)),
      };

      const mockGitEffects = {
        getCurrentBranch: mock.fn(async () => createOk(branchName('main'))),
        hasRemote: mock.fn(async () => createOk(false)),
      };

      const integrationOps = createIntegrationOperations({
        taskStore: mockTaskStore as any,
        gitEffects: mockGitEffects as any,
        appRepoPath: '/test/repo',
      });

      const result = await integrationOps.finalizeIntegration(
        branchName('integration/merge-123'),
        branchName('main'),
        { method: 'command' },
      );

      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.strictEqual(result.val.method, 'command');
        assert(result.val.mergeCommand?.includes('git checkout main'));
        assert(result.val.mergeCommand?.includes('git merge integration/merge-123'));
      }
    });

    it('should return command when method is "auto" and no remote', async () => {
      const mockTaskStore = {
        createTask: mock.fn(async (task: Task) => createOk(undefined)),
      };

      const mockGitEffects = {
        getCurrentBranch: mock.fn(async () => createOk(branchName('main'))),
        hasRemote: mock.fn(async () => createOk(false)),
      };

      const integrationOps = createIntegrationOperations({
        taskStore: mockTaskStore as any,
        gitEffects: mockGitEffects as any,
        appRepoPath: '/test/repo',
      });

      const result = await integrationOps.finalizeIntegration(
        branchName('integration/merge-123'),
        branchName('main'),
        { method: 'auto' },
      );

      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.strictEqual(result.val.method, 'command');
      }
    });

    it('should return error when method is "pr" but no remote', async () => {
      const mockTaskStore = {
        createTask: mock.fn(async (task: Task) => createOk(undefined)),
      };

      const mockGitEffects = {
        getCurrentBranch: mock.fn(async () => createOk(branchName('main'))),
        hasRemote: mock.fn(async () => createOk(false)),
      };

      const integrationOps = createIntegrationOperations({
        taskStore: mockTaskStore as any,
        gitEffects: mockGitEffects as any,
        appRepoPath: '/test/repo',
      });

      const result = await integrationOps.finalizeIntegration(
        branchName('integration/merge-123'),
        branchName('main'),
        { method: 'pr' },
      );

      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert(result.err.message.includes('remote'));
      }
    });
  });
});
