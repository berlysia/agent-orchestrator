/**
 * L3: 依存関係チェーンテスト
 *
 * 複雑度: ★★★☆☆
 * - task-1 → task-2 の順序実行
 * - 依存関係が尊重されることを確認
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { isErr } from 'option-t/plain_result';
import { executeLeaderLoop } from '../../../src/core/orchestrator/leader-execution-loop.ts';
import { LeaderSessionStatus, createLeaderSession } from '../../../src/types/leader-session.ts';
import {
  createMockState,
  createMinimalLeaderDeps,
  createDependentTasks,
  addTasksToStore,
} from '../../helpers/test-deps.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST_BASE_PATH = path.join(PROJECT_ROOT, '.tmp', 'test-leader-L3');

describe('L3: Dependent Tasks', () => {
  let testProjectPath: string;
  let coordRepoPath: string;

  beforeEach(async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    await fs.mkdir(TEST_BASE_PATH, { recursive: true });

    testProjectPath = path.join(TEST_BASE_PATH, 'test-project');
    coordRepoPath = path.join(TEST_BASE_PATH, 'coord-repo');

    await fs.mkdir(testProjectPath, { recursive: true });
    await fs.mkdir(coordRepoPath, { recursive: true });
    await fs.mkdir(path.join(coordRepoPath, 'tasks'), { recursive: true });
    await fs.mkdir(path.join(coordRepoPath, 'leader-sessions'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
  });

  it('should execute tasks respecting dependency order', async () => {
    const state = createMockState();
    const executionOrder: string[] = [];

    const deps = createMinimalLeaderDeps(state, {
      testProjectPath,
      coordRepoPath,
    });

    // workerOps をカスタマイズして実行順序を追跡
    deps.workerOps = {
      executeTaskWithWorktree: async (task: any) => {
        executionOrder.push(task.id);
        return { ok: true, val: { runId: 'run-' + task.id, success: true, checkFixRunIds: [] } } as any;
      },
    } as any;

    const session = createLeaderSession('test-session-L3', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 2;

    // task-2 は task-1 に依存
    const tasks = createDependentTasks([
      { id: 'task-1', acceptance: 'Create types' },
      { id: 'task-2', dependencies: ['task-1'], acceptance: 'Use types' },
    ]);

    await addTasksToStore(deps, tasks);

    const result = await executeLeaderLoop(deps, session, tasks);

    assert.ok(!isErr(result), 'executeLeaderLoop should succeed');

    // 依存関係により、task-1 が先に実行される
    assert.strictEqual(executionOrder[0], 'task-1', 'task-1 should execute first');
    assert.strictEqual(executionOrder[1], 'task-2', 'task-2 should execute after task-1');
  });

  it('should handle chain of dependencies (A → B → C)', async () => {
    const state = createMockState();
    const executionOrder: string[] = [];

    const deps = createMinimalLeaderDeps(state, {
      testProjectPath,
      coordRepoPath,
    });

    deps.workerOps = {
      executeTaskWithWorktree: async (task: any) => {
        executionOrder.push(task.id);
        return { ok: true, val: { runId: 'run-' + task.id, success: true, checkFixRunIds: [] } } as any;
      },
    } as any;

    const session = createLeaderSession('test-session-chain', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 3;

    // A → B → C のチェーン
    const tasks = createDependentTasks([
      { id: 'task-A', acceptance: 'Setup schema' },
      { id: 'task-B', dependencies: ['task-A'], acceptance: 'Create repository' },
      { id: 'task-C', dependencies: ['task-B'], acceptance: 'Add API' },
    ]);

    await addTasksToStore(deps, tasks);

    const result = await executeLeaderLoop(deps, session, tasks);

    assert.ok(!isErr(result));

    assert.deepStrictEqual(
      executionOrder,
      ['task-A', 'task-B', 'task-C'],
      'Tasks should execute in dependency order',
    );
  });

  it('should complete all tasks in dependency chain', async () => {
    const state = createMockState();
    const deps = createMinimalLeaderDeps(state, {
      testProjectPath,
      coordRepoPath,
    });

    const session = createLeaderSession('test-session-complete', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 3;

    const tasks = createDependentTasks([
      { id: 'base' },
      { id: 'middle', dependencies: ['base'] },
      { id: 'final', dependencies: ['middle'] },
    ]);

    await addTasksToStore(deps, tasks);

    const result = await executeLeaderLoop(deps, session, tasks);

    assert.ok(!isErr(result));

    if (!isErr(result)) {
      const { session: finalSession, completedTaskIds } = result.val;

      assert.strictEqual(completedTaskIds.length, 3, 'All 3 tasks should be completed');
      assert.ok(completedTaskIds.includes('base' as any));
      assert.ok(completedTaskIds.includes('middle' as any));
      assert.ok(completedTaskIds.includes('final' as any));

      assert.ok(
        finalSession.status === LeaderSessionStatus.COMPLETED ||
        finalSession.status === LeaderSessionStatus.REVIEWING,
      );
    }
  });

  it('should handle diamond dependency (A,B → C)', async () => {
    const state = createMockState();
    const executionOrder: string[] = [];

    const deps = createMinimalLeaderDeps(state, {
      testProjectPath,
      coordRepoPath,
    });

    deps.workerOps = {
      executeTaskWithWorktree: async (task: any) => {
        executionOrder.push(task.id);
        return { ok: true, val: { runId: 'run-' + task.id, success: true, checkFixRunIds: [] } } as any;
      },
    } as any;

    const session = createLeaderSession('test-session-diamond', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 3;

    // task-C depends on both task-A and task-B
    const tasks = createDependentTasks([
      { id: 'task-A' },
      { id: 'task-B' },
      { id: 'task-C', dependencies: ['task-A', 'task-B'] },
    ]);

    await addTasksToStore(deps, tasks);

    const result = await executeLeaderLoop(deps, session, tasks);

    assert.ok(!isErr(result));

    // task-C は task-A と task-B の両方が完了後に実行される
    const taskCIndex = executionOrder.indexOf('task-C' as any);
    const taskAIndex = executionOrder.indexOf('task-A' as any);
    const taskBIndex = executionOrder.indexOf('task-B' as any);

    assert.ok(taskCIndex > taskAIndex, 'task-C should execute after task-A');
    assert.ok(taskCIndex > taskBIndex, 'task-C should execute after task-B');
  });
});
