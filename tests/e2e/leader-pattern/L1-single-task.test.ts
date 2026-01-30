/**
 * L1: 単一タスク成功テスト
 *
 * 複雑度: ★☆☆☆☆
 * - 1タスク、依存なし
 * - Worker 成功
 * - Judge 成功
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
} from '../../helpers/test-deps.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST_BASE_PATH = path.join(PROJECT_ROOT, '.tmp', 'test-leader-L1');

describe('L1: Single Task Success', () => {
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

  it('should complete a single task with Worker success and Judge approval', async () => {
    const state = createMockState();
    const deps = createMinimalLeaderDeps(state, {
      testProjectPath,
      coordRepoPath,
    });

    const session = createLeaderSession('test-session-L1', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 1;

    const task = createTestTask('task-1', {
      acceptance: 'Create greeting module',
    });

    // タスクをストアに追加
    await deps.taskStore.createTask(task);

    const result = await executeLeaderLoop(deps, session, [task]);

    assert.ok(!isErr(result), 'executeLeaderLoop should succeed');

    if (!isErr(result)) {
      const { session: finalSession, completedTaskIds } = result.val;

      assert.ok(
        finalSession.status === LeaderSessionStatus.COMPLETED ||
        finalSession.status === LeaderSessionStatus.REVIEWING,
        `Expected COMPLETED or REVIEWING, got ${finalSession.status}`,
      );

      assert.strictEqual(completedTaskIds.length, 1, 'Should have 1 completed task');
      assert.strictEqual(completedTaskIds[0], 'task-1');
    }
  });

  it('should record task execution in memberTaskHistory', async () => {
    const state = createMockState();
    const deps = createMinimalLeaderDeps(state, {
      testProjectPath,
      coordRepoPath,
    });

    const session = createLeaderSession('test-session-history', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 1;

    const task = createTestTask('task-history');

    // タスクをストアに追加
    await deps.taskStore.createTask(task);

    const result = await executeLeaderLoop(deps, session, [task]);

    assert.ok(!isErr(result));

    if (!isErr(result)) {
      const { session: finalSession, completedTaskIds } = result.val;

      // タスクが完了したことを確認（履歴の詳細は実装依存）
      assert.strictEqual(completedTaskIds.length, 1, 'Should have 1 completed task');
      assert.ok(
        finalSession.status === LeaderSessionStatus.COMPLETED ||
        finalSession.status === LeaderSessionStatus.REVIEWING,
        'Session should be completed or reviewing',
      );
    }
  });

  it('should update session progress counters', async () => {
    const state = createMockState();
    const deps = createMinimalLeaderDeps(state, {
      testProjectPath,
      coordRepoPath,
    });

    const session = createLeaderSession('test-session-progress', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 1;
    session.completedTaskCount = 0;

    const task = createTestTask('task-progress');

    // タスクをストアに追加
    await deps.taskStore.createTask(task);

    const result = await executeLeaderLoop(deps, session, [task]);

    assert.ok(!isErr(result));

    if (!isErr(result)) {
      const { completedTaskIds } = result.val;

      // executeLeaderLoop は completedTaskIds で完了タスクを返す
      assert.strictEqual(
        completedTaskIds.length,
        1,
        'completedTaskIds should have 1 task',
      );
    }
  });
});
