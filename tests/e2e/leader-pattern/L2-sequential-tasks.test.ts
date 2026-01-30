/**
 * L2: 複数タスク順次実行テスト
 *
 * 複雑度: ★★☆☆☆
 * - 2タスク、依存なし
 * - 順次実行（Phase 2 の実装制約により並列実行は Phase 3 以降）
 * - 両タスクが成功
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
  createTestTask,
  addTasksToStore,
} from '../../helpers/test-deps.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST_BASE_PATH = path.join(PROJECT_ROOT, '.tmp', 'test-leader-L2');

describe('L2: Sequential Tasks', () => {
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

  it('should complete multiple independent tasks sequentially', async () => {
    const state = createMockState();
    const deps = createMinimalLeaderDeps(state, {
      testProjectPath,
      coordRepoPath,
    });

    const session = createLeaderSession('test-session-L2', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 2;

    const task1 = createTestTask('task-1', {
      acceptance: 'Create module A',
    });
    const task2 = createTestTask('task-2', {
      acceptance: 'Create module B',
    });

    const tasks = [task1, task2];
    await addTasksToStore(deps, tasks);

    const result = await executeLeaderLoop(deps, session, tasks);

    assert.ok(!isErr(result), 'executeLeaderLoop should succeed');

    if (!isErr(result)) {
      const { session: finalSession, completedTaskIds } = result.val;

      assert.ok(
        finalSession.status === LeaderSessionStatus.COMPLETED ||
        finalSession.status === LeaderSessionStatus.REVIEWING,
        `Expected COMPLETED or REVIEWING, got ${finalSession.status}`,
      );

      assert.strictEqual(completedTaskIds.length, 2, 'Should have 2 completed tasks');
      assert.ok(completedTaskIds.includes('task-1' as any), 'task-1 should be completed');
      assert.ok(completedTaskIds.includes('task-2' as any), 'task-2 should be completed');
    }
  });

  it('should process tasks in order', async () => {
    const state = createMockState();
    const executionOrder: string[] = [];

    const deps = createMinimalLeaderDeps(state, {
      testProjectPath,
      coordRepoPath,
    });

    // workerOps をカスタマイズして実行順序を追跡
    const originalWorkerOps = deps.workerOps;
    deps.workerOps = {
      executeTaskWithWorktree: async (task: any, ...args: any[]) => {
        executionOrder.push(task.id);
        return (originalWorkerOps as any).executeTaskWithWorktree(task, ...args);
      },
    } as any;

    const session = createLeaderSession('test-session-order', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 3;

    const task1 = createTestTask('first');
    const task2 = createTestTask('second');
    const task3 = createTestTask('third');

    const tasks = [task1, task2, task3];
    await addTasksToStore(deps, tasks);

    const result = await executeLeaderLoop(deps, session, tasks);

    assert.ok(!isErr(result));

    // 順次実行のため、タスクは順番に実行される
    assert.strictEqual(executionOrder.length, 3, 'All 3 tasks should be executed');
    assert.strictEqual(executionOrder[0], 'first', 'First task executed first');
    assert.strictEqual(executionOrder[1], 'second', 'Second task executed second');
    assert.strictEqual(executionOrder[2], 'third', 'Third task executed third');
  });

  it('should complete all tasks and return correct count', async () => {
    const state = createMockState();
    const deps = createMinimalLeaderDeps(state, {
      testProjectPath,
      coordRepoPath,
    });

    const session = createLeaderSession('test-session-count', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 3;
    session.completedTaskCount = 0;

    const tasks = [
      createTestTask('count-1'),
      createTestTask('count-2'),
      createTestTask('count-3'),
    ];

    await addTasksToStore(deps, tasks);

    const result = await executeLeaderLoop(deps, session, tasks);

    assert.ok(!isErr(result));

    if (!isErr(result)) {
      const { completedTaskIds } = result.val;

      assert.strictEqual(
        completedTaskIds.length,
        3,
        'Should have 3 completed tasks',
      );
    }
  });
});
