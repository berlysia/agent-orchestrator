import { test } from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'fs';
import path from 'path';
import { createFileStore } from '../../src/core/task-store/file-store.ts';
import { createInitialTask, TaskState } from '../../src/types/task.ts';
import { assertOk, assertErr } from '../mocks/effects.ts';
import { taskId, repoPath, branchName } from '../../src/types/branded.ts';

const TEST_BASE_PATH = path.join(process.cwd(), '.tmp', 'test-store');

test('FileStore: CRUD operations', async (t) => {
  await t.test('setup - clean test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    await fs.mkdir(TEST_BASE_PATH, { recursive: true });
  });

  const store = createFileStore({ basePath: TEST_BASE_PATH });

  await t.test('createTask - should create a new task', async () => {
    const task = createInitialTask({
      id: taskId('task-1'),
      repo: repoPath('/path/to/repo'),
      branch: branchName('feat/task-1'),
      scopePaths: ['src/'],
      acceptance: 'Task completed',
      taskType: 'implementation',
      context: 'Test task context',
    });

    const createResult = await store.createTask(task);
    assertOk(createResult);

    const readResult = await store.readTask(taskId('task-1'));
    assertOk(readResult);
    const retrieved = readResult.val;
    assert.strictEqual(retrieved.id, taskId('task-1'));
    assert.strictEqual(retrieved.state, TaskState.READY);
    assert.strictEqual(retrieved.version, 0);
  });

  await t.test('createTask - should fail if task already exists', async () => {
    const task = createInitialTask({
      id: taskId('task-1'),
      repo: repoPath('/path/to/repo'),
      branch: branchName('feat/task-1'),
      scopePaths: ['src/'],
      acceptance: 'Task completed',
      taskType: 'implementation',
      context: 'Test task context',
    });

    const result = await store.createTask(task);
    assertErr(result);
    assert.strictEqual(result.err.type, 'TaskAlreadyExistsError');
  });

  await t.test('listTasks - should return all tasks', async () => {
    const task2 = createInitialTask({
      id: taskId('task-2'),
      repo: repoPath('/path/to/repo'),
      branch: branchName('feat/task-2'),
      scopePaths: ['lib/'],
      acceptance: 'Task 2 completed',
      taskType: 'documentation',
      context: 'Test task 2 context',
    });

    const createResult = await store.createTask(task2);
    assertOk(createResult);

    const listResult = await store.listTasks();
    assertOk(listResult);
    const tasks = listResult.val;
    assert.strictEqual(tasks.length, 2);
    const ids = tasks.map((t) => t.id).sort();
    assert.deepStrictEqual(ids, [taskId('task-1'), taskId('task-2')]);
  });

  await t.test('updateTaskCAS - should update task with correct version', async () => {
    const updateResult = await store.updateTaskCAS(taskId('task-1'), 0, (task) => ({
      ...task,
      state: TaskState.RUNNING,
      owner: 'worker-1',
    }));

    assertOk(updateResult);
    const updated = updateResult.val;
    assert.strictEqual(updated.state, TaskState.RUNNING);
    assert.strictEqual(updated.owner, 'worker-1');
    assert.strictEqual(updated.version, 1);
  });

  await t.test('updateTaskCAS - should fail with wrong version', async () => {
    const result = await store.updateTaskCAS(taskId('task-1'), 0, (task) => ({
      ...task,
      state: TaskState.DONE,
    }));

    assertErr(result);
    assert.strictEqual(result.err.type, 'ConcurrentModificationError');
  });

  await t.test('deleteTask - should delete a task', async () => {
    const deleteResult = await store.deleteTask(taskId('task-2'));
    assertOk(deleteResult);

    const readResult = await store.readTask(taskId('task-2'));
    assertErr(readResult);
    assert.strictEqual(readResult.err.type, 'TaskNotFoundError');
  });

  await t.test('cleanup - remove test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
  });
});
