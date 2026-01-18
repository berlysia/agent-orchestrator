import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { Scheduler } from '../../../../src/core/orchestrator/scheduler.ts';
import { createFileStore } from '../../../../src/core/task-store/file-store.ts';
import type { TaskStore } from '../../../../src/core/task-store/interface.ts';
import { createInitialTask, TaskState } from '../../../../src/types/task.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Scheduler', () => {
  let scheduler: Scheduler;
  let taskStore: TaskStore;
  let tempDir: string;

  beforeEach(async () => {
    // 一時ディレクトリを作成
    tempDir = await mkdtemp(join(tmpdir(), 'scheduler-test-'));
    taskStore = createFileStore({ basePath: tempDir });
    scheduler = new Scheduler({ taskStore, maxWorkers: 2 });
  });

  it('should get ready tasks', async () => {
    // READY状態のタスクを作成
    const task1 = createInitialTask({
      id: 'task-1',
      repo: '/path/to/repo',
      branch: 'feature-1',
      scopePaths: ['src/'],
      acceptance: 'Test acceptance',
    });

    await taskStore.createTask(task1);

    const readyTasks = await scheduler.getReadyTasks();
    assert.strictEqual(readyTasks.length, 1);
    assert.strictEqual(readyTasks[0].id, 'task-1');
    assert.strictEqual(readyTasks[0].state, TaskState.READY);

    // クリーンアップ
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should claim task and update state', async () => {
    // READY状態のタスクを作成
    const task = createInitialTask({
      id: 'task-2',
      repo: '/path/to/repo',
      branch: 'feature-2',
      scopePaths: ['src/'],
      acceptance: 'Test acceptance',
    });

    await taskStore.createTask(task);

    // タスクを割り当て
    const claimedTask = await scheduler.claimTask('task-2', 'worker-1');

    assert.ok(claimedTask);
    assert.strictEqual(claimedTask.state, TaskState.RUNNING);
    assert.strictEqual(claimedTask.owner, 'worker-1');
    assert.strictEqual(scheduler.getRunningWorkerCount(), 1);
    assert.strictEqual(scheduler.getAvailableWorkerSlots(), 1); // maxWorkers=2なので1スロット空き

    // クリーンアップ
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should not claim non-ready task', async () => {
    // RUNNING状態のタスクを作成
    const task = createInitialTask({
      id: 'task-3',
      repo: '/path/to/repo',
      branch: 'feature-3',
      scopePaths: ['src/'],
      acceptance: 'Test acceptance',
    });
    task.state = TaskState.RUNNING;
    task.owner = 'worker-0';

    await taskStore.createTask(task);

    // タスクを割り当て試行（失敗するはず）
    const claimedTask = await scheduler.claimTask('task-3', 'worker-1');

    assert.strictEqual(claimedTask, null);

    // クリーンアップ
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should complete task and free worker slot', async () => {
    // READY状態のタスクを作成して割り当て
    const task = createInitialTask({
      id: 'task-4',
      repo: '/path/to/repo',
      branch: 'feature-4',
      scopePaths: ['src/'],
      acceptance: 'Test acceptance',
    });

    await taskStore.createTask(task);
    await scheduler.claimTask('task-4', 'worker-1');

    assert.strictEqual(scheduler.getRunningWorkerCount(), 1);

    // タスクを完了
    const completedTask = await scheduler.completeTask('task-4');

    assert.strictEqual(completedTask.state, TaskState.DONE);
    assert.strictEqual(completedTask.owner, null);
    assert.strictEqual(scheduler.getRunningWorkerCount(), 0);
    assert.strictEqual(scheduler.getAvailableWorkerSlots(), 2); // 全スロット空き

    // クリーンアップ
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should block task and free worker slot', async () => {
    // READY状態のタスクを作成して割り当て
    const task = createInitialTask({
      id: 'task-5',
      repo: '/path/to/repo',
      branch: 'feature-5',
      scopePaths: ['src/'],
      acceptance: 'Test acceptance',
    });

    await taskStore.createTask(task);
    await scheduler.claimTask('task-5', 'worker-1');

    assert.strictEqual(scheduler.getRunningWorkerCount(), 1);

    // タスクをブロック
    const blockedTask = await scheduler.blockTask('task-5');

    assert.strictEqual(blockedTask.state, TaskState.BLOCKED);
    assert.strictEqual(blockedTask.owner, null);
    assert.strictEqual(scheduler.getRunningWorkerCount(), 0);

    // クリーンアップ
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should respect max worker limit', async () => {
    // 2つのREADY状態のタスクを作成（maxWorkers=2）
    const task1 = createInitialTask({
      id: 'task-6',
      repo: '/path/to/repo',
      branch: 'feature-6',
      scopePaths: ['src/'],
      acceptance: 'Test acceptance',
    });
    const task2 = createInitialTask({
      id: 'task-7',
      repo: '/path/to/repo',
      branch: 'feature-7',
      scopePaths: ['src/'],
      acceptance: 'Test acceptance',
    });

    await taskStore.createTask(task1);
    await taskStore.createTask(task2);

    // 2つのタスクを割り当て
    await scheduler.claimTask('task-6', 'worker-1');
    await scheduler.claimTask('task-7', 'worker-2');

    assert.strictEqual(scheduler.getRunningWorkerCount(), 2);
    assert.strictEqual(scheduler.getAvailableWorkerSlots(), 0); // スロット満杯

    // 1つ完了
    await scheduler.completeTask('task-6');

    assert.strictEqual(scheduler.getRunningWorkerCount(), 1);
    assert.strictEqual(scheduler.getAvailableWorkerSlots(), 1); // 1スロット空き

    // クリーンアップ
    await rm(tempDir, { recursive: true, force: true });
  });
});
