import { test } from 'node:test';
import assert from 'node:assert';
import { buildDependencyGraph } from '../../src/core/orchestrator/dependency-graph.ts';
import { createInitialTask, TaskState } from '../../src/types/task.ts';
import { taskId, repoPath, branchName } from '../../src/types/branded.ts';
import type { Task } from '../../src/types/task.ts';

test('DynamicScheduler: dependency graph construction', async (t) => {
  await t.test('should build correct dependency graph for independent tasks', () => {
    const tasks: Task[] = [
      createInitialTask({
        id: taskId('task-1'),
        repo: repoPath('/test'),
        branch: branchName('feat/task-1'),
        scopePaths: ['src/'],
        acceptance: 'Task 1',
        taskType: 'implementation',
        context: 'Context 1',
        dependencies: [],
      }),
      createInitialTask({
        id: taskId('task-2'),
        repo: repoPath('/test'),
        branch: branchName('feat/task-2'),
        scopePaths: ['src/'],
        acceptance: 'Task 2',
        taskType: 'implementation',
        context: 'Context 2',
        dependencies: [],
      }),
    ];

    const graph = buildDependencyGraph(tasks);

    assert.strictEqual(graph.allTaskIds.size, 2);
    assert.strictEqual(graph.adjacencyList.get(taskId('task-1'))?.length, 0);
    assert.strictEqual(graph.adjacencyList.get(taskId('task-2'))?.length, 0);
    assert.strictEqual(graph.cyclicDependencies, null);
  });

  await t.test('should build correct dependency graph for dependent tasks', () => {
    const tasks: Task[] = [
      createInitialTask({
        id: taskId('task-1'),
        repo: repoPath('/test'),
        branch: branchName('feat/task-1'),
        scopePaths: ['src/'],
        acceptance: 'Task 1',
        taskType: 'implementation',
        context: 'Context 1',
        dependencies: [],
      }),
      createInitialTask({
        id: taskId('task-2'),
        repo: repoPath('/test'),
        branch: branchName('feat/task-2'),
        scopePaths: ['src/'],
        acceptance: 'Task 2',
        taskType: 'implementation',
        context: 'Context 2',
        dependencies: [taskId('task-1')],
      }),
    ];

    const graph = buildDependencyGraph(tasks);

    assert.strictEqual(graph.allTaskIds.size, 2);
    assert.strictEqual(graph.adjacencyList.get(taskId('task-2'))?.length, 1);
    assert.strictEqual(graph.adjacencyList.get(taskId('task-2'))?.[0], taskId('task-1'));
    assert.strictEqual(graph.reverseAdjacencyList.get(taskId('task-1'))?.length, 1);
    assert.strictEqual(graph.reverseAdjacencyList.get(taskId('task-1'))?.[0], taskId('task-2'));
  });

  await t.test('should detect circular dependencies', () => {
    const tasks: Task[] = [
      createInitialTask({
        id: taskId('task-1'),
        repo: repoPath('/test'),
        branch: branchName('feat/task-1'),
        scopePaths: ['src/'],
        acceptance: 'Task 1',
        taskType: 'implementation',
        context: 'Context 1',
        dependencies: [taskId('task-2')],
      }),
      createInitialTask({
        id: taskId('task-2'),
        repo: repoPath('/test'),
        branch: branchName('feat/task-2'),
        scopePaths: ['src/'],
        acceptance: 'Task 2',
        taskType: 'implementation',
        context: 'Context 2',
        dependencies: [taskId('task-1')],
      }),
    ];

    const graph = buildDependencyGraph(tasks);

    assert.ok(graph.cyclicDependencies);
    assert.strictEqual(graph.cyclicDependencies?.length, 2);
  });
});

