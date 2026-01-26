import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { executeLeaderLoop } from '../../src/core/orchestrator/leader-execution-loop.ts';
import type { LeaderDeps } from '../../src/core/orchestrator/leader-operations.ts';
import type { TaskStore } from '../../src/core/task-store/interface.ts';
import type { Task } from '../../src/types/task.ts';
import { TaskState } from '../../src/types/task.ts';
import type { LeaderSession } from '../../src/types/leader-session.ts';
import { createLeaderSession, LeaderSessionStatus } from '../../src/types/leader-session.ts';
import { createOk } from 'option-t/plain_result';
import { taskId } from '../../src/types/branded.ts';
import type { LeaderSessionEffects } from '../../src/core/orchestrator/leader-session-effects.ts';

describe('leader-execution-loop', () => {
  let taskStore: TaskStore;
  let sessionEffects: LeaderSessionEffects;
  let deps: LeaderDeps;
  let session: LeaderSession;
  let tasksState: Map<string, Task>;

  beforeEach(() => {
    // タスク状態管理用 Map
    tasksState = new Map();

    // Mock TaskStore
    taskStore = {
      createTask: async (task: Task) => {
        tasksState.set(task.id, task);
        return createOk(undefined);
      },
      readTask: async (id) => {
        const task = tasksState.get(id);
        if (!task) {
          throw new Error(`Task not found: ${id}`);
        }
        return createOk(task);
      },
      listTasks: async () => {
        return createOk(Array.from(tasksState.values()));
      },
      deleteTask: async () => createOk(undefined),
      updateTaskCAS: async (id, _expectedVersion, updateFn) => {
        const task = tasksState.get(id);
        if (!task) {
          throw new Error(`Task not found: ${id}`);
        }
        const updated = updateFn(task);
        tasksState.set(id, updated);
        return createOk(updated);
      },
      writeRun: async () => createOk(undefined),
      writeCheck: async () => createOk(undefined),
    } as TaskStore;

    // Mock SessionEffects
    sessionEffects = {
      saveSession: async (_s: LeaderSession) => createOk(undefined),
      loadSession: async () => createOk(session),
      sessionExists: async () => createOk(true),
      listSessions: async () => createOk([]),
    };

    // Mock LeaderDeps
    deps = {
      taskStore,
      sessionEffects,
      runnerEffects: {} as any,
      coordRepoPath: '/test/coord',
      agentType: 'claude',
      model: 'claude-sonnet-4.5',
      gitEffects: {} as any,
      config: {} as any,
      workerOps: {
        executeTaskWithWorktree: async () =>
          createOk({
            runId: 'run-1',
            success: true,
            checkFixRunIds: [],
          }),
      } as any,
      judgeOps: {
        judgeTask: async () =>
          createOk({
            taskId: taskId('task-1'),
            success: true,
            shouldContinue: false,
            shouldReplan: false,
            alreadySatisfied: false,
            reason: 'Task completed successfully',
            missingRequirements: [],
          }),
      } as any,
      baseBranchResolver: {
        resolveBaseBranch: async () =>
          createOk({
            type: 'no-dependency',
            baseBranch: 'main',
            baseCommit: 'commit-1',
          }),
      } as any,
    };

    // Leader セッション作成
    session = createLeaderSession('session-1', '/test/plan.md', null);
  });

  describe('executeLeaderLoop', () => {
    it('should execute a single task successfully', async () => {
      // タスクを準備
      const task: Task = {
        id: taskId('task-1'),
        state: TaskState.READY,
        version: 0,
        owner: null,
        repo: '/test/repo' as any,
        branch: 'feature/test' as any,
        scopePaths: [],
        acceptance: 'Test acceptance',
        taskType: 'implementation',
        context: 'Test context',
        dependencies: [],
        check: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sessionId: 'session-1',
        summary: 'Test task',
        integrationRetried: false,
      } as Task;

      tasksState.set(task.id, task);

      // 実行
      const result = await executeLeaderLoop(deps, session, [task]);

      // 検証
      assert.ok(result.ok, 'Result should be Ok');
      if (!result.ok) throw new Error('Unreachable');

      const loopResult = result.val;
      assert.equal(loopResult.session.status, LeaderSessionStatus.COMPLETED);
      assert.equal(loopResult.completedTaskIds.length, 1);
      assert.equal(loopResult.completedTaskIds[0], 'task-1');
      assert.equal(loopResult.failedTaskIds.length, 0);
      assert.equal(loopResult.pendingEscalation, undefined);

      // タスク状態を確認
      const updatedTask = tasksState.get('task-1');
      assert.equal(updatedTask?.state, TaskState.DONE);
    });

    it('should execute tasks respecting dependencies', async () => {
      // 依存関係のあるタスクを準備
      const task1: Task = {
        id: taskId('task-1'),
        state: TaskState.READY,
        version: 0,
        owner: null,
        repo: '/test/repo' as any,
        branch: 'feature/task1' as any,
        scopePaths: [],
        acceptance: 'Task 1 acceptance',
        taskType: 'implementation',
        context: 'Task 1 context',
        dependencies: [],
        check: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sessionId: 'session-1',
        summary: 'Task 1',
        integrationRetried: false,
      } as Task;

      const task2: Task = {
        id: taskId('task-2'),
        state: TaskState.READY,
        version: 0,
        owner: null,
        repo: '/test/repo' as any,
        branch: 'feature/task2' as any,
        scopePaths: [],
        acceptance: 'Task 2 acceptance',
        taskType: 'implementation',
        context: 'Task 2 context',
        dependencies: [taskId('task-1')], // task1 に依存
        check: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sessionId: 'session-1',
        summary: 'Task 2 (depends on Task 1)',
        integrationRetried: false,
      } as Task;

      tasksState.set(task1.id, task1);
      tasksState.set(task2.id, task2);

      // 実行
      const result = await executeLeaderLoop(deps, session, [task1, task2]);

      // 検証
      assert.ok(result.ok, 'Result should be Ok');
      if (!result.ok) throw new Error('Unreachable');

      const loopResult = result.val;
      assert.equal(loopResult.session.status, LeaderSessionStatus.COMPLETED);
      assert.equal(loopResult.completedTaskIds.length, 2);
      // task1 が先に完了し、その後 task2 が完了
      assert.equal(loopResult.completedTaskIds[0], 'task-1');
      assert.equal(loopResult.completedTaskIds[1], 'task-2');
      assert.equal(loopResult.failedTaskIds.length, 0);
    });

    it('should handle task continuation (shouldContinue)', async () => {
      let judgeCallCount = 0;

      // Mock JudgeOps: 最初は shouldContinue、2回目で success
      const customJudgeOps = {
        judgeTask: async () => {
          judgeCallCount++;
          if (judgeCallCount === 1) {
            return createOk({
              taskId: taskId('task-1'),
              success: false,
              shouldContinue: true,
              shouldReplan: false,
              alreadySatisfied: false,
              reason: 'Task needs continuation',
              missingRequirements: [],
            });
          } else {
            return createOk({
              taskId: taskId('task-1'),
              success: true,
              shouldContinue: false,
              shouldReplan: false,
              alreadySatisfied: false,
              reason: 'Task completed after continuation',
              missingRequirements: [],
            });
          }
        },
      } as any;

      const customDeps = { ...deps, judgeOps: customJudgeOps };

      const task: Task = {
        id: taskId('task-1'),
        state: TaskState.READY,
        version: 0,
        owner: null,
        repo: '/test/repo' as any,
        branch: 'feature/test' as any,
        scopePaths: [],
        acceptance: 'Test acceptance',
        taskType: 'implementation',
        context: 'Test context',
        dependencies: [],
        check: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sessionId: 'session-1',
        summary: 'Test task',
        integrationRetried: false,
      } as Task;

      tasksState.set(task.id, task);

      // 実行
      const result = await executeLeaderLoop(customDeps, session, [task]);

      // 検証
      assert.ok(result.ok, 'Result should be Ok');
      if (!result.ok) throw new Error('Unreachable');

      const loopResult = result.val;
      assert.equal(loopResult.session.status, LeaderSessionStatus.COMPLETED);
      assert.equal(loopResult.completedTaskIds.length, 1);
      assert.equal(judgeCallCount, 2, 'Judge should be called twice (initial + continuation)');
    });

    it('should escalate to Planner when shouldReplan is true', async () => {
      // Mock JudgeOps: shouldReplan を返す
      const customJudgeOps = {
        judgeTask: async () =>
          createOk({
            taskId: taskId('task-1'),
            success: false,
            shouldContinue: false,
            shouldReplan: true,
            alreadySatisfied: false,
            reason: 'Task needs replanning',
            missingRequirements: ['Missing requirement X'],
          }),
      } as any;

      const customDeps = { ...deps, judgeOps: customJudgeOps };

      const task: Task = {
        id: taskId('task-1'),
        state: TaskState.READY,
        version: 0,
        owner: null,
        repo: '/test/repo' as any,
        branch: 'feature/test' as any,
        scopePaths: [],
        acceptance: 'Test acceptance',
        taskType: 'implementation',
        context: 'Test context',
        dependencies: [],
        check: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sessionId: 'session-1',
        summary: 'Test task',
        integrationRetried: false,
      } as Task;

      tasksState.set(task.id, task);

      // 実行
      const result = await executeLeaderLoop(customDeps, session, [task]);

      // 検証
      assert.ok(result.ok, 'Result should be Ok');
      if (!result.ok) throw new Error('Unreachable');

      const loopResult = result.val;
      assert.equal(loopResult.session.status, LeaderSessionStatus.ESCALATING);
      assert.equal(loopResult.completedTaskIds.length, 0);
      assert.equal(loopResult.failedTaskIds.length, 0);
      assert.ok(loopResult.pendingEscalation, 'Should have pending escalation');
      assert.equal(loopResult.pendingEscalation?.target, 'planner');
      assert.equal(loopResult.pendingEscalation?.relatedTaskId, 'task-1');
    });

    it('should escalate to User when task fails without shouldReplan', async () => {
      // Mock JudgeOps: 失敗を返す（shouldReplan = false）
      const customJudgeOps = {
        judgeTask: async () =>
          createOk({
            taskId: taskId('task-1'),
            success: false,
            shouldContinue: false,
            shouldReplan: false,
            alreadySatisfied: false,
            reason: 'Task failed due to unexpected error',
            missingRequirements: [],
          }),
      } as any;

      const customDeps = { ...deps, judgeOps: customJudgeOps };

      const task: Task = {
        id: taskId('task-1'),
        state: TaskState.READY,
        version: 0,
        owner: null,
        repo: '/test/repo' as any,
        branch: 'feature/test' as any,
        scopePaths: [],
        acceptance: 'Test acceptance',
        taskType: 'implementation',
        context: 'Test context',
        dependencies: [],
        check: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sessionId: 'session-1',
        summary: 'Test task',
        integrationRetried: false,
      } as Task;

      tasksState.set(task.id, task);

      // 実行
      const result = await executeLeaderLoop(customDeps, session, [task]);

      // 検証
      assert.ok(result.ok, 'Result should be Ok');
      if (!result.ok) throw new Error('Unreachable');

      const loopResult = result.val;
      assert.equal(loopResult.session.status, LeaderSessionStatus.ESCALATING);
      assert.equal(loopResult.completedTaskIds.length, 0);
      assert.equal(loopResult.failedTaskIds.length, 1);
      assert.equal(loopResult.failedTaskIds[0], 'task-1');
      assert.ok(loopResult.pendingEscalation, 'Should have pending escalation');
      assert.equal(loopResult.pendingEscalation?.target, 'user');
      assert.equal(loopResult.pendingEscalation?.relatedTaskId, 'task-1');
    });

    it('should skip already satisfied tasks', async () => {
      // Mock JudgeOps: alreadySatisfied を返す
      const customJudgeOps = {
        judgeTask: async () =>
          createOk({
            taskId: taskId('task-1'),
            success: false,
            shouldContinue: false,
            shouldReplan: false,
            alreadySatisfied: true,
            reason: 'Task is already implemented',
            missingRequirements: [],
          }),
      } as any;

      const customDeps = { ...deps, judgeOps: customJudgeOps };

      const task: Task = {
        id: taskId('task-1'),
        state: TaskState.READY,
        version: 0,
        owner: null,
        repo: '/test/repo' as any,
        branch: 'feature/test' as any,
        scopePaths: [],
        acceptance: 'Test acceptance',
        taskType: 'implementation',
        context: 'Test context',
        dependencies: [],
        check: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sessionId: 'session-1',
        summary: 'Test task',
        integrationRetried: false,
      } as Task;

      tasksState.set(task.id, task);

      // 実行
      const result = await executeLeaderLoop(customDeps, session, [task]);

      // 検証
      assert.ok(result.ok, 'Result should be Ok');
      if (!result.ok) throw new Error('Unreachable');

      const loopResult = result.val;
      assert.equal(loopResult.session.status, LeaderSessionStatus.COMPLETED);
      assert.equal(loopResult.completedTaskIds.length, 1);
      assert.equal(loopResult.failedTaskIds.length, 0);

      // タスク状態を確認（SKIPPED であるべき）
      const updatedTask = tasksState.get('task-1');
      assert.equal(updatedTask?.state, TaskState.SKIPPED);
    });
  });
});
