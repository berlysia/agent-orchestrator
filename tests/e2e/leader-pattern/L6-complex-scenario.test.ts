/**
 * L6: 複合シナリオテスト
 *
 * 複雑度: ★★★★★
 * - 依存関係 + エスカレーション + 再開
 * - 複数のエスカレーションタイプの組み合わせ
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { isErr, createOk } from 'option-t/plain_result';
import { executeLeaderLoop } from '../../../src/core/orchestrator/leader-execution-loop.ts';
import {
  resolveEscalation,
  resumeFromEscalation,
} from '../../../src/core/orchestrator/leader-escalation.ts';
import {
  LeaderSessionStatus,
  EscalationTarget,
  createLeaderSession,
} from '../../../src/types/leader-session.ts';
import {
  createMockState,
  createMinimalLeaderDeps,
  createDetailedLeaderDeps,
  createDependentTasks,
  createTestTask,
  createMockJudgeOpsFailure,
  taskId,
  addTasksToStore,
} from '../../helpers/test-deps.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST_BASE_PATH = path.join(PROJECT_ROOT, '.tmp', 'test-leader-L6');

describe('L6: Complex Scenario', () => {
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

  it('should handle partial success with escalation mid-execution', async () => {
    const state = createMockState();
    let taskIndex = 0;

    const deps = createMinimalLeaderDeps(state, {
      testProjectPath,
      coordRepoPath,
    });

    // 最初の2タスクは成功、3番目で失敗
    deps.judgeOps = {
      judgeTask: async (task: any) => {
        taskIndex++;
        if (taskIndex <= 2) {
          return createOk({
            taskId: taskId(task.id),
            success: true,
            shouldContinue: false,
            shouldReplan: false,
            alreadySatisfied: false,
            reason: 'Success',
            missingRequirements: [],
          });
        }
        return createOk({
          taskId: taskId(task.id),
          success: false,
          shouldContinue: false,
          shouldReplan: false,
          alreadySatisfied: false,
          reason: 'Third task failed',
          missingRequirements: ['More details needed'],
        });
      },
    } as any;

    const session = createLeaderSession('test-session-partial', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 3;

    const tasks = createDependentTasks([
      { id: 'task-1' },
      { id: 'task-2', dependencies: ['task-1'] },
      { id: 'task-3', dependencies: ['task-2'] },
    ]);

    await addTasksToStore(deps, tasks);

    const result = await executeLeaderLoop(deps, session, tasks);

    assert.ok(!isErr(result));

    if (!isErr(result)) {
      const { session: finalSession, completedTaskIds } = result.val;

      // 最初の2タスクは完了
      assert.strictEqual(completedTaskIds.length, 2, '2 tasks should be completed');
      assert.ok(completedTaskIds.includes('task-1' as any));
      assert.ok(completedTaskIds.includes('task-2' as any));

      // 3番目でエスカレーション
      assert.strictEqual(finalSession.status, LeaderSessionStatus.ESCALATING);
    }
  });

  it('should resume execution after escalation resolution', async () => {
    const deps = createDetailedLeaderDeps();

    // 既にエスカレーション中のセッションを作成
    const session = createLeaderSession('test-session-resume', '/test/plan.md');
    session.status = LeaderSessionStatus.ESCALATING;

    // 未解決のエスカレーションを追加
    const escalation = {
      id: 'esc-1',
      target: EscalationTarget.USER,
      reason: 'Requirements unclear',
      relatedTaskId: taskId('task-3'),
      escalatedAt: new Date().toISOString(),
      resolved: false,
      resolvedAt: null,
      resolution: null,
    };
    session.escalationRecords = [escalation];

    // エスカレーションを解決
    const resolveResult = await resolveEscalation(
      deps,
      session,
      'esc-1',
      'User provided clarification: Use REST API with JSON response',
    );

    assert.ok(resolveResult.ok, 'resolveEscalation should succeed');

    if (resolveResult.ok) {
      const resolvedSession = resolveResult.val;

      // 解決後は REVIEWING 状態に
      assert.strictEqual(
        resolvedSession.escalationRecords[0]?.resolved,
        true,
        'Escalation should be resolved',
      );
      assert.strictEqual(
        resolvedSession.status,
        LeaderSessionStatus.REVIEWING,
        'Session should be in REVIEWING state',
      );

      // 再開
      const resumeResult = await resumeFromEscalation(deps, resolvedSession);

      assert.ok(resumeResult.ok, 'resumeFromEscalation should succeed');

      if (resumeResult.ok) {
        assert.strictEqual(
          resumeResult.val.status,
          LeaderSessionStatus.EXECUTING,
          'Session should be back to EXECUTING',
        );
      }
    }
  });

  it('should handle multiple escalations in sequence', async () => {
    const state = createMockState();
    let judgeCallCount = 0;

    const deps = createMinimalLeaderDeps(state, {
      testProjectPath,
      coordRepoPath,
    });

    // 各タスクが異なる理由で失敗
    deps.judgeOps = {
      judgeTask: async (task: any) => {
        judgeCallCount++;
        return createOk({
          taskId: taskId(task.id),
          success: false,
          shouldContinue: false,
          shouldReplan: judgeCallCount === 2, // 2番目だけ再計画を要求
          alreadySatisfied: false,
          reason: `Task ${task.id} failed: reason ${judgeCallCount}`,
          missingRequirements: [],
        });
      },
    } as any;

    const session = createLeaderSession('test-session-multi-esc', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 1;

    const task = createTestTask('multi-fail-task');

    await addTasksToStore(deps, [task]);

    const result = await executeLeaderLoop(deps, session, [task]);

    assert.ok(!isErr(result));

    if (!isErr(result)) {
      const { session: finalSession } = result.val;

      assert.strictEqual(
        finalSession.status,
        LeaderSessionStatus.ESCALATING,
        'Should end in ESCALATING state',
      );

      // エスカレーション試行があったことを確認
      const totalAttempts =
        finalSession.escalationAttempts.user +
        finalSession.escalationAttempts.planner +
        finalSession.escalationAttempts.logicValidator;

      assert.ok(totalAttempts > 0, 'Should have escalation attempts');
    }
  });

  it('should preserve session state across escalation-resume cycle', async () => {
    const deps = createDetailedLeaderDeps();

    const session = createLeaderSession('test-session-state', '/test/plan.md');
    session.status = LeaderSessionStatus.ESCALATING;
    session.completedTaskCount = 2;
    session.totalTaskCount = 4;
    session.memberTaskHistory = [
      {
        taskId: taskId('done-1'),
        assignedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        workerResult: { runId: 'run-1', success: true },
        judgementResult: {
          taskId: taskId('done-1'),
          success: true,
          shouldContinue: false,
          shouldReplan: false,
          alreadySatisfied: false,
          reason: 'Success',
          missingRequirements: [],
        },
        workerFeedback: null,
      },
      {
        taskId: taskId('done-2'),
        assignedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        workerResult: { runId: 'run-2', success: true },
        judgementResult: {
          taskId: taskId('done-2'),
          success: true,
          shouldContinue: false,
          shouldReplan: false,
          alreadySatisfied: false,
          reason: 'Success',
          missingRequirements: [],
        },
        workerFeedback: null,
      },
    ];

    // エスカレーションを追加して解決
    const escalation = {
      id: 'esc-state',
      target: EscalationTarget.USER,
      reason: 'Need clarification',
      relatedTaskId: taskId('pending-3'),
      escalatedAt: new Date().toISOString(),
      resolved: false,
      resolvedAt: null,
      resolution: null,
    };
    session.escalationRecords = [escalation];

    // 解決
    const resolveResult = await resolveEscalation(
      deps,
      session,
      'esc-state',
      'Clarified',
    );

    assert.ok(resolveResult.ok);

    if (resolveResult.ok) {
      const resolvedSession = resolveResult.val;

      // 状態が保持されていることを確認
      assert.strictEqual(resolvedSession.completedTaskCount, 2);
      assert.strictEqual(resolvedSession.totalTaskCount, 4);
      assert.strictEqual(resolvedSession.memberTaskHistory.length, 2);

      // 再開
      const resumeResult = await resumeFromEscalation(deps, resolvedSession);

      assert.ok(resumeResult.ok);

      if (resumeResult.ok) {
        // 再開後も状態が保持
        assert.strictEqual(resumeResult.val.completedTaskCount, 2);
        assert.strictEqual(resumeResult.val.memberTaskHistory.length, 2);
      }
    }
  });

  it('should track escalation history for debugging', async () => {
    const state = createMockState();
    const deps = createMinimalLeaderDeps(state, {
      testProjectPath,
      coordRepoPath,
    });

    deps.judgeOps = createMockJudgeOpsFailure('Complex failure scenario') as any;

    const session = createLeaderSession('test-session-debug', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 1;

    const task = createTestTask('debug-task');

    await addTasksToStore(deps, [task]);

    const result = await executeLeaderLoop(deps, session, [task]);

    assert.ok(!isErr(result));

    if (!isErr(result)) {
      const { session: finalSession } = result.val;

      // デバッグに必要な情報が含まれていることを確認
      for (const record of finalSession.escalationRecords) {
        assert.ok(record.id, 'Escalation should have ID');
        assert.ok(record.escalatedAt, 'Escalation should have timestamp');
        assert.ok(record.reason, 'Escalation should have reason');
        assert.ok(record.target, 'Escalation should have target');
      }

      // memberTaskHistory も検証
      for (const history of finalSession.memberTaskHistory) {
        assert.ok(history.taskId, 'History should have taskId');
        assert.ok(history.assignedAt, 'History should have assignedAt');
      }
    }
  });
});
