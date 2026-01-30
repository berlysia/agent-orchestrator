/**
 * 共通テスト用モックDeps
 *
 * 既存の lead-execution.test.ts と leader-escalation.test.ts のパターンを統合し、
 * 再利用可能な形で提供する
 */

import { createOk, createErr } from 'option-t/plain_result';
import type { TaskStore } from '../../src/core/task-store/interface.ts';
import type { RunnerEffects } from '../../src/core/runner/runner-effects.ts';
import type { LeaderSessionEffects } from '../../src/core/orchestrator/leader-session-effects.ts';
import type { LeaderDeps } from '../../src/core/orchestrator/leader-operations.ts';
import type { PlanningSessionEffects } from '../../src/core/orchestrator/planning-session-effects.ts';
import type { PlannerSessionEffects } from '../../src/core/orchestrator/planner-session-effects.ts';
import type { Task } from '../../src/types/task.ts';
import { createInitialTask } from '../../src/types/task.ts';
import type { LeaderSession } from '../../src/types/leader-session.ts';
import type { PlanningSession } from '../../src/types/planning-session.ts';
import type { PlannerSession } from '../../src/types/planner-session.ts';
import { taskId } from '../../src/types/branded.ts';
import type { TaskId } from '../../src/types/branded.ts';
import { ioError, agentExecutionError } from '../../src/types/errors.ts';
import type { JudgementResult } from '../../src/core/orchestrator/judge-operations.ts';

/**
 * モック状態を管理するためのコンテナ
 */
export interface MockState {
  tasks: Map<string, Task>;
  leaderSession: LeaderSession | null;
  planningSessions: Map<string, PlanningSession>;
  plannerSessions: Map<string, PlannerSession>;
}

/**
 * モック状態を初期化
 */
export function createMockState(): MockState {
  return {
    tasks: new Map(),
    leaderSession: null,
    planningSessions: new Map(),
    plannerSessions: new Map(),
  };
}

/**
 * 基本的な TaskStore モックを作成
 *
 * E2E と Unit 両方で使用可能な汎用実装
 */
export function createMockTaskStore(state: MockState): TaskStore {
  return {
    createTask: async (task: Task) => {
      state.tasks.set(task.id, task);
      return createOk(undefined);
    },
    readTask: async (id) => {
      const task = state.tasks.get(id);
      if (!task) {
        return createErr({ type: 'TaskNotFound' as const, taskId: id });
      }
      return createOk(task);
    },
    listTasks: async () => {
      return createOk(Array.from(state.tasks.values()));
    },
    deleteTask: async () => createOk(undefined),
    updateTaskCAS: async (id, _expectedVersion, updateFn) => {
      const task = state.tasks.get(id);
      if (!task) {
        return createErr({ type: 'TaskNotFound' as const, taskId: id });
      }
      const updated = updateFn(task);
      state.tasks.set(id, updated);
      return createOk(updated);
    },
    writeRun: async () => createOk(undefined),
    writeCheck: async () => createOk(undefined),
  } as TaskStore;
}

/**
 * 基本的な LeaderSessionEffects モックを作成
 */
export function createMockLeaderSessionEffects(state: MockState): LeaderSessionEffects {
  return {
    saveSession: async (session: LeaderSession) => {
      state.leaderSession = session;
      return createOk(undefined);
    },
    loadSession: async (sessionId: string) => {
      if (!state.leaderSession) {
        return createErr(
          ioError('loadSession', {
            message: `Session not found: ${sessionId}`,
          }),
        );
      }
      return createOk(state.leaderSession);
    },
    sessionExists: async () => createOk(!!state.leaderSession),
    listSessions: async () =>
      createOk(state.leaderSession ? [state.leaderSession] : []),
  };
}

/**
 * 基本的な RunnerEffects モックを作成
 */
export function createMockRunnerEffects(
  responseOverride?: string | (() => string),
): RunnerEffects {
  const getResponse = () =>
    typeof responseOverride === 'function'
      ? responseOverride()
      : responseOverride ?? JSON.stringify([]);

  return {
    runClaudeAgent: async () => createOk({ finalResponse: getResponse() }),
    runCodexAgent: async () => createOk({ finalResponse: getResponse() }),
    ensureRunsDir: async () => createOk(undefined),
    initializeLogFile: async () => createOk(undefined),
    appendLog: async () => createOk(undefined),
    saveRunMetadata: async () => createOk(undefined),
    loadRunMetadata: async () =>
      createErr(agentExecutionError('test', 'Not found')),
    readLog: async () => createOk('Mock log content'),
    listRunLogs: async () => createOk([]),
  };
}

