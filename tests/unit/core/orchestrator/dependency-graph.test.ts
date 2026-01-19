import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildDependencyGraph,
  detectCycles,
  computeExecutionLevels,
} from '../../../../src/core/orchestrator/dependency-graph.ts';
import { createInitialTask } from '../../../../src/types/task.ts';
import { taskId, repoPath, branchName } from '../../../../src/types/branded.ts';

describe('Dependency Graph', () => {
  describe('buildDependencyGraph', () => {
    it('should build graph with no dependencies', () => {
      const tasks = [
        createInitialTask({
          id: taskId('task-1'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [],
        }),
        createInitialTask({
          id: taskId('task-2'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [],
        }),
      ];

      const graph = buildDependencyGraph(tasks);

      assert.strictEqual(graph.allTaskIds.size, 2);
      assert.strictEqual(graph.adjacencyList.get(taskId('task-1'))?.length, 0);
      assert.strictEqual(graph.adjacencyList.get(taskId('task-2'))?.length, 0);
      assert.strictEqual(graph.cyclicDependencies, null);
    });

    it('should build graph with dependencies', () => {
      const tasks = [
        createInitialTask({
          id: taskId('task-1'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [],
        }),
        createInitialTask({
          id: taskId('task-2'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [taskId('task-1')],
        }),
      ];

      const graph = buildDependencyGraph(tasks);

      assert.strictEqual(graph.allTaskIds.size, 2);
      assert.strictEqual(graph.adjacencyList.get(taskId('task-2'))?.length, 1);
      assert.strictEqual(graph.adjacencyList.get(taskId('task-2'))?.[0], taskId('task-1'));
      assert.strictEqual(graph.reverseAdjacencyList.get(taskId('task-1'))?.length, 1);
      assert.strictEqual(graph.reverseAdjacencyList.get(taskId('task-1'))?.[0], taskId('task-2'));
      assert.strictEqual(graph.cyclicDependencies, null);
    });

    it('should detect circular dependencies', () => {
      const tasks = [
        createInitialTask({
          id: taskId('task-1'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [taskId('task-2')],
        }),
        createInitialTask({
          id: taskId('task-2'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [taskId('task-1')],
        }),
      ];

      const graph = buildDependencyGraph(tasks);

      assert(graph.cyclicDependencies !== null);
      assert(graph.cyclicDependencies.length > 0);
      assert(graph.cyclicDependencies.includes(taskId('task-1')));
      assert(graph.cyclicDependencies.includes(taskId('task-2')));
    });
  });

  describe('detectCycles', () => {
    it('should return null when no cycles exist', () => {
      const tasks = [
        createInitialTask({
          id: taskId('task-1'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [],
        }),
        createInitialTask({
          id: taskId('task-2'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [taskId('task-1')],
        }),
      ];

      const graph = buildDependencyGraph(tasks);
      const cycles = detectCycles(graph);

      assert.strictEqual(cycles, null);
    });

    it('should detect simple cycle (A→B→A)', () => {
      const tasks = [
        createInitialTask({
          id: taskId('task-1'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [taskId('task-2')],
        }),
        createInitialTask({
          id: taskId('task-2'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [taskId('task-1')],
        }),
      ];

      const graph = buildDependencyGraph(tasks);
      const cycles = detectCycles(graph);

      assert(cycles !== null);
      assert(cycles.length >= 2);
      assert(cycles.includes(taskId('task-1')));
      assert(cycles.includes(taskId('task-2')));
    });

    it('should detect complex cycle (A→B→C→A)', () => {
      const tasks = [
        createInitialTask({
          id: taskId('task-1'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [taskId('task-2')],
        }),
        createInitialTask({
          id: taskId('task-2'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [taskId('task-3')],
        }),
        createInitialTask({
          id: taskId('task-3'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [taskId('task-1')],
        }),
      ];

      const graph = buildDependencyGraph(tasks);
      const cycles = detectCycles(graph);

      assert(cycles !== null);
      assert(cycles.length >= 3);
      assert(cycles.includes(taskId('task-1')));
      assert(cycles.includes(taskId('task-2')));
      assert(cycles.includes(taskId('task-3')));
    });
  });

  describe('computeExecutionLevels', () => {
    it('should place all tasks at level 0 when no dependencies', () => {
      const tasks = [
        createInitialTask({
          id: taskId('task-1'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [],
        }),
        createInitialTask({
          id: taskId('task-2'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [],
        }),
      ];

      const graph = buildDependencyGraph(tasks);
      const { levels, unschedulable } = computeExecutionLevels(graph);

      assert.strictEqual(levels.length, 1);
      assert.strictEqual(levels[0]?.length, 2);
      assert.strictEqual(unschedulable.length, 0);
    });

    it('should create multiple levels for dependent tasks', () => {
      const tasks = [
        createInitialTask({
          id: taskId('task-1'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [],
        }),
        createInitialTask({
          id: taskId('task-2'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [taskId('task-1')],
        }),
        createInitialTask({
          id: taskId('task-3'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [taskId('task-2')],
        }),
      ];

      const graph = buildDependencyGraph(tasks);
      const { levels, unschedulable } = computeExecutionLevels(graph);

      assert.strictEqual(levels.length, 3);
      assert.strictEqual(levels[0]?.length, 1);
      assert.strictEqual(levels[0]?.[0], taskId('task-1'));
      assert.strictEqual(levels[1]?.length, 1);
      assert.strictEqual(levels[1]?.[0], taskId('task-2'));
      assert.strictEqual(levels[2]?.length, 1);
      assert.strictEqual(levels[2]?.[0], taskId('task-3'));
      assert.strictEqual(unschedulable.length, 0);
    });

    it('should allow parallel execution at same level', () => {
      const tasks = [
        createInitialTask({
          id: taskId('task-1'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [],
        }),
        createInitialTask({
          id: taskId('task-2'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [taskId('task-1')],
        }),
        createInitialTask({
          id: taskId('task-3'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [taskId('task-1')],
        }),
      ];

      const graph = buildDependencyGraph(tasks);
      const { levels, unschedulable } = computeExecutionLevels(graph);

      assert.strictEqual(levels.length, 2);
      assert.strictEqual(levels[0]?.length, 1);
      assert.strictEqual(levels[0]?.[0], taskId('task-1'));
      assert.strictEqual(levels[1]?.length, 2);
      assert(levels[1]?.includes(taskId('task-2')));
      assert(levels[1]?.includes(taskId('task-3')));
      assert.strictEqual(unschedulable.length, 0);
    });

    it('should mark circular dependencies as unschedulable', () => {
      const tasks = [
        createInitialTask({
          id: taskId('task-1'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [taskId('task-2')],
        }),
        createInitialTask({
          id: taskId('task-2'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [taskId('task-1')],
        }),
        createInitialTask({
          id: taskId('task-3'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [],
        }),
      ];

      const graph = buildDependencyGraph(tasks);
      const { levels, unschedulable } = computeExecutionLevels(graph);

      assert(unschedulable.length >= 2);
      assert(unschedulable.includes(taskId('task-1')));
      assert(unschedulable.includes(taskId('task-2')));
      // task-3 should be schedulable
      assert.strictEqual(levels.length, 1);
      assert(levels[0]?.includes(taskId('task-3')));
    });
  });
});
