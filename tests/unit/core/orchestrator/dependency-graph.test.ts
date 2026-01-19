import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildDependencyGraph,
  detectCycles,
  computeExecutionLevels,
  detectSerialChains,
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

  describe('detectSerialChains', () => {
    it('should return empty array when no serial chains exist', () => {
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
      const chains = detectSerialChains(graph);

      assert.strictEqual(chains.length, 0);
    });

    it('should detect simple serial chain (A→B)', () => {
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
      const chains = detectSerialChains(graph);

      assert.strictEqual(chains.length, 1);
      assert.strictEqual(chains[0]?.length, 2);
      assert.strictEqual(chains[0]?.[0], taskId('task-1'));
      assert.strictEqual(chains[0]?.[1], taskId('task-2'));
    });

    it('should detect long serial chain (A→B→C→D)', () => {
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
        createInitialTask({
          id: taskId('task-4'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [taskId('task-3')],
        }),
      ];

      const graph = buildDependencyGraph(tasks);
      const chains = detectSerialChains(graph);

      assert.strictEqual(chains.length, 1);
      assert.strictEqual(chains[0]?.length, 4);
      assert.strictEqual(chains[0]?.[0], taskId('task-1'));
      assert.strictEqual(chains[0]?.[1], taskId('task-2'));
      assert.strictEqual(chains[0]?.[2], taskId('task-3'));
      assert.strictEqual(chains[0]?.[3], taskId('task-4'));
    });

    it('should detect multiple serial chains', () => {
      const tasks = [
        // Chain 1: task-1 → task-2
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
        // Chain 2: task-3 → task-4
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
        createInitialTask({
          id: taskId('task-4'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [taskId('task-3')],
        }),
      ];

      const graph = buildDependencyGraph(tasks);
      const chains = detectSerialChains(graph);

      assert.strictEqual(chains.length, 2);
      // チェーンの順序は保証されないので、内容で検証
      const chain1 = chains.find((c) => c.includes(taskId('task-1')));
      const chain2 = chains.find((c) => c.includes(taskId('task-3')));

      assert(chain1 !== undefined);
      assert.strictEqual(chain1.length, 2);
      assert(chain2 !== undefined);
      assert.strictEqual(chain2.length, 2);
    });

    it('should not detect serial chain when task has multiple dependents (A→B←C)', () => {
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
          dependencies: [],
        }),
        createInitialTask({
          id: taskId('task-4'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [taskId('task-2'), taskId('task-3')],
        }),
      ];

      const graph = buildDependencyGraph(tasks);
      const chains = detectSerialChains(graph);

      // task-1→task-2は検出されるが、task-2→task-4は検出されない（task-4は複数の依存元を持つ）
      assert.strictEqual(chains.length, 1);
      assert.strictEqual(chains[0]?.length, 2);
      assert.strictEqual(chains[0]?.[0], taskId('task-1'));
      assert.strictEqual(chains[0]?.[1], taskId('task-2'));
    });

    it('should handle mixed serial chains and parallel tasks', () => {
      const tasks = [
        // Serial chain: task-1 → task-2 → task-3
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
        // Parallel tasks
        createInitialTask({
          id: taskId('task-4'),
          repo: repoPath('/repo'),
          branch: branchName('main'),
          scopePaths: ['src/'],
          acceptance: 'test',
          taskType: 'implementation',
          context: 'test',
          dependencies: [],
        }),
        createInitialTask({
          id: taskId('task-5'),
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
      const chains = detectSerialChains(graph);

      assert.strictEqual(chains.length, 1);
      assert.strictEqual(chains[0]?.length, 3);
      assert.strictEqual(chains[0]?.[0], taskId('task-1'));
      assert.strictEqual(chains[0]?.[1], taskId('task-2'));
      assert.strictEqual(chains[0]?.[2], taskId('task-3'));
    });
  });
});
