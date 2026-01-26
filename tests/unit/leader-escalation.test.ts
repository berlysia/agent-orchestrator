import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { createOk, createErr } from 'option-t/plain_result';
import {
  createEscalationRecord,
  handleUserEscalation,
  handlePlannerEscalation,
  handleTechnicalEscalation,
  getEscalationHistory,
  getPendingEscalations,
} from '../../src/core/orchestrator/leader-escalation.ts';
import {
  createLeaderSession,
  LeaderSessionStatus,
  EscalationTarget,
} from '../../src/types/leader-session.ts';
import { taskId } from '../../src/types/branded.ts';
import { createInitialTask } from '../../src/types/task.ts';
import { ioError, agentExecutionError } from '../../src/types/errors.ts';
import type { LeaderDeps } from '../../src/core/orchestrator/leader-operations.ts';
import type { TaskStore } from '../../src/core/task-store/interface.ts';
import type { RunnerEffects } from '../../src/core/runner/runner-effects.ts';
import type { LeaderSessionEffects } from '../../src/core/orchestrator/leader-session-effects.ts';

describe('leader-escalation', () => {
  // テスト用の LeaderDeps を作成
  const createTestDeps = (overrides?: Partial<LeaderDeps>): LeaderDeps => {
    const taskStore: TaskStore = {
      createTask: async (_task) => createOk(undefined),
      readTask: async (id: any) =>
        createOk(
          createInitialTask({
            id,
            repo: '/test/repo' as any,
            branch: 'test-branch' as any,
            scopePaths: ['test.ts'],
            acceptance: 'Test acceptance',
            taskType: 'implementation',
            context: 'Test context',
            dependencies: [],
          }),
        ),
      updateTaskCAS: async (_id: any, _version, updater) => {
        const task = createInitialTask({
          id: taskId('test-1'),
          repo: '/test/repo' as any,
          branch: 'test-branch' as any,
          scopePaths: ['test.ts'],
          acceptance: 'Test acceptance',
          taskType: 'implementation',
          context: 'Test context',
          dependencies: [],
        });
        return createOk(updater(task));
      },
      listTasks: async () => createOk([]),
      claimTask: async (id: any) => createOk({ taskId: id, acquired: true }),
      setTaskOwner: async (id: any) =>
        createOk(
          createInitialTask({
            id,
            repo: '/test/repo' as any,
            branch: 'test-branch' as any,
            scopePaths: ['test.ts'],
            acceptance: 'Test acceptance',
            taskType: 'implementation',
            context: 'Test context',
            dependencies: [],
          }),
        ),
      deleteTask: async () => createOk(undefined),
      writeRun: async () => createOk(undefined),
      writeCheck: async () => createOk(undefined),
    } as TaskStore;

    const runnerEffects: RunnerEffects = {
      runClaudeAgent: async () =>
        createOk({ finalResponse: JSON.stringify([]) }),
      runCodexAgent: async () => createOk({ finalResponse: JSON.stringify([]) }),
      ensureRunsDir: async () => createOk(undefined),
      initializeLogFile: async () => createOk(undefined),
      appendLog: async () => createOk(undefined),
      saveRunMetadata: async () => createOk(undefined),
      loadRunMetadata: async () => createErr(agentExecutionError('test', 'Not found')),
      readLog: async () => createOk('Test log content'),
      listRunLogs: async () => createOk([]),
    };

    const sessionEffects: LeaderSessionEffects = {
      saveSession: async () => createOk(undefined),
      loadSession: async () =>
        createErr(ioError('Session not found')),
      sessionExists: async () => createOk(false),
      listSessions: async () => createOk([]),
    };

    const workerOps = {
      executeTaskWithWorktree: async () =>
        createOk({
          runId: 'test-run',
          checkFixRunIds: [],
          success: true,
        }),
    };

    const judgeOps = {
      judgeTask: async () =>
        createOk({
          taskId: taskId('test-1'),
          success: false,
          shouldContinue: false,
          shouldReplan: false,
          alreadySatisfied: false,
          reason: 'Test failure',
          missingRequirements: [],
        }),
    };

    const baseBranchResolver = {
      resolveBaseBranch: async () =>
        createOk({
          type: 'main_branch' as const,
          baseBranch: 'main' as any,
        }),
    };

    const gitEffects = {
      getCurrentBranch: async () => createOk('main' as any),
      branchExists: async () => createOk(false),
      createBranch: async () => createOk(undefined),
      deleteBranch: async () => createOk(undefined),
      checkoutBranch: async () => createOk(undefined),
      switchBranch: async () => createOk(undefined),
      listBranches: async () => createOk([]),
      createWorktree: async () => createOk(undefined),
      removeWorktree: async () => createOk(undefined),
      listWorktrees: async () => createOk([]),
      mergeBranch: async () => createOk(undefined),
      commitChanges: async () => createOk(undefined),
      pushBranch: async () => createOk(undefined),
      getCommitHash: async () => createOk('commit-hash' as any),
      getWorktreeInfo: async () => createOk({ path: '/test', branch: 'main' as any }),
      resetHard: async () => createOk(undefined),
      clean: async () => createOk(undefined),
      fetch: async () => createOk(undefined),
      pull: async () => createOk(undefined),
      hasUncommittedChanges: async () => createOk(false),
      getUncommittedChanges: async () => createOk([]),
      stageChanges: async () => createOk(undefined),
      unstageChanges: async () => createOk(undefined),
      getDiff: async () => createOk(''),
      getLog: async () => createOk([]),
    } as any;

    const config = {
      $schema: 'test-schema',
      appRepoPath: '/test/app',
      agentCoordPath: '/test/coord',
      maxWorkers: 1,
      agents: {
        planner: { type: 'claude' as const, model: 'test-model' },
        worker: { type: 'claude' as const, model: 'test-model' },
        judge: { type: 'claude' as const, model: 'test-model' },
      },
      checks: {
        build: { enabled: false },
        test: { enabled: false },
        lint: { enabled: false },
        typecheck: { enabled: false },
      },
      workerTimeout: 60000,
      judgeRetries: 3,
      enableParallelExecution: false,
      replanStrategy: 'auto' as const,
      maxReplanIterations: 3,
      branchNamingStrategy: 'short-uuid' as const,
    } as any;

    return {
      taskStore,
      runnerEffects,
      sessionEffects,
      coordRepoPath: '/test/coord-repo',
      agentType: 'claude',
      model: 'test-model',
      gitEffects,
      config,
      workerOps: workerOps as any,
      judgeOps: judgeOps as any,
      baseBranchResolver: baseBranchResolver as any,
      ...overrides,
    };
  };

  test('createEscalationRecord - creates escalation record', () => {
    const record = createEscalationRecord(
      EscalationTarget.USER,
      'Test reason',
      taskId('test-1'),
    );

    assert.strictEqual(record.target, EscalationTarget.USER);
    assert.strictEqual(record.reason, 'Test reason');
    assert.strictEqual(record.relatedTaskId, taskId('test-1'));
    assert.strictEqual(record.resolved, false);
    assert.strictEqual(record.resolvedAt, null);
    assert.strictEqual(record.resolution, null);
    assert.ok(record.id);
    assert.ok(record.escalatedAt);
  });

  test('handleUserEscalation - records escalation and stops', async () => {
    const deps = createTestDeps();
    const session = createLeaderSession('test-session', '/test/plan.md');

    const result = await handleUserEscalation(
      deps,
      session,
      'Test failure reason',
      taskId('test-1'),
    );

    assert.ok(result.ok);
    if (!result.ok) return;

    const updatedSession = result.val;
    assert.strictEqual(updatedSession.status, LeaderSessionStatus.ESCALATING);
    assert.strictEqual(updatedSession.escalationRecords.length, 1);
    assert.strictEqual(
      updatedSession.escalationRecords[0]?.target,
      EscalationTarget.USER,
    );
    assert.strictEqual(
      updatedSession.escalationRecords[0]?.reason,
      'Test failure reason',
    );
    assert.strictEqual(updatedSession.escalationAttempts.user, 1);
  });

  test('handleUserEscalation - respects escalation limits', async () => {
    const deps = createTestDeps();
    const session = createLeaderSession('test-session', '/test/plan.md');
    // エスカレーション回数を制限値まで引き上げる
    session.escalationAttempts.user = 10;

    const result = await handleUserEscalation(
      deps,
      session,
      'Test failure reason',
    );

    assert.ok(!result.ok);
    if (result.ok) return;

    assert.ok(result.err.message.includes('Escalation limit reached'));
  });

  test('handleTechnicalEscalation - falls back to user escalation', async () => {
    const deps = createTestDeps();
    const session = createLeaderSession('test-session', '/test/plan.md');

    const result = await handleTechnicalEscalation(
      deps,
      session,
      'Technical difficulty',
      taskId('test-1'),
    );

    assert.ok(result.ok);
    if (!result.ok) return;

    const updatedSession = result.val;
    assert.strictEqual(updatedSession.status, LeaderSessionStatus.ESCALATING);
    assert.strictEqual(updatedSession.escalationRecords.length, 1);
    assert.strictEqual(
      updatedSession.escalationRecords[0]?.target,
      EscalationTarget.USER,
    );
    assert.ok(
      updatedSession.escalationRecords[0]?.reason.includes('[Technical difficulty]'),
    );
  });

  test('getEscalationHistory - returns all records', () => {
    const session = createLeaderSession('test-session', '/test/plan.md');
    session.escalationRecords = [
      createEscalationRecord(EscalationTarget.USER, 'Reason 1'),
      createEscalationRecord(EscalationTarget.PLANNER, 'Reason 2'),
    ];

    const history = getEscalationHistory(session);
    assert.strictEqual(history.length, 2);
  });

  test('getEscalationHistory - filters by resolved status', () => {
    const session = createLeaderSession('test-session', '/test/plan.md');
    const record1 = createEscalationRecord(EscalationTarget.USER, 'Reason 1');
    const record2 = createEscalationRecord(EscalationTarget.PLANNER, 'Reason 2');
    record2.resolved = true;

    session.escalationRecords = [record1, record2];

    const unresolved = getEscalationHistory(session, false);
    assert.strictEqual(unresolved.length, 1);
    assert.strictEqual(unresolved[0]?.target, EscalationTarget.USER);

    const resolved = getEscalationHistory(session, true);
    assert.strictEqual(resolved.length, 1);
    assert.strictEqual(resolved[0]?.target, EscalationTarget.PLANNER);
  });

  test('getPendingEscalations - returns unresolved records', () => {
    const session = createLeaderSession('test-session', '/test/plan.md');
    const record1 = createEscalationRecord(EscalationTarget.USER, 'Reason 1');
    const record2 = createEscalationRecord(EscalationTarget.PLANNER, 'Reason 2');
    record2.resolved = true;

    session.escalationRecords = [record1, record2];

    const pending = getPendingEscalations(session);
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0]?.target, EscalationTarget.USER);
  });

  test('handlePlannerEscalation - executes replanning successfully', async () => {
    const deps = createTestDeps({
      runnerEffects: {
        runClaudeAgent: async () =>
          createOk({
            finalResponse: JSON.stringify([
              {
                id: 'task-1',
                description: 'New task',
                branch: 'new-branch',
                scopePaths: ['new.ts'],
                acceptance: 'New acceptance',
                type: 'implementation',
                estimatedDuration: 2,
                context: 'New context',
                dependencies: [],
              },
            ]),
          }),
        runCodexAgent: async () => createOk({ finalResponse: JSON.stringify([]) }),
        ensureRunsDir: async () => createOk(undefined),
        initializeLogFile: async () => createOk(undefined),
        appendLog: async () => createOk(undefined),
        saveRunMetadata: async () => createOk(undefined),
        loadRunMetadata: async () => createErr(agentExecutionError('test', 'Not found')),
        readLog: async () => createOk('Test log content'),
        listRunLogs: async () => createOk([]),
      },
    });

    const session = createLeaderSession('test-session', '/test/plan.md');
    // 履歴を追加（Judge判定結果が必要）
    session.memberTaskHistory = [
      {
        taskId: taskId('test-1'),
        assignedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        workerResult: {
          runId: 'test-run',
          success: false,
        },
        judgementResult: {
          taskId: taskId('test-1'),
          success: false,
          shouldContinue: false,
          shouldReplan: true,
          alreadySatisfied: false,
          reason: 'Task failed',
          missingRequirements: [],
        },
        workerFeedback: null,
      },
    ];

    const task = createInitialTask({
      id: taskId('test-1'),
      repo: '/test/repo' as any,
      branch: 'test-branch' as any,
      scopePaths: ['test.ts'],
      acceptance: 'Test acceptance',
      taskType: 'implementation',
      context: 'Test context',
      dependencies: [],
    });

    const result = await handlePlannerEscalation(
      deps,
      session,
      task,
      'Test log',
      'Task failed',
    );

    assert.ok(result.ok);
    if (!result.ok) return;

    const { session: updatedSession, newTaskIds } = result.val;
    assert.strictEqual(updatedSession.status, LeaderSessionStatus.EXECUTING);
    assert.ok(newTaskIds.length > 0);
    assert.strictEqual(updatedSession.escalationAttempts.planner, 1);
  });

  test('handlePlannerEscalation - respects escalation limits', async () => {
    const deps = createTestDeps();
    const session = createLeaderSession('test-session', '/test/plan.md');
    // エスカレーション回数を制限値まで引き上げる
    session.escalationAttempts.planner = 3;

    const task = createInitialTask({
      id: taskId('test-1'),
      repo: '/test/repo' as any,
      branch: 'test-branch' as any,
      scopePaths: ['test.ts'],
      acceptance: 'Test acceptance',
      taskType: 'implementation',
      context: 'Test context',
      dependencies: [],
    });

    const result = await handlePlannerEscalation(
      deps,
      session,
      task,
      'Test log',
      'Task failed',
    );

    assert.ok(!result.ok);
    if (result.ok) return;

    assert.ok(result.err.message.includes('Escalation limit reached'));
  });
});
