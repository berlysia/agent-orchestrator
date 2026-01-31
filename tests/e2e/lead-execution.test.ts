import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { executeLeaderLoop } from '../../src/core/orchestrator/leader-execution-loop.ts';
import { loadFromPlanDocument } from '../../src/core/orchestrator/leader-input-loader.ts';
import {
  initializeLeaderSession,
  type LeaderDeps,
} from '../../src/core/orchestrator/leader-operations.ts';
import type { TaskStore } from '../../src/core/task-store/interface.ts';
import type { Task } from '../../src/types/task.ts';
import { createOk, createErr, isErr } from 'option-t/plain_result';
import { taskId, repoPath, branchName } from '../../src/types/branded.ts';
import { LeaderSessionStatus } from '../../src/types/leader-session.ts';
import type { LeaderSession } from '../../src/types/leader-session.ts';
import type { LeaderSessionEffects } from '../../src/core/orchestrator/leader-session-effects.ts';
import { createInitialTask } from '../../src/types/task.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const TEST_BASE_PATH = path.join(PROJECT_ROOT, '.tmp', 'test-e2e-lead');

/**
 * Phase 2 E2E テスト - Leader実行フローの統合動作確認
 *
 * Note: このテストは主要な動作確認のための簡易版です。
 * 詳細なシナリオテストは既存のユニットテストでカバーされています。
 */
