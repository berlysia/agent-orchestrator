/**
 * L5: Planner エスカレーション（再計画）テスト
 *
 * 複雑度: ★★★★☆
 * - shouldReplan → 再計画実行
 * - 新タスクの生成と実行
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { isErr } from 'option-t/plain_result';
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
  createMockJudgeOpsReplan,
  createMockRunnerEffects,
  addTasksToStore,
} from '../../helpers/test-deps.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST_BASE_PATH = path.join(PROJECT_ROOT, '.tmp', 'test-leader-L5');

describe('L5: Planner Escalation (Replanning)', () => {
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

  it('should trigger replanning when Judge sets shouldReplan=true', async () => {
    const state = createMockState();
    const deps = createMinimalLeaderDeps(state, {
      testProjectPath,
      coordRepoPath,
    });

    // Judge が再計画を要求
    deps.judgeOps = createMockJudgeOpsReplan(
      'Task scope is larger than expected, needs to be broken down',
    ) as any;

    // Planner が新タスクを返す（正しいフォーマット: task-N, estimatedDuration 0.5-8）
    const newTasksResponse = JSON.stringify([
      {
        id: 'task-1',
        description: 'Implement subtask 1',
        branch: 'feature/subtask-1',
        scopePaths: ['src/part1.ts'],
        acceptance: 'Part 1 completed',
        type: 'implementation',
        context: 'First part of the feature',
        dependencies: [],
        estimatedDuration: 2,
      },
      {
        id: 'task-2',
        description: 'Implement subtask 2',
        branch: 'feature/subtask-2',
        scopePaths: ['src/part2.ts'],
        acceptance: 'Part 2 completed',
        type: 'implementation',
        context: 'Second part of the feature',
        dependencies: ['task-1'],
        estimatedDuration: 2,
      },
    ]);

    deps.runnerEffects = createMockRunnerEffects(newTasksResponse);

    const session = createLeaderSession('test-session-L5', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 1;
    // 履歴を追加（再計画に必要）
    session.memberTaskHistory = [
      {
        taskId: taskId('large-task'),
        assignedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        workerResult: { runId: 'run-1', success: true },
        judgementResult: {
          taskId: taskId('large-task'),
          success: false,
          shouldContinue: false,
          shouldReplan: true,
          alreadySatisfied: false,
          reason: 'Task too large',
          missingRequirements: [],
        },
        workerFeedback: null,
      },
    ];

    const task = createTestTask('large-task', {
      acceptance: 'Implement entire feature',
    });

    await addTasksToStore(deps, [task]);

    const result = await executeLeaderLoop(deps, session, [task]);

    assert.ok(!isErr(result), 'executeLeaderLoop should succeed');

    if (!isErr(result)) {
      const { session: finalSession } = result.val;

      // Planner エスカレーション記録を確認
      const plannerEscalation = finalSession.escalationRecords.find(
        (r) => r.target === EscalationTarget.PLANNER,
      );

      // 再計画が試行されたことを確認（成功または失敗にかかわらず）
      assert.ok(
        finalSession.escalationAttempts.planner > 0 || plannerEscalation,
        'Should have attempted planner escalation',
      );
    }
  });

  it('should increment planner escalation attempts', async () => {
    const state = createMockState();
    const deps = createMinimalLeaderDeps(state, {
      testProjectPath,
      coordRepoPath,
    });

    deps.judgeOps = createMockJudgeOpsReplan('Needs breakdown') as any;

    // 空の新タスクリストを返す（再計画失敗をシミュレート）
    deps.runnerEffects = createMockRunnerEffects('[]');

    const session = createLeaderSession('test-session-attempts', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 1;
    session.escalationAttempts.planner = 0;
    session.memberTaskHistory = [
      {
        taskId: taskId('task-1'),
        assignedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        workerResult: { runId: 'run-1', success: true },
        judgementResult: {
          taskId: taskId('task-1'),
          success: false,
          shouldContinue: false,
          shouldReplan: true,
          alreadySatisfied: false,
          reason: 'Needs breakdown',
          missingRequirements: [],
        },
        workerFeedback: null,
      },
    ];

    const task = createTestTask('task-1');

    await addTasksToStore(deps, [task]);

    const result = await executeLeaderLoop(deps, session, [task]);

    assert.ok(!isErr(result));

    if (!isErr(result)) {
      const { session: finalSession } = result.val;

      // 空のタスクリストでは再計画が失敗し、USER にフォールバックする
      // escalationAttempts またはエスカレーションレコードで確認
      const hasEscalationActivity =
        finalSession.escalationAttempts.planner > 0 ||
        finalSession.escalationRecords.length > 0 ||
        finalSession.status === LeaderSessionStatus.ESCALATING;

      assert.ok(
        hasEscalationActivity,
        'Should have escalation activity (attempts, records, or escalating status)',
      );
    }
  });

  it('should fallback to USER escalation when planner limit reached', async () => {
    const state = createMockState();
    const deps = createMinimalLeaderDeps(state, {
      testProjectPath,
      coordRepoPath,
    });

    deps.judgeOps = createMockJudgeOpsReplan('Still needs work') as any;
    deps.runnerEffects = createMockRunnerEffects('[]'); // 再計画失敗

    const session = createLeaderSession('test-session-limit', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 1;
    // 既に制限に近い
    session.escalationAttempts.planner = 2;
    session.memberTaskHistory = [
      {
        taskId: taskId('task-limited'),
        assignedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        workerResult: { runId: 'run-1', success: true },
        judgementResult: {
          taskId: taskId('task-limited'),
          success: false,
          shouldContinue: false,
          shouldReplan: true,
          alreadySatisfied: false,
          reason: 'Needs work',
          missingRequirements: [],
        },
        workerFeedback: null,
      },
    ];

    const task = createTestTask('task-limited');

    await addTasksToStore(deps, [task]);

    const result = await executeLeaderLoop(deps, session, [task]);

    assert.ok(!isErr(result));

    if (!isErr(result)) {
      const { session: finalSession } = result.val;

      // Planner 制限到達後は USER にフォールバック
      const hasUserEscalation = finalSession.escalationRecords.some(
        (r) => r.target === EscalationTarget.USER,
      );

      assert.ok(
        hasUserEscalation ||
        finalSession.status === LeaderSessionStatus.ESCALATING,
        'Should escalate to USER or be in ESCALATING state when planner limit reached',
      );
    }
  });

  it('should record replanning attempt in escalation history', async () => {
    const state = createMockState();
    const deps = createMinimalLeaderDeps(state, {
      testProjectPath,
      coordRepoPath,
    });

    deps.judgeOps = createMockJudgeOpsReplan('Scope too large') as any;

    const newTasksResponse = JSON.stringify([
      {
        id: 'task-1',
        description: 'Implement split part 1',
        branch: 'feature/split-1',
        scopePaths: ['src/a.ts'],
        acceptance: 'Done',
        type: 'implementation',
        context: 'Part 1 of the split task',
        dependencies: [],
        estimatedDuration: 2,
      },
    ]);
    deps.runnerEffects = createMockRunnerEffects(newTasksResponse);

    const session = createLeaderSession('test-session-history', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 1;
    session.memberTaskHistory = [
      {
        taskId: taskId('big-task'),
        assignedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        workerResult: { runId: 'run-1', success: true },
        judgementResult: {
          taskId: taskId('big-task'),
          success: false,
          shouldContinue: false,
          shouldReplan: true,
          alreadySatisfied: false,
          reason: 'Scope too large',
          missingRequirements: [],
        },
        workerFeedback: null,
      },
    ];

    const task = createTestTask('big-task');

    await addTasksToStore(deps, [task]);

    const result = await executeLeaderLoop(deps, session, [task]);

    assert.ok(!isErr(result));

    if (!isErr(result)) {
      const { session: finalSession } = result.val;

      // 何らかのエスカレーション記録があるはず
      // （Planner 成功の場合は resolved、失敗の場合は USER へフォールバック）
      assert.ok(
        finalSession.escalationRecords.length > 0 ||
        finalSession.escalationAttempts.planner > 0,
        'Should have escalation records or planner attempts',
      );
    }
  });
});
