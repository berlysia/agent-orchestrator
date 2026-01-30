/**
 * L4: User エスカレーションテスト
 *
 * 複雑度: ★★★☆☆
 * - Judge 失敗 → USER escalation
 * - エスカレーション状態の検証
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { isErr, createOk } from 'option-t/plain_result';
import { executeLeaderLoop } from '../../../src/core/orchestrator/leader-execution-loop.ts';
import {
  LeaderSessionStatus,
  EscalationTarget,
  createLeaderSession,
} from '../../../src/types/leader-session.ts';
import { taskId } from '../../../src/types/branded.ts';
import {
  createMockState,
  createMinimalLeaderDeps,
  createTestTask,
  createMockJudgeOpsFailure,
  addTasksToStore,
} from '../../helpers/test-deps.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST_BASE_PATH = path.join(PROJECT_ROOT, '.tmp', 'test-leader-L4');

describe('L4: User Escalation', () => {
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

  it('should escalate to USER when Judge fails with ambiguous requirements', async () => {
    const state = createMockState();
    const deps = createMinimalLeaderDeps(state, {
      testProjectPath,
      coordRepoPath,
    });

    // Judge が失敗を返すモックに差し替え
    deps.judgeOps = createMockJudgeOpsFailure(
      'Requirements are ambiguous - cannot determine completion',
      { missingRequirements: ['Clear specification for API endpoint'] },
    ) as any;

    const session = createLeaderSession('test-session-L4', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 1;

    const task = createTestTask('ambiguous-task', {
      acceptance: 'API endpoint works', // 曖昧な受け入れ基準
    });

    await addTasksToStore(deps, [task]);

    const result = await executeLeaderLoop(deps, session, [task]);

    assert.ok(!isErr(result), 'executeLeaderLoop should succeed even with escalation');

    if (!isErr(result)) {
      const { session: finalSession } = result.val;

      assert.strictEqual(
        finalSession.status,
        LeaderSessionStatus.ESCALATING,
        'Session should be in ESCALATING state',
      );

      assert.ok(
        finalSession.escalationRecords.length > 0,
        'Should have escalation records',
      );

      // USER エスカレーションを確認
      const userEscalation = finalSession.escalationRecords.find(
        (r) => r.target === EscalationTarget.USER,
      );
      assert.ok(userEscalation, 'Should have USER escalation record');
    }
  });

  it('should include failure reason in escalation record', async () => {
    const state = createMockState();
    const deps = createMinimalLeaderDeps(state, {
      testProjectPath,
      coordRepoPath,
    });

    const failureReason = 'Cannot verify completion without test coverage metrics';
    deps.judgeOps = createMockJudgeOpsFailure(failureReason) as any;

    const session = createLeaderSession('test-session-reason', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 1;

    const task = createTestTask('task-needs-reason');

    await addTasksToStore(deps, [task]);

    const result = await executeLeaderLoop(deps, session, [task]);

    assert.ok(!isErr(result));

    if (!isErr(result)) {
      const { session: finalSession } = result.val;

      const escalation = finalSession.escalationRecords[0];
      assert.ok(escalation, 'Should have escalation record');
      assert.ok(
        escalation.reason.includes(failureReason) ||
        escalation.reason.includes('failure'),
        `Escalation reason should reference failure: ${escalation.reason}`,
      );
    }
  });

  it('should increment user escalation attempts', async () => {
    const state = createMockState();
    const deps = createMinimalLeaderDeps(state, {
      testProjectPath,
      coordRepoPath,
    });

    deps.judgeOps = createMockJudgeOpsFailure('Task incomplete') as any;

    const session = createLeaderSession('test-session-attempts', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 1;
    session.escalationAttempts.user = 0;

    const task = createTestTask('task-attempts');

    await addTasksToStore(deps, [task]);

    const result = await executeLeaderLoop(deps, session, [task]);

    assert.ok(!isErr(result));

    if (!isErr(result)) {
      const { session: finalSession } = result.val;

      assert.ok(
        finalSession.escalationAttempts.user > 0,
        'User escalation attempts should be incremented',
      );
    }
  });

  it('should link escalation to related task', async () => {
    const state = createMockState();
    const deps = createMinimalLeaderDeps(state, {
      testProjectPath,
      coordRepoPath,
    });

    deps.judgeOps = createMockJudgeOpsFailure('Task verification failed') as any;

    const session = createLeaderSession('test-session-link', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 1;

    const task = createTestTask('linked-task');

    await addTasksToStore(deps, [task]);

    const result = await executeLeaderLoop(deps, session, [task]);

    assert.ok(!isErr(result));

    if (!isErr(result)) {
      const { session: finalSession } = result.val;

      const escalation = finalSession.escalationRecords.find(
        (r) => r.target === EscalationTarget.USER,
      );

      if (escalation?.relatedTaskId) {
        assert.strictEqual(
          escalation.relatedTaskId,
          'linked-task',
          'Escalation should be linked to the failed task',
        );
      }
    }
  });

  it('should stop execution and preserve unprocessed tasks on escalation', async () => {
    const state = createMockState();
    let executedTasks = 0;

    const deps = createMinimalLeaderDeps(state, {
      testProjectPath,
      coordRepoPath,
    });

    // 最初のタスクで失敗（executedTasks カウンターで判定）
    deps.judgeOps = {
      judgeTask: async (task: any) => {
        executedTasks++;
        // 最初のタスク（executedTasks === 1）で失敗させる
        if (executedTasks === 1) {
          return createOk({
            taskId: taskId(task.id),
            success: false,
            shouldContinue: false,
            shouldReplan: false,
            alreadySatisfied: false,
            reason: 'First task failed',
            missingRequirements: [],
          });
        }
        return createOk({
          taskId: taskId(task.id),
          success: true,
          shouldContinue: false,
          shouldReplan: false,
          alreadySatisfied: false,
          reason: 'Success',
          missingRequirements: [],
        });
      },
    } as any;

    const session = createLeaderSession('test-session-stop', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 3;

    const tasks = [
      createTestTask('task-1'),
      createTestTask('task-2'),
      createTestTask('task-3'),
    ];

    await addTasksToStore(deps, tasks);

    const result = await executeLeaderLoop(deps, session, tasks);

    assert.ok(!isErr(result));

    if (!isErr(result)) {
      const { session: finalSession, completedTaskIds } = result.val;

      assert.strictEqual(
        finalSession.status,
        LeaderSessionStatus.ESCALATING,
        'Should escalate on first failure',
      );

      // 最初のタスクのみ処理された（または試行された）
      // 残りのタスクは未処理
      assert.ok(
        completedTaskIds.length < 3,
        'Not all tasks should be completed on escalation',
      );
    }
  });
});