describe('E2E: Leader Execution - Smoke Tests', () => {
  let testProjectPath: string;
  let coordRepoPath: string;
  let planDocPath: string;
  let tasksState: Map<string, Task>;
  let savedSession: LeaderSession | null;

  async function setup() {
    // テスト環境のセットアップ
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    await fs.mkdir(TEST_BASE_PATH, { recursive: true });

    testProjectPath = path.join(TEST_BASE_PATH, 'test-project');
    coordRepoPath = path.join(TEST_BASE_PATH, 'coord-repo');
    planDocPath = path.join(TEST_BASE_PATH, 'plan.md');

    await fs.mkdir(testProjectPath, { recursive: true });
    await fs.mkdir(coordRepoPath, { recursive: true });
    await fs.mkdir(path.join(coordRepoPath, 'tasks'), { recursive: true });
    await fs.mkdir(path.join(coordRepoPath, 'leader-sessions'), { recursive: true });

    // 状態管理の初期化
    tasksState = new Map();
    savedSession = null;
  }

  /**
   * 最小限のモックDepsを構築
   */
  function createMinimalDeps(): LeaderDeps {
    const taskStore: TaskStore = {
      createTask: async (task: Task) => {
        tasksState.set(task.id, task);
        return createOk(undefined);
      },
      readTask: async (id) => {
        const task = tasksState.get(id);
        if (!task) {
          return createErr({ type: 'TaskNotFound' as const, taskId: id });
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
          return createErr({ type: 'TaskNotFound' as const, taskId: id });
        }
        const updated = updateFn(task);
        tasksState.set(id, updated);
        return createOk(updated);
      },
      writeRun: async () => createOk(undefined),
      writeCheck: async () => createOk(undefined),
    } as TaskStore;

    const sessionEffects: LeaderSessionEffects = {
      saveSession: async (session: LeaderSession) => {
        savedSession = session;
        return createOk(undefined);
      },
      loadSession: async (sessionId: string) => {
        if (!savedSession) {
          return createErr({
            type: 'IOError' as const,
            operation: 'loadSession',
            path: `leader-sessions/${sessionId}.json`,
            message: `Session not found: ${sessionId}`,
          });
        }
        return createOk(savedSession);
      },
      sessionExists: async () => createOk(!!savedSession),
      listSessions: async () => createOk(savedSession ? [savedSession] : []),
    };

    return {
      taskStore,
      sessionEffects,
      runnerEffects: {
        executeAgent: async () => createOk({ output: 'Mock output', exitCode: 0 }),
      } as any,
      coordRepoPath,
      agentType: 'claude' as const,
      model: 'claude-sonnet-4.5',
      gitEffects: {
        getCurrentBranch: async () => createOk('main'),
        branchExists: async () => createOk(false),
        createBranch: async () => createOk(undefined),
        checkoutBranch: async () => createOk(undefined),
      } as any,
      config: {
        appRepoPath: testProjectPath,
        agentCoordPath: coordRepoPath,
      } as any,
      workerOps: {
        executeTaskWithWorktree: async () =>
          createOk({
            runId: 'test-run',
            success: true,
            checkFixRunIds: [],
          }),
      } as any,
      judgeOps: {
        judgeTask: async (task: Task) =>
          createOk({
            taskId: taskId(task.id),
            success: true,
            shouldContinue: false,
            shouldReplan: false,
            alreadySatisfied: false,
            reason: 'Test: Task completed',
            missingRequirements: [],
          }),
      } as any,
      baseBranchResolver: {
        resolveBaseBranch: async () => createOk('main'),
      } as any,
    };
  }

  describe('基本動作確認', () => {
    it('Leader セッションの初期化と保存', async () => {
      await setup();

      const planContent = `# Simple Test Plan

## Task 1: Hello World
- Branch: feature/hello
- Description: Create hello world
`;

      await fs.writeFile(planDocPath, planContent, 'utf-8');

      const deps = createMinimalDeps();

      // セッション初期化
      const initResult = await initializeLeaderSession(deps, planDocPath);

      assert.ok(!isErr(initResult), 'initializeLeaderSession should succeed');

      if (!isErr(initResult)) {
        const session = initResult.val;
        assert.strictEqual(session.status, LeaderSessionStatus.PLANNING);
        assert.strictEqual(session.planFilePath, planDocPath);

        // セッションが保存されたことを確認
        assert.ok(savedSession, 'Session should be saved');
        assert.strictEqual(savedSession?.sessionId, session.sessionId);
      }

      await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    });

    it('計画文書からのタスク読み込み', async () => {
      await setup();

      const planContent = `# Test Plan

## Task 1: First Task
- Branch: feature/task-1
- Description: First task description

## Task 2: Second Task
- Branch: feature/task-2
- Description: Second task description
- Depends on: Task 1
`;

      await fs.writeFile(planDocPath, planContent, 'utf-8');

      const deps = createMinimalDeps();

      // 計画文書を読み込み
      const loadResult = await loadFromPlanDocument(
        planDocPath,
        deps.runnerEffects,
        deps.agentType,
        deps.model,
        testProjectPath,
      );

      assert.ok(!isErr(loadResult), 'loadFromPlanDocument should succeed');

      if (!isErr(loadResult)) {
        const leaderInput = loadResult.val;
        assert.ok(leaderInput.tasks.length >= 1, 'Should have at least 1 task');
        assert.ok(leaderInput.instruction, 'Should have instruction');
      }

      await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    });

    it('タスク実行と完了判定（Happy Path）', async () => {
      await setup();

      const deps = createMinimalDeps();

      // セッション作成
      const session: LeaderSession = {
        sessionId: 'test-session-1',
        planFilePath: planDocPath,
        status: LeaderSessionStatus.EXECUTING,
        memberTaskHistory: [],
        escalationRecords: [],
        conversationHistory: [],
        activeTaskIds: [],
        completedTaskCount: 0,
        totalTaskCount: 1,
        escalationAttempts: {
          user: 0,
          planner: 0,
          logicValidator: 0,
          externalAdvisor: 0,
        },
        taskCandidates: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // 簡単なタスクを作成
      const task1 = createInitialTask({
        id: taskId('task-1'),
        repo: repoPath(testProjectPath),
        branch: branchName('feature/test'),
        scopePaths: ['./'],
        acceptance: 'Test task',
        summary: 'Test task',
        taskType: 'implementation' as const,
        context: 'Test context',
      });

      const tasks = [task1];

      // Leader実行ループ
      const loopResult = await executeLeaderLoop(deps, session, tasks);

      assert.ok(!isErr(loopResult), 'executeLeaderLoop should succeed');

      if (!isErr(loopResult)) {
        const { session: finalSession, completedTaskIds } = loopResult.val;

        // 完了状態を確認
        assert.ok(
          finalSession.status === LeaderSessionStatus.COMPLETED ||
            finalSession.status === LeaderSessionStatus.REVIEWING,
          'Session should be completed or reviewing',
        );
        assert.strictEqual(completedTaskIds.length, 1, 'Should have 1 completed task');
      }

      await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    });
  });

  describe('エスカレーション動作確認', () => {
    it('Judge失敗時のエスカレーション記録', async () => {
      await setup();

      const judgeOpsOverride = {
        judgeTask: async (task: Task) =>
          createOk({
            taskId: taskId(task.id),
            success: false,
            shouldContinue: false,
            shouldReplan: false,
            alreadySatisfied: false,
            reason: 'Test: Ambiguous requirements',
            missingRequirements: ['Clear specification'],
          }),
      };

      const deps = {
        ...createMinimalDeps(),
        judgeOps: judgeOpsOverride as any,
      };

      const session: LeaderSession = {
        sessionId: 'test-session-2',
        planFilePath: planDocPath,
        status: LeaderSessionStatus.EXECUTING,
        memberTaskHistory: [],
        escalationRecords: [],
        conversationHistory: [],
        activeTaskIds: [],
        completedTaskCount: 0,
        totalTaskCount: 1,
        escalationAttempts: {
          user: 0,
          planner: 0,
          logicValidator: 0,
          externalAdvisor: 0,
        },
        taskCandidates: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const task1 = createInitialTask({
        id: taskId('task-2'),
        repo: repoPath(testProjectPath),
        branch: branchName('feature/ambiguous'),
        scopePaths: ['./'],
        acceptance: 'Ambiguous task',
        summary: 'Ambiguous task',
        taskType: 'implementation' as const,
        context: 'Test context',
      });

      const loopResult = await executeLeaderLoop(deps, session, [task1]);

      assert.ok(!isErr(loopResult), 'executeLeaderLoop should succeed even with escalation');

      if (!isErr(loopResult)) {
        const { session: finalSession } = loopResult.val;

        // エスカレーション状態になることを確認
        assert.strictEqual(
          finalSession.status,
          LeaderSessionStatus.ESCALATING,
          'Session should be in ESCALATING state',
        );

        // エスカレーション記録があることを確認
        assert.ok(finalSession.escalationRecords.length > 0, 'Should have escalation records');
      }

      await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    });
  });

  // クリーンアップ
  it('final cleanup', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
  });
});