/**
 * 基本的な GitEffects モックを作成
 */
export function createMockGitEffects() {
  return {
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
    getCommitHash: async () => createOk('mock-commit-hash' as any),
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
}

/**
 * 成功を返す JudgeOps モックを作成
 */
export function createMockJudgeOpsSuccess() {
  return {
    judgeTask: async (task: Task): Promise<JudgementResult> =>
      createOk({
        taskId: taskId(task.id),
        success: true,
        shouldContinue: false,
        shouldReplan: false,
        alreadySatisfied: false,
        reason: 'Task completed successfully',
        missingRequirements: [],
      }) as any,
  };
}

/**
 * 失敗を返す JudgeOps モックを作成
 */
export function createMockJudgeOpsFailure(
  reason: string,
  options?: {
    shouldContinue?: boolean;
    shouldReplan?: boolean;
    alreadySatisfied?: boolean;
    missingRequirements?: string[];
  },
) {
  return {
    judgeTask: async (task: Task): Promise<JudgementResult> =>
      createOk({
        taskId: taskId(task.id),
        success: false,
        shouldContinue: options?.shouldContinue ?? false,
        shouldReplan: options?.shouldReplan ?? false,
        alreadySatisfied: options?.alreadySatisfied ?? false,
        reason,
        missingRequirements: options?.missingRequirements ?? [],
      }) as any,
  };
}

/**
 * 再計画を要求する JudgeOps モックを作成
 */
export function createMockJudgeOpsReplan(reason: string) {
  return createMockJudgeOpsFailure(reason, { shouldReplan: true });
}

/**
 * 継続実行を要求する JudgeOps モックを作成
 */
export function createMockJudgeOpsContinue(
  reason: string,
  missingRequirements: string[] = [],
) {
  return createMockJudgeOpsFailure(reason, {
    shouldContinue: true,
    missingRequirements,
  });
}

/**
 * 成功を返す WorkerOps モックを作成
 */
export function createMockWorkerOpsSuccess() {
  return {
    executeTaskWithWorktree: async () =>
      createOk({
        runId: 'mock-run-id',
        success: true,
        checkFixRunIds: [],
      }),
  };
}

/**
 * 失敗を返す WorkerOps モックを作成
 */
export function createMockWorkerOpsFailure(error: string) {
  return {
    executeTaskWithWorktree: async () =>
      createOk({
        runId: 'mock-run-id',
        success: false,
        checkFixRunIds: [],
        error,
      }),
  };
}

/**
 * 基本的な BaseBranchResolver モックを作成
 */
export function createMockBaseBranchResolver() {
  return {
    resolveBaseBranch: async () =>
      createOk({
        type: 'main_branch' as const,
        baseBranch: 'main' as any,
      }),
  };
}

/**
 * 基本的な Config モックを作成
 */
export function createMockConfig(overrides?: Partial<{
  appRepoPath: string;
  agentCoordPath: string;
  maxWorkers: number;
}>) {
  return {
    $schema: 'test-schema',
    appRepoPath: overrides?.appRepoPath ?? '/test/app',
    agentCoordPath: overrides?.agentCoordPath ?? '/test/coord',
    maxWorkers: overrides?.maxWorkers ?? 1,
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
}

/**
 * テスト用に変更可能な LeaderDeps 型
 *
 * readonly を外した型で、テスト内でプロパティを上書き可能
 */
export type MutableLeaderDeps = {
  -readonly [K in keyof LeaderDeps]: LeaderDeps[K];
};

/**
 * 最小限の LeaderDeps を作成（E2E向け）
 *
 * lead-execution.test.ts の createMinimalDeps() を抽出
 * テスト内で上書き可能なようにミュータブルな型を返す
 */
export function createMinimalLeaderDeps(
  state: MockState,
  paths: {
    testProjectPath: string;
    coordRepoPath: string;
  },
): MutableLeaderDeps {
  return {
    taskStore: createMockTaskStore(state),
    sessionEffects: createMockLeaderSessionEffects(state),
    runnerEffects: createMockRunnerEffects(),
    coordRepoPath: paths.coordRepoPath,
    agentType: 'claude' as const,
    model: 'claude-sonnet-4.5',
    gitEffects: createMockGitEffects(),
    config: createMockConfig({
      appRepoPath: paths.testProjectPath,
      agentCoordPath: paths.coordRepoPath,
    }),
    workerOps: createMockWorkerOpsSuccess() as any,
    judgeOps: createMockJudgeOpsSuccess() as any,
    baseBranchResolver: createMockBaseBranchResolver() as any,
  };
}

/**
 * 詳細な LeaderDeps を作成（Unit向け、オーバーライド対応）
 *
 * leader-escalation.test.ts の createTestDeps() を抽出
 */
export function createDetailedLeaderDeps(
  overrides?: Partial<LeaderDeps>,
): MutableLeaderDeps {
  const state = createMockState();

  const defaults: MutableLeaderDeps = {
    taskStore: createMockTaskStore(state),
    sessionEffects: createMockLeaderSessionEffects(state),
    runnerEffects: createMockRunnerEffects(),
    coordRepoPath: '/test/coord-repo',
    agentType: 'claude' as const,
    model: 'test-model',
    gitEffects: createMockGitEffects(),
    config: createMockConfig(),
    workerOps: createMockWorkerOpsSuccess() as any,
    judgeOps: createMockJudgeOpsFailure('Test failure') as any,
    baseBranchResolver: createMockBaseBranchResolver() as any,
  };

  return {
    ...defaults,
    ...overrides,
  };
}

/**
 * PlanningSessionEffects モックを作成
 */
export function createMockPlanningSessionEffects(
  state: MockState,
): PlanningSessionEffects {
  return {
    ensureSessionsDir: async () => createOk(undefined),
    saveSession: async (session) => {
      state.planningSessions.set(session.sessionId, session);
      return createOk(undefined);
    },
    loadSession: async (sessionId) => {
      const session = state.planningSessions.get(sessionId);
      if (!session) {
        return createErr(ioError('loadSession', { message: 'Session not found' }));
      }
      return createOk(session);
    },
    sessionExists: async (sessionId) => {
      return createOk(state.planningSessions.has(sessionId));
    },
    listSessions: async () => createOk([]),
    ensureLogsDir: async () => createOk(undefined),
    appendLog: async () => createOk(undefined),
  };
}

/**
 * PlannerSessionEffects モックを作成
 */
export function createMockPlannerSessionEffects(
  state: MockState,
): PlannerSessionEffects {
  return {
    ensureSessionsDir: async () => createOk(undefined),
    saveSession: async (session) => {
      state.plannerSessions.set(session.sessionId, session);
      return createOk(undefined);
    },
    loadSession: async (sessionId) => {
      const session = state.plannerSessions.get(sessionId);
      if (!session) {
        return createErr(ioError('loadSession', { message: 'Not found' }));
      }
      return createOk(session);
    },
    sessionExists: async () => createOk(false),
    listSessions: async () => createOk([]),
  };
}

/**
 * テスト用のタスクを作成するヘルパー
 */
export function createTestTask(
  id: string,
  options?: Partial<{
    branch: string;
    acceptance: string;
    taskType: 'implementation' | 'documentation' | 'investigation' | 'integration';
    context: string;
    dependencies: string[];
    summary: string;
  }>,
): Task {
  return createInitialTask({
    id: taskId(id),
    repo: '/test/repo' as any,
    branch: (options?.branch ?? `feature/${id}`) as any,
    scopePaths: ['./'],
    acceptance: options?.acceptance ?? `Acceptance criteria for ${id}`,
    taskType: options?.taskType ?? 'implementation',
    context: options?.context ?? `Context for ${id}`,
    dependencies: options?.dependencies?.map(taskId) ?? [],
    summary: options?.summary ?? `Task ${id}`,
  });
}

/**
 * 依存関係のあるタスクリストを作成するヘルパー
 */
export function createDependentTasks(
  definitions: Array<{
    id: string;
    dependencies?: string[];
    acceptance?: string;
  }>,
): Task[] {
  return definitions.map((def) =>
    createTestTask(def.id, {
      dependencies: def.dependencies,
      acceptance: def.acceptance,
    }),
  );
}

/**
 * TaskId を作成するヘルパー（テスト用にエクスポート）
 */
export { taskId };
export type { TaskId };

/**
 * タスクをストアに追加するヘルパー
 *
 * executeLeaderLoop はタスクストアからタスクリストを取得するため、
 * テスト前にタスクをストアに追加する必要がある
 */
export async function addTasksToStore(
  deps: MutableLeaderDeps,
  tasks: Task[],
): Promise<void> {
  for (const task of tasks) {
    await deps.taskStore.createTask(task);
  }
}
