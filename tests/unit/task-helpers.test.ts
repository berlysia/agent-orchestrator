import { test } from 'node:test';
import assert from 'node:assert';
import {
  loadTasks,
  collectCompletedTaskSummaries,
  collectFailedTaskDescriptions,
} from '../../src/core/orchestrator/task-helpers.ts';
import { createInitialTask } from '../../src/types/task.ts';
import { taskId, repoPath, branchName, runId } from '../../src/types/branded.ts';
import type { TaskStore } from '../../src/core/task-store/interface.ts';
import type { TaskStoreError } from '../../src/types/errors.ts';
import type { RunnerEffects } from '../../src/core/runner/runner-effects.ts';
import { createOk, createErr } from 'option-t/plain_result';

test('task-helpers', async (t) => {
  await t.test('loadTasks - should load all tasks successfully', async () => {
    const task1 = createInitialTask({
      id: taskId('task-1'),
      repo: repoPath('/repo'),
      branch: branchName('feat/task-1'),
      scopePaths: ['src/'],
      acceptance: 'Task 1 completed',
      taskType: 'implementation',
      context: 'Context 1',
    });

    const task2 = createInitialTask({
      id: taskId('task-2'),
      repo: repoPath('/repo'),
      branch: branchName('feat/task-2'),
      scopePaths: ['lib/'],
      acceptance: 'Task 2 completed',
      taskType: 'documentation',
      context: 'Context 2',
    });

    const mockTaskStore: TaskStore = {
      readTask: async (id) => {
        if (id === taskId('task-1')) return createOk(task1);
        if (id === taskId('task-2')) return createOk(task2);
        return createErr({ type: 'TaskNotFoundError', message: 'Not found' } as TaskStoreError);
      },
    } as TaskStore;

    const result = await loadTasks(['task-1', 'task-2'], mockTaskStore);

    assert.strictEqual(result.tasks.length, 2);
    assert.strictEqual(result.failedTaskIds.length, 0);
    assert.strictEqual(result.tasks[0]?.id, taskId('task-1'));
    assert.strictEqual(result.tasks[1]?.id, taskId('task-2'));
  });

  await t.test('loadTasks - should handle failed task loads', async () => {
    const task1 = createInitialTask({
      id: taskId('task-1'),
      repo: repoPath('/repo'),
      branch: branchName('feat/task-1'),
      scopePaths: ['src/'],
      acceptance: 'Task 1 completed',
      taskType: 'implementation',
      context: 'Context 1',
    });

    const mockTaskStore: TaskStore = {
      readTask: async (id) => {
        if (id === taskId('task-1')) return createOk(task1);
        if (id === taskId('task-2'))
          return createErr({ type: 'TaskNotFoundError', message: 'Not found' } as TaskStoreError);
        return createErr({ type: 'TaskNotFoundError', message: 'Not found' } as TaskStoreError);
      },
    } as TaskStore;

    const result = await loadTasks(['task-1', 'task-2', 'task-3'], mockTaskStore);

    assert.strictEqual(result.tasks.length, 1);
    assert.strictEqual(result.failedTaskIds.length, 2);
    assert.strictEqual(result.tasks[0]?.id, taskId('task-1'));
    assert.deepStrictEqual(result.failedTaskIds, ['task-2', 'task-3']);
  });

  await t.test('collectCompletedTaskSummaries - should collect summaries with run metadata', async () => {
    const task1 = createInitialTask({
      id: taskId('task-1'),
      repo: repoPath('/repo'),
      branch: branchName('feat/task-1'),
      scopePaths: ['src/'],
      acceptance: 'Task 1 acceptance',
      taskType: 'implementation',
      context: 'Context 1',
    });
    task1.latestRunId = runId('run-1');

    const task2 = createInitialTask({
      id: taskId('task-2'),
      repo: repoPath('/repo'),
      branch: branchName('feat/task-2'),
      scopePaths: ['lib/'],
      acceptance: 'Task 2 acceptance',
      taskType: 'documentation',
      context: 'Context 2',
    });
    task2.latestRunId = runId('run-2');

    const mockTaskStore: TaskStore = {
      readTask: async (id) => {
        if (id === taskId('task-1')) return createOk(task1);
        if (id === taskId('task-2')) return createOk(task2);
        return createErr({ type: 'TaskNotFoundError', message: 'Not found' } as TaskStoreError);
      },
    } as TaskStore;

    const mockRunnerEffects: RunnerEffects = {
      loadRunMetadata: async (id) => {
        if (id === runId('run-1')) {
          return createOk({ status: 'success', errorMessage: undefined } as any);
        }
        if (id === runId('run-2')) {
          return createOk({ status: 'failed', errorMessage: 'Some error' } as any);
        }
        return createErr(new Error('Run not found'));
      },
    } as RunnerEffects;

    const result = await collectCompletedTaskSummaries(
      ['task-1', 'task-2'],
      mockTaskStore,
      mockRunnerEffects,
    );

    assert.strictEqual(result.descriptions.length, 2);
    assert.strictEqual(result.descriptions[0], '[task-1] Task 1 acceptance');
    assert.strictEqual(result.descriptions[1], '[task-2] Task 2 acceptance');

    assert.strictEqual(result.runSummaries.length, 2);
    assert.strictEqual(result.runSummaries[0], '[task-1] Status: success');
    assert.strictEqual(result.runSummaries[1], '[task-2] Status: failed, Error: Some error');
  });

  await t.test('collectCompletedTaskSummaries - should handle tasks without run metadata', async () => {
    const task1 = createInitialTask({
      id: taskId('task-1'),
      repo: repoPath('/repo'),
      branch: branchName('feat/task-1'),
      scopePaths: ['src/'],
      acceptance: 'Task 1 acceptance',
      taskType: 'implementation',
      context: 'Context 1',
    });
    // latestRunId is undefined

    const mockTaskStore: TaskStore = {
      readTask: async (id) => {
        if (id === taskId('task-1')) return createOk(task1);
        return createErr({ type: 'TaskNotFoundError', message: 'Not found' } as TaskStoreError);
      },
    } as TaskStore;

    const mockRunnerEffects: RunnerEffects = {} as RunnerEffects;

    const result = await collectCompletedTaskSummaries(['task-1'], mockTaskStore, mockRunnerEffects);

    assert.strictEqual(result.descriptions.length, 1);
    assert.strictEqual(result.descriptions[0], '[task-1] Task 1 acceptance');
    assert.strictEqual(result.runSummaries.length, 0);
  });

  await t.test('collectFailedTaskDescriptions - should collect failed task descriptions', async () => {
    const task1 = createInitialTask({
      id: taskId('task-1'),
      repo: repoPath('/repo'),
      branch: branchName('feat/task-1'),
      scopePaths: ['src/'],
      acceptance: 'Task 1 failed',
      taskType: 'implementation',
      context: 'Context 1',
    });

    const task2 = createInitialTask({
      id: taskId('task-2'),
      repo: repoPath('/repo'),
      branch: branchName('feat/task-2'),
      scopePaths: ['lib/'],
      acceptance: '',
      taskType: 'documentation',
      context: 'Context 2',
    });

    const mockTaskStore: TaskStore = {
      readTask: async (id) => {
        if (id === taskId('task-1')) return createOk(task1);
        if (id === taskId('task-2')) return createOk(task2);
        return createErr({ type: 'TaskNotFoundError', message: 'Not found' } as TaskStoreError);
      },
    } as TaskStore;

    const result = await collectFailedTaskDescriptions(['task-1', 'task-2'], mockTaskStore);

    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0], '[task-1] Task 1 failed');
    assert.strictEqual(result[1], '[task-2] feat/task-2'); // Falls back to branch name
  });

  await t.test('collectFailedTaskDescriptions - should handle task not found', async () => {
    const mockTaskStore = {
      readTask: async () =>
        createErr({ type: 'TaskNotFoundError', message: 'Not found' } as TaskStoreError),
    } as unknown as TaskStore;

    const result = await collectFailedTaskDescriptions(['task-1', 'task-2'], mockTaskStore);

    assert.strictEqual(result.length, 0);
  });
});
