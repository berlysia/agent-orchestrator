import { test } from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'fs';
import path from 'path';
import { createFileStore, FileStoreError } from '../../src/core/task-store/file-store.ts';
import { createInitialTask, TaskState } from '../../src/types/task.ts';

const TEST_BASE_PATH = path.join(process.cwd(), '.tmp', 'test-store');

test('FileStore: CRUD operations', async (t) => {
  await t.test('setup - clean test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    await fs.mkdir(TEST_BASE_PATH, { recursive: true });
  });

  const store = createFileStore({ basePath: TEST_BASE_PATH });

  await t.test('createTask - should create a new task', async () => {
    const task = createInitialTask({
      id: 'task-1',
      repo: '/path/to/repo',
      branch: 'feat/task-1',
      scopePaths: ['src/'],
      acceptance: 'Task completed',
    });

    await store.createTask(task);

    const retrieved = await store.readTask('task-1');
    assert.strictEqual(retrieved.id, 'task-1');
    assert.strictEqual(retrieved.state, TaskState.READY);
    assert.strictEqual(retrieved.version, 0);
  });

  await t.test('createTask - should fail if task already exists', async () => {
    const task = createInitialTask({
      id: 'task-1',
      repo: '/path/to/repo',
      branch: 'feat/task-1',
      scopePaths: ['src/'],
      acceptance: 'Task completed',
    });

    await assert.rejects(async () => await store.createTask(task), FileStoreError);
  });

  await t.test('listTasks - should return all tasks', async () => {
    const task2 = createInitialTask({
      id: 'task-2',
      repo: '/path/to/repo',
      branch: 'feat/task-2',
      scopePaths: ['lib/'],
      acceptance: 'Task 2 completed',
    });

    await store.createTask(task2);

    const tasks = await store.listTasks();
    assert.strictEqual(tasks.length, 2);
    const ids = tasks.map((t) => t.id).sort();
    assert.deepStrictEqual(ids, ['task-1', 'task-2']);
  });

  await t.test('updateTaskCAS - should update task with correct version', async () => {
    const updated = await store.updateTaskCAS('task-1', 0, (task) => ({
      ...task,
      state: TaskState.RUNNING,
      owner: 'worker-1',
    }));

    assert.strictEqual(updated.state, TaskState.RUNNING);
    assert.strictEqual(updated.owner, 'worker-1');
    assert.strictEqual(updated.version, 1);
  });

  await t.test('updateTaskCAS - should fail with wrong version', async () => {
    await assert.rejects(
      async () =>
        await store.updateTaskCAS('task-1', 0, (task) => ({
          ...task,
          state: TaskState.DONE,
        })),
      FileStoreError,
    );
  });

  await t.test('deleteTask - should delete a task', async () => {
    await store.deleteTask('task-2');

    await assert.rejects(async () => await store.readTask('task-2'), FileStoreError);
  });

  await t.test('cleanup - remove test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
  });
});
