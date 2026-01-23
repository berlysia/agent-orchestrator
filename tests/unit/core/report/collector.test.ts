import { describe, it } from 'node:test';
import assert from 'node:assert';
import { collectReportData } from '../../../../src/core/report/collector.ts';
import type { IntegrationInfo } from '../../../../src/core/report/types.ts';
import type { PlannerSessionEffects, PlannerSessionSummary } from '../../../../src/core/orchestrator/planner-session-effects.ts';
import type { TaskStore } from '../../../../src/core/task-store/interface.ts';
import type { PlannerSession } from '../../../../src/types/planner-session.ts';
import type { Task } from '../../../../src/types/task.ts';
import { TaskState } from '../../../../src/types/task.ts';
import { createOk } from 'option-t/plain_result';

describe('collectReportData', () => {
  // モックセッションエフェクトを作成
  const createMockSessionEffects = (sessions: PlannerSession[]): PlannerSessionEffects => {
    // セッションサマリーを作成
    const summaries: PlannerSessionSummary[] = sessions.map(s => ({
      sessionId: s.sessionId,
      instruction: 'Test instruction',
      createdAt: s.createdAt,
      taskCount: s.taskCount,
    }));

    return {
      ensureSessionsDir: async () => createOk(undefined),
      saveSession: async () => createOk(undefined),
      loadSession: async (sessionId: string) => {
        const session = sessions.find((s) => s.sessionId === sessionId);
        if (session) {
          return createOk(session);
        }
        return createOk({} as PlannerSession);
      },
      sessionExists: async () => createOk(true),
      listSessions: async () => createOk(summaries),
    };
  };

  // モックタスクストアを作成
  const createMockTaskStore = (tasks: Task[]): TaskStore => ({
    listTasks: async () => createOk(tasks),
    getTask: async (taskId: string) => {
      const task = tasks.find((t) => t.id === taskId);
      if (task) {
        return createOk(task);
      }
      return createOk(null);
    },
    createTask: async () => createOk(undefined),
    updateTaskCAS: async () => createOk(true),
    deleteTask: async () => createOk(undefined),
  });

  // 基本的なモックセッションを作成
  const createMockSession = (sessionId: string, rootSessionId: string): PlannerSession => ({
    sessionId,
    rootSessionId,
    createdAt: new Date('2024-01-23T10:00:00.000Z').toISOString(),
    updatedAt: new Date('2024-01-23T12:00:00.000Z').toISOString(),
    status: 'completed',
    taskCount: 1,
    completedTaskCount: 1,
  });

  // 基本的なモックタスクを作成
  const createMockTask = (taskId: string, rootSessionId: string, state: TaskState = TaskState.DONE): Task => ({
    id: taskId,
    rootSessionId,
    sessionId: `session-${taskId}`,
    summary: `Task ${taskId}`,
    acceptance: `Acceptance criteria for ${taskId}`,
    state,
    createdAt: new Date('2024-01-23T10:00:00.000Z').toISOString(),
    updatedAt: new Date('2024-01-23T11:00:00.000Z').toISOString(),
    version: 1,
    dependencies: [],
    baseBranch: 'main',
    workingBranch: `task-${taskId}`,
    worktreePath: `/tmp/worktree-${taskId}`,
  });

  describe('integration info handling', () => {
    it('should include integration info when provided', async () => {
      const rootSessionId = 'root-session-123';
      const sessions = [createMockSession('session-1', rootSessionId)];
      const tasks = [createMockTask('task-1', rootSessionId)];

      const integrationInfo: IntegrationInfo = {
        integrationBranch: 'integration/test-branch',
        mergedCount: 3,
        conflictCount: 1,
        conflictResolutionTaskId: 'task-conflict-1',
        completionScore: 85,
        missingAspects: ['テストカバレッジ不足'],
      };

      const sessionEffects = createMockSessionEffects(sessions);
      const taskStore = createMockTaskStore(tasks);

      const result = await collectReportData(rootSessionId, sessionEffects, taskStore, integrationInfo);

      assert.ok(result.ok, 'Expected result to be Ok');
      if (result.ok) {
        assert.ok(result.val.integration, 'Expected integration info to be included');
        assert.strictEqual(result.val.integration?.integrationBranch, 'integration/test-branch');
        assert.strictEqual(result.val.integration?.mergedCount, 3);
        assert.strictEqual(result.val.integration?.conflictCount, 1);
        assert.strictEqual(result.val.integration?.conflictResolutionTaskId, 'task-conflict-1');
        assert.strictEqual(result.val.integration?.completionScore, 85);
        assert.deepStrictEqual(result.val.integration?.missingAspects, ['テストカバレッジ不足']);
      }
    });

    it('should not include integration field when not provided', async () => {
      const rootSessionId = 'root-session-456';
      const sessions = [createMockSession('session-2', rootSessionId)];
      const tasks = [createMockTask('task-2', rootSessionId)];

      const sessionEffects = createMockSessionEffects(sessions);
      const taskStore = createMockTaskStore(tasks);

      const result = await collectReportData(rootSessionId, sessionEffects, taskStore);

      assert.ok(result.ok, 'Expected result to be Ok');
      if (result.ok) {
        assert.strictEqual(result.val.integration, undefined, 'Expected integration info to be undefined');
      }
    });

    it('should handle integration info with optional fields undefined', async () => {
      const rootSessionId = 'root-session-789';
      const sessions = [createMockSession('session-3', rootSessionId)];
      const tasks = [createMockTask('task-3', rootSessionId)];

      const integrationInfo: IntegrationInfo = {
        integrationBranch: undefined,
        mergedCount: 2,
        conflictCount: 0,
        conflictResolutionTaskId: undefined,
        completionScore: undefined,
        missingAspects: [],
      };

      const sessionEffects = createMockSessionEffects(sessions);
      const taskStore = createMockTaskStore(tasks);

      const result = await collectReportData(rootSessionId, sessionEffects, taskStore, integrationInfo);

      assert.ok(result.ok, 'Expected result to be Ok');
      if (result.ok) {
        assert.ok(result.val.integration, 'Expected integration info to be included');
        assert.strictEqual(result.val.integration?.integrationBranch, undefined);
        assert.strictEqual(result.val.integration?.mergedCount, 2);
        assert.strictEqual(result.val.integration?.conflictCount, 0);
        assert.strictEqual(result.val.integration?.conflictResolutionTaskId, undefined);
        assert.strictEqual(result.val.integration?.completionScore, undefined);
        assert.deepStrictEqual(result.val.integration?.missingAspects, []);
      }
    });

    it('should include integration info with multiple missing aspects', async () => {
      const rootSessionId = 'root-session-abc';
      const sessions = [createMockSession('session-4', rootSessionId)];
      const tasks = [createMockTask('task-4', rootSessionId)];

      const integrationInfo: IntegrationInfo = {
        integrationBranch: 'integration/feature-x',
        mergedCount: 5,
        conflictCount: 2,
        conflictResolutionTaskId: 'task-resolve-123',
        completionScore: 70,
        missingAspects: [
          'テストカバレッジ不足',
          'ドキュメント未更新',
          'パフォーマンス最適化',
        ],
      };

      const sessionEffects = createMockSessionEffects(sessions);
      const taskStore = createMockTaskStore(tasks);

      const result = await collectReportData(rootSessionId, sessionEffects, taskStore, integrationInfo);

      assert.ok(result.ok, 'Expected result to be Ok');
      if (result.ok) {
        assert.ok(result.val.integration, 'Expected integration info to be included');
        assert.strictEqual(result.val.integration?.missingAspects.length, 3);
        assert.deepStrictEqual(result.val.integration?.missingAspects, [
          'テストカバレッジ不足',
          'ドキュメント未更新',
          'パフォーマンス最適化',
        ]);
      }
    });
  });

  describe('basic functionality', () => {
    it('should collect report data with correct structure', async () => {
      const rootSessionId = 'root-session-basic';
      const sessions = [createMockSession('session-basic', rootSessionId)];
      const tasks = [
        createMockTask('task-basic-1', rootSessionId, TaskState.DONE),
        createMockTask('task-basic-2', rootSessionId, TaskState.BLOCKED),
      ];

      const sessionEffects = createMockSessionEffects(sessions);
      const taskStore = createMockTaskStore(tasks);

      const result = await collectReportData(rootSessionId, sessionEffects, taskStore);

      assert.ok(result.ok, 'Expected result to be Ok');
      if (result.ok) {
        assert.strictEqual(result.val.rootSessionId, rootSessionId);
        assert.ok(result.val.period, 'Expected period to be defined');
        assert.ok(result.val.statistics, 'Expected statistics to be defined');
        assert.ok(Array.isArray(result.val.taskSummaries), 'Expected taskSummaries to be array');
        assert.ok(Array.isArray(result.val.events), 'Expected events to be array');
      }
    });

    it('should filter tasks by rootSessionId', async () => {
      const rootSessionId = 'root-session-filter';
      const otherRootSessionId = 'other-root-session';

      const sessions = [createMockSession('session-filter', rootSessionId)];
      const tasks = [
        createMockTask('task-filter-1', rootSessionId, TaskState.DONE),
        createMockTask('task-filter-2', rootSessionId, TaskState.DONE),
        createMockTask('task-other', otherRootSessionId, TaskState.DONE),
      ];

      const sessionEffects = createMockSessionEffects(sessions);
      const taskStore = createMockTaskStore(tasks);

      const result = await collectReportData(rootSessionId, sessionEffects, taskStore);

      assert.ok(result.ok, 'Expected result to be Ok');
      if (result.ok) {
        // rootSessionIdに属するタスクのみが含まれる
        assert.strictEqual(result.val.taskSummaries.length, 2);
        assert.strictEqual(result.val.statistics.total, 2);
        assert.strictEqual(result.val.statistics.completed, 2);
      }
    });
  });
});