test('DynamicScheduler: parallel execution scenarios', async (t) => {
  await t.test('should identify executable tasks with no dependencies', () => {
    const tasks: Task[] = [
      createInitialTask({
        id: taskId('task-1'),
        repo: repoPath('/test'),
        branch: branchName('feat/task-1'),
        scopePaths: ['src/'],
        acceptance: 'Task 1',
        taskType: 'implementation',
        context: 'Context 1',
        dependencies: [],
      }),
      createInitialTask({
        id: taskId('task-2'),
        repo: repoPath('/test'),
        branch: branchName('feat/task-2'),
        scopePaths: ['src/'],
        acceptance: 'Task 2',
        taskType: 'implementation',
        context: 'Context 2',
        dependencies: [],
      }),
    ];

    const graph = buildDependencyGraph(tasks);

    // タスク1とタスク2の両方が依存なしなので、両方実行可能
    const pendingTasks = new Set([taskId('task-1'), taskId('task-2')]);
    const completedTasks = new Set<typeof taskId extends (arg: string) => infer T ? T : never>();

    const executableTasks = Array.from(pendingTasks).filter((tid) => {
      const dependencies = graph.adjacencyList.get(tid) || [];
      return dependencies.every((depId) => completedTasks.has(depId));
    });

    assert.strictEqual(executableTasks.length, 2);
  });

  await t.test('should identify executable tasks after dependency completes', () => {
    const tasks: Task[] = [
      createInitialTask({
        id: taskId('task-1'),
        repo: repoPath('/test'),
        branch: branchName('feat/task-1'),
        scopePaths: ['src/'],
        acceptance: 'Task 1',
        taskType: 'implementation',
        context: 'Context 1',
        dependencies: [],
      }),
      createInitialTask({
        id: taskId('task-2'),
        repo: repoPath('/test'),
        branch: branchName('feat/task-2'),
        scopePaths: ['src/'],
        acceptance: 'Task 2',
        taskType: 'implementation',
        context: 'Context 2',
        dependencies: [taskId('task-1')],
      }),
    ];

    const graph = buildDependencyGraph(tasks);

    // 初期状態: タスク1のみ実行可能
    const pendingTasks = new Set([taskId('task-1'), taskId('task-2')]);
    let completedTasks = new Set<typeof taskId extends (arg: string) => infer T ? T : never>();

    let executableTasks = Array.from(pendingTasks).filter((tid) => {
      const dependencies = graph.adjacencyList.get(tid) || [];
      return dependencies.every((depId) => completedTasks.has(depId));
    });

    assert.strictEqual(executableTasks.length, 1);
    assert.strictEqual(executableTasks[0], taskId('task-1'));

    // タスク1完了後: タスク2が実行可能になる
    completedTasks.add(taskId('task-1'));
    pendingTasks.delete(taskId('task-1'));

    executableTasks = Array.from(pendingTasks).filter((tid) => {
      const dependencies = graph.adjacencyList.get(tid) || [];
      return dependencies.every((depId) => completedTasks.has(depId));
    });

    assert.strictEqual(executableTasks.length, 1);
    assert.strictEqual(executableTasks[0], taskId('task-2'));
  });

  await t.test('should handle complex dependency chains', () => {
    // Level 0: [A, B]
    // Level 1: [C] (depends on A)
    // Level 2: [D] (depends on C)
    const tasks: Task[] = [
      createInitialTask({
        id: taskId('task-a'),
        repo: repoPath('/test'),
        branch: branchName('feat/task-a'),
        scopePaths: ['src/'],
        acceptance: 'Task A',
        taskType: 'implementation',
        context: 'Context A',
        dependencies: [],
      }),
      createInitialTask({
        id: taskId('task-b'),
        repo: repoPath('/test'),
        branch: branchName('feat/task-b'),
        scopePaths: ['src/'],
        acceptance: 'Task B',
        taskType: 'implementation',
        context: 'Context B',
        dependencies: [],
      }),
      createInitialTask({
        id: taskId('task-c'),
        repo: repoPath('/test'),
        branch: branchName('feat/task-c'),
        scopePaths: ['src/'],
        acceptance: 'Task C',
        taskType: 'implementation',
        context: 'Context C',
        dependencies: [taskId('task-a')],
      }),
      createInitialTask({
        id: taskId('task-d'),
        repo: repoPath('/test'),
        branch: branchName('feat/task-d'),
        scopePaths: ['src/'],
        acceptance: 'Task D',
        taskType: 'implementation',
        context: 'Context D',
        dependencies: [taskId('task-c')],
      }),
    ];

    const graph = buildDependencyGraph(tasks);

    // 初期状態: A, B が実行可能
    const pendingTasks = new Set([
      taskId('task-a'),
      taskId('task-b'),
      taskId('task-c'),
      taskId('task-d'),
    ]);
    const completedTasks = new Set<typeof taskId extends (arg: string) => infer T ? T : never>();

    const executableTasks = Array.from(pendingTasks).filter((tid) => {
      const dependencies = graph.adjacencyList.get(tid) || [];
      return dependencies.every((depId) => completedTasks.has(depId));
    });

    assert.strictEqual(executableTasks.length, 2);
    assert.ok(executableTasks.includes(taskId('task-a')));
    assert.ok(executableTasks.includes(taskId('task-b')));
  });
});

test('DynamicScheduler: state transitions', async (t) => {
  await t.test('should handle task state transitions correctly', () => {
    const task = createInitialTask({
      id: taskId('task-1'),
      repo: repoPath('/test'),
      branch: branchName('feat/task-1'),
      scopePaths: ['src/'],
      acceptance: 'Task 1',
      taskType: 'implementation',
      context: 'Context 1',
      dependencies: [],
    });

    // 初期状態
    assert.strictEqual(task.state, TaskState.READY);

    // READY状態のタスクは実行可能
    const isExecutable =
      task.state === TaskState.READY || task.state === TaskState.NEEDS_CONTINUATION;
    assert.strictEqual(isExecutable, true);
  });
});
