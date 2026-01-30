/**
 * リーダーパターン スモークテスト
 *
 * 実際の LLM を使用してリーダーパターンの動作を確認する
 *
 * 検証観点:
 * 1. Worker → Judge のフローが実行される
 * 2. Judge判定結果に基づいて正しい状態遷移が行われる
 *    - success=true → タスクがDONE
 *    - shouldContinue=true → タスクがNEEDS_CONTINUATION
 *    - shouldReplan=true → PLANNERへエスカレーション
 *    - 失敗（その他） → USERへエスカレーション
 *
 * 実行方法:
 *   RUN_SMOKE_TESTS=true node --test tests/e2e/leader-pattern/smoke/leader-smoke.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { isErr, createOk } from 'option-t/plain_result';
import {
  SMOKE_TEST_CONFIG,
  shouldSkipSmokeTest,
  smokeLog,
  assertSmokeTestEnvironment,
} from '../../../helpers/smoke-config.ts';
import { createRunnerEffects } from '../../../../src/core/runner/runner-effects-impl.ts';
import { executeLeaderLoop } from '../../../../src/core/orchestrator/leader-execution-loop.ts';
import {
  createLeaderSession,
  LeaderSessionStatus,
  EscalationTarget,
} from '../../../../src/types/leader-session.ts';
import { createInitialTask, TaskState } from '../../../../src/types/task.ts';
import { taskId, repoPath, branchName } from '../../../../src/types/branded.ts';
import type { LeaderDeps } from '../../../../src/core/orchestrator/leader-operations.ts';
import type { Task } from '../../../../src/types/task.ts';
import type { LeaderSession } from '../../../../src/types/leader-session.ts';
import type { JudgementResult } from '../../../../src/core/orchestrator/judge-operations.ts';
import type { TaskId } from '../../../../src/types/branded.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const TEST_BASE_PATH = path.join(PROJECT_ROOT, '.tmp', 'test-leader-smoke');

/**
 * スモークテスト用のモック状態
 */
interface SmokeTestState {
  tasks: Map<string, Task>;
  session: LeaderSession | null;
  /** Judge判定結果を記録（検証用） */
  lastJudgementResult: JudgementResult | null;
}

/**
 * 実際のLLM呼び出しを使用するJudgeOpsを作成
 *
 * WHY: リーダーパターンの「能動的なタスク調整」を検証するため、
 * Judge判定に実際のLLMを使用し、判定結果を記録する
 */
function createRealJudgeOps(
  runnerEffects: ReturnType<typeof createRunnerEffects>,
  model: string,
  appRepoPath: string,
  state: SmokeTestState,
) {
  return {
    judgeTask: async (
      tid: string,
      runIdToRead: string,
    ): Promise<{ ok: true; val: JudgementResult }> => {
      console.log(`  ⚖️  Judge: Evaluating task ${tid} with real LLM`);

      // 実行ログを読み込み
      const logResult = await runnerEffects.readLog(runIdToRead);
      const runLog = logResult.ok ? logResult.val : '(No log available)';

      // Judge用のプロンプトを構築
      const judgePrompt = `You are a task completion judge.

TASK EXECUTION LOG:
${runLog.slice(0, 5000)}${runLog.length > 5000 ? '...(truncated)' : ''}

Based on the execution log above, determine if the task was completed successfully.

Output (JSON only, no additional text):
{
  "success": true/false,
  "reason": "Brief explanation of your judgement",
  "shouldContinue": false,
  "shouldReplan": false,
  "alreadySatisfied": false
}`;

      const judgeResult = await runnerEffects.runClaudeAgent(
        judgePrompt,
        appRepoPath,
        model,
      );

      let judgement: JudgementResult;

      if (isErr(judgeResult)) {
        console.log(`  ❌ Judge execution failed: ${judgeResult.err.message}`);
        judgement = {
          taskId: taskId(tid),
          success: false,
          shouldContinue: false,
          shouldReplan: false,
          alreadySatisfied: false,
          reason: `Judge execution failed: ${judgeResult.err.message}`,
          missingRequirements: [],
        };
      } else {
        // Judge応答をパース
        const response = judgeResult.val.finalResponse ?? '';
        console.log(`  📋 Judge response: ${response.slice(0, 200)}...`);

        try {
          const jsonMatch = response.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            judgement = {
              taskId: taskId(tid),
              success: parsed.success ?? false,
              shouldContinue: parsed.shouldContinue ?? false,
              shouldReplan: parsed.shouldReplan ?? false,
              alreadySatisfied: parsed.alreadySatisfied ?? false,
              reason: parsed.reason ?? 'No reason provided',
              missingRequirements: parsed.missingRequirements ?? [],
            };
          } else {
            judgement = {
              taskId: taskId(tid),
              success: response.toLowerCase().includes('success'),
              shouldContinue: false,
              shouldReplan: false,
              alreadySatisfied: false,
              reason: response.slice(0, 200),
              missingRequirements: [],
            };
          }
        } catch (e) {
          console.log(`  ⚠️  Failed to parse Judge response: ${e}`);
          judgement = {
            taskId: taskId(tid),
            success: false,
            shouldContinue: false,
            shouldReplan: false,
            alreadySatisfied: false,
            reason: `Parse error: ${e}`,
            missingRequirements: [],
          };
        }
      }

      // 判定結果を記録（テスト検証用）
      state.lastJudgementResult = judgement;

      console.log(`  📊 Judge Decision:`);
      console.log(`     success: ${judgement.success}`);
      console.log(`     shouldContinue: ${judgement.shouldContinue}`);
      console.log(`     shouldReplan: ${judgement.shouldReplan}`);

      return createOk(judgement) as any;
    },
    // 追加の必須メソッド
    markTaskAsCompleted: async (tid: TaskId) => {
      const task = state.tasks.get(tid);
      if (!task) return { ok: false, err: { type: 'TaskNotFound', taskId: tid } } as any;
      const updated = { ...task, state: TaskState.DONE };
      state.tasks.set(tid, updated);
      return createOk(updated);
    },
    markTaskAsSkipped: async (tid: TaskId, _reason: string) => {
      const task = state.tasks.get(tid);
      if (!task) return { ok: false, err: { type: 'TaskNotFound', taskId: tid } } as any;
      const updated = { ...task, state: TaskState.SKIPPED };
      state.tasks.set(tid, updated);
      return createOk(updated);
    },
    markTaskAsBlocked: async (tid: TaskId) => {
      const task = state.tasks.get(tid);
      if (!task) return { ok: false, err: { type: 'TaskNotFound', taskId: tid } } as any;
      const updated = { ...task, state: TaskState.BLOCKED };
      state.tasks.set(tid, updated);
      return createOk(updated);
    },
    markTaskForContinuation: async (tid: TaskId) => {
      const task = state.tasks.get(tid);
      if (!task) return { ok: false, err: { type: 'TaskNotFound', taskId: tid } } as any;
      const updated = { ...task, state: TaskState.NEEDS_CONTINUATION };
      state.tasks.set(tid, updated);
      return createOk(updated);
    },
  } as any;
}

/**
 * スモークテスト用のLeaderDepsを作成
 */
function createSmokeTestLeaderDeps(
  state: SmokeTestState,
  paths: { testProjectPath: string; coordRepoPath: string },
): LeaderDeps {
  const runnerEffects = createRunnerEffects({
    coordRepoPath: paths.coordRepoPath,
    timeout: SMOKE_TEST_CONFIG.timeout,
  });

  return {
    taskStore: {
      createTask: async (task: Task) => {
        state.tasks.set(task.id, task);
        return createOk(undefined);
      },
      readTask: async (id: string) => {
        const task = state.tasks.get(id);
        if (!task) return { ok: false, err: { type: 'TaskNotFound', taskId: id } } as any;
        return createOk(task);
      },
      listTasks: async () => createOk(Array.from(state.tasks.values())),
      deleteTask: async () => createOk(undefined),
      updateTaskCAS: async (id: string, _v: number, fn: (t: Task) => Task) => {
        const task = state.tasks.get(id);
        if (!task) return { ok: false, err: { type: 'TaskNotFound', taskId: id } } as any;
        const updated = fn(task);
        state.tasks.set(id, updated);
        return createOk(updated);
      },
    } as any,
    runnerEffects,
    sessionEffects: {
      saveSession: async (s: LeaderSession) => {
        state.session = s;
        return createOk(undefined);
      },
      loadSession: async () => createOk(state.session!),
      sessionExists: async () => createOk(!!state.session),
      listSessions: async () => createOk(state.session ? [state.session] : []),
    },
    coordRepoPath: paths.coordRepoPath,
    agentType: 'claude' as const,
    model: SMOKE_TEST_CONFIG.model,
    gitEffects: {
      getCurrentBranch: async () => createOk(branchName('main')),
      listBranches: async () => createOk([]),
      getStatus: async () => createOk({ staged: [], modified: [], untracked: [] }),
      getDiff: async () => createOk(''),
    } as any,
    config: {
      checks: { enabled: false, commands: [], failureMode: 'warn', maxRetries: 0 },
      commit: { autoSignature: false },
      worktree: { postCreate: [] },
    } as any,
    workerOps: {
      executeTaskWithWorktree: async (task: Task) => {
        console.log(`  🔨 Worker: Executing task ${task.id} with real LLM`);

        await runnerEffects.ensureRunsDir();
        const theRunId = `smoke-${task.id}-${Date.now()}`;

        const prompt = `Execute the following task:
${task.acceptance}

${task.context ? `Context: ${task.context}` : ''}

Working directory: ${paths.testProjectPath}
List the files and describe what you would do to complete this task.`;

        const result = await runnerEffects.runClaudeAgent(
          prompt,
          paths.testProjectPath,
          SMOKE_TEST_CONFIG.model,
          theRunId,
        );

        if (isErr(result)) {
          console.log(`  ❌ Worker execution failed: ${result.err.message}`);
          return createOk({ runId: theRunId, success: false, error: result.err.message });
        }

        console.log(`  ✅ Worker execution completed`);
        return createOk({ runId: theRunId, success: true });
      },
    } as any,
    judgeOps: createRealJudgeOps(runnerEffects, SMOKE_TEST_CONFIG.model, paths.testProjectPath, state),
    baseBranchResolver: {
      resolveBaseBranch: async () => createOk({ type: 'none' as const }),
    } as any,
  };
}

describe('Leader Pattern Smoke Tests', { skip: shouldSkipSmokeTest() }, () => {
  let coordRepoPath: string;
  let testProjectPath: string;

  beforeEach(async () => {
    if (shouldSkipSmokeTest()) return;

    assertSmokeTestEnvironment();

    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    await fs.mkdir(TEST_BASE_PATH, { recursive: true });

    coordRepoPath = path.join(TEST_BASE_PATH, 'coord-repo');
    testProjectPath = path.join(TEST_BASE_PATH, 'test-project');

    await fs.mkdir(coordRepoPath, { recursive: true });
    await fs.mkdir(path.join(coordRepoPath, 'runs'), { recursive: true });
    await fs.mkdir(testProjectPath, { recursive: true });

    await fs.writeFile(
      path.join(testProjectPath, 'hello.ts'),
      'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
    );

    smokeLog('Test environment setup complete');
  });

  afterEach(async () => {
    if (shouldSkipSmokeTest()) return;

    try {
      const runsDir = path.join(coordRepoPath, 'runs');
      const files = await fs.readdir(runsDir);
      for (const file of files.filter((f) => f.endsWith('.log'))) {
        const logContent = await fs.readFile(path.join(runsDir, file), 'utf-8');
        console.log(`\n📄 Log file: ${file}`);
        console.log('─'.repeat(60));
        console.log(logContent.slice(0, 1500));
        if (logContent.length > 1500) console.log('...(truncated)');
        console.log('─'.repeat(60));
      }
    } catch {
      // ignore
    }

    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
  });

  it('should verify Judge-to-StateTransition correspondence', { timeout: SMOKE_TEST_CONFIG.timeout }, async () => {
    if (shouldSkipSmokeTest()) return;

    console.log('\n🧪 Test: Judge判定 → 状態遷移の対応関係を検証');
    console.log(`   Model: ${SMOKE_TEST_CONFIG.model}`);

    const state: SmokeTestState = { tasks: new Map(), session: null, lastJudgementResult: null };
    const deps = createSmokeTestLeaderDeps(state, { testProjectPath, coordRepoPath });

    const task = createInitialTask({
      id: taskId('smoke-task-1'),
      repo: repoPath(testProjectPath),
      branch: branchName('feature/smoke-test'),
      scopePaths: ['hello.ts'],
      acceptance: 'Read the hello.ts file and explain what the greet function does',
      taskType: 'investigation',
      context: 'Analyze the existing code',
      dependencies: [],
    });
    task.state = TaskState.READY;
    await deps.taskStore.createTask(task);

    const session = createLeaderSession('smoke-session-1', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 1;

    console.log('\n   🚀 Executing Leader loop...\n');

    const result = await executeLeaderLoop(deps, session, [task]);

    // === 検証 ===
    console.log('\n   ✅ 検証開始: Judge判定と状態遷移の対応関係\n');

    assert.ok(!isErr(result), 'Leader loop should complete without error');

    const { session: finalSession, completedTaskIds, failedTaskIds, pendingEscalation } = result.val;
    const judgement = state.lastJudgementResult;

    assert.ok(judgement, 'Judge should have evaluated the task');

    console.log(`   Judge判定結果:`);
    console.log(`     success: ${judgement.success}`);
    console.log(`     shouldContinue: ${judgement.shouldContinue}`);
    console.log(`     shouldReplan: ${judgement.shouldReplan}`);
    console.log(`   最終状態:`);
    console.log(`     Session status: ${finalSession.status}`);
    console.log(`     Completed: ${completedTaskIds.length}`);
    console.log(`     Failed: ${failedTaskIds.length}`);
    console.log(`     Escalation: ${pendingEscalation?.target ?? 'none'}`);

    // Judge判定と状態遷移の対応を検証
    if (judgement.success) {
      // success=true → タスク完了
      assert.ok(
        completedTaskIds.length > 0 || finalSession.status === LeaderSessionStatus.COMPLETED,
        `When Judge returns success=true, task should be completed. Got: completed=${completedTaskIds.length}, status=${finalSession.status}`,
      );
      console.log('\n   ✅ 検証成功: success=true → タスク完了');
    } else if (judgement.shouldReplan) {
      // shouldReplan=true → PLANNERエスカレーション
      const hasPlannerEscalation =
        pendingEscalation?.target === 'planner' ||
        finalSession.escalationRecords.some((r) => r.target === EscalationTarget.PLANNER);
      assert.ok(
        hasPlannerEscalation || finalSession.status === LeaderSessionStatus.ESCALATING,
        `When Judge returns shouldReplan=true, should escalate to PLANNER. Got: escalation=${pendingEscalation?.target}, status=${finalSession.status}`,
      );
      console.log('\n   ✅ 検証成功: shouldReplan=true → PLANNERエスカレーション');
    } else if (judgement.shouldContinue) {
      // shouldContinue=true → NEEDS_CONTINUATIONまたは再実行
      const taskState = state.tasks.get(task.id)?.state;
      assert.ok(
        taskState === TaskState.NEEDS_CONTINUATION ||
        finalSession.status === LeaderSessionStatus.EXECUTING ||
        failedTaskIds.length > 0,
        `When Judge returns shouldContinue=true, task should be marked for continuation. Got: taskState=${taskState}, status=${finalSession.status}`,
      );
      console.log('\n   ✅ 検証成功: shouldContinue=true → 継続/再実行');
    } else {
      // 失敗（その他） → USERエスカレーション
      const hasUserEscalation =
        pendingEscalation?.target === 'user' ||
        finalSession.escalationRecords.some((r) => r.target === EscalationTarget.USER);
      assert.ok(
        hasUserEscalation || finalSession.status === LeaderSessionStatus.ESCALATING,
        `When Judge returns failure, should escalate to USER. Got: escalation=${pendingEscalation?.target}, status=${finalSession.status}`,
      );
      console.log('\n   ✅ 検証成功: 失敗 → USERエスカレーション');
    }

    console.log('\n✅ Judge判定 → 状態遷移の対応関係検証完了');
  });

  it('should escalate to USER on task failure', { timeout: SMOKE_TEST_CONFIG.timeout }, async () => {
    if (shouldSkipSmokeTest()) return;

    console.log('\n🧪 Test: タスク失敗時のUSERエスカレーション検証');
    console.log(`   Model: ${SMOKE_TEST_CONFIG.model}`);

    const state: SmokeTestState = { tasks: new Map(), session: null, lastJudgementResult: null };
    const deps = createSmokeTestLeaderDeps(state, { testProjectPath, coordRepoPath });

    // 意図的に曖昧なタスク（失敗を誘発）
    const task = createInitialTask({
      id: taskId('smoke-ambiguous-task'),
      repo: repoPath(testProjectPath),
      branch: branchName('feature/ambiguous'),
      scopePaths: ['nonexistent.ts'],
      acceptance: 'Create something important',
      taskType: 'implementation',
      context: 'Ambiguous requirements',
      dependencies: [],
    });
    task.state = TaskState.READY;
    await deps.taskStore.createTask(task);

    const session = createLeaderSession('smoke-session-escalate', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 1;

    console.log('\n   🚀 Executing Leader loop with ambiguous task...\n');

    const result = await executeLeaderLoop(deps, session, [task]);

    // === 検証 ===
    console.log('\n   ✅ 検証開始: エスカレーション動作\n');

    assert.ok(!isErr(result), 'Leader loop should complete without error');

    const { session: finalSession, pendingEscalation, failedTaskIds } = result.val;
    const judgement = state.lastJudgementResult;

    assert.ok(judgement, 'Judge should have evaluated the task');

    console.log(`   Judge判定: success=${judgement.success}, reason=${judgement.reason.slice(0, 80)}...`);
    console.log(`   Session status: ${finalSession.status}`);
    console.log(`   Escalation records: ${finalSession.escalationRecords.length}`);

    // エスカレーションが発生したことを検証
    const hasEscalation =
      pendingEscalation !== undefined ||
      finalSession.escalationRecords.length > 0 ||
      finalSession.status === LeaderSessionStatus.ESCALATING;

    assert.ok(
      hasEscalation,
      `Task failure should trigger escalation. Got: status=${finalSession.status}, escalationRecords=${finalSession.escalationRecords.length}`,
    );

    // エスカレーションレコードの内容を検証
    if (finalSession.escalationRecords.length > 0) {
      const record = finalSession.escalationRecords[0]!;
      assert.ok(record.reason, 'Escalation record should have a reason');
      assert.ok(record.target, 'Escalation record should have a target');
      console.log(`\n   📋 Escalation Record:`);
      console.log(`     Target: ${record.target}`);
      console.log(`     Reason: ${record.reason.slice(0, 100)}...`);
    }

    if (pendingEscalation) {
      assert.ok(pendingEscalation.reason, 'Pending escalation should have a reason');
      console.log(`\n   📋 Pending Escalation:`);
      console.log(`     Target: ${pendingEscalation.target}`);
      console.log(`     Reason: ${pendingEscalation.reason.slice(0, 100)}...`);
    }

    // 失敗タスクが記録されていることを検証
    if (!judgement.success && !judgement.shouldContinue && !judgement.shouldReplan) {
      assert.ok(
        failedTaskIds.length > 0 || finalSession.status === LeaderSessionStatus.ESCALATING,
        'Failed task should be recorded or session should be escalating',
      );
    }

    console.log('\n✅ エスカレーション検証完了');
  });

  it('should record task history with Worker and Judge results', { timeout: SMOKE_TEST_CONFIG.timeout }, async () => {
    if (shouldSkipSmokeTest()) return;

    console.log('\n🧪 Test: タスク履歴の記録検証');
    console.log(`   Model: ${SMOKE_TEST_CONFIG.model}`);

    const state: SmokeTestState = { tasks: new Map(), session: null, lastJudgementResult: null };
    const deps = createSmokeTestLeaderDeps(state, { testProjectPath, coordRepoPath });

    const task = createInitialTask({
      id: taskId('smoke-history-task'),
      repo: repoPath(testProjectPath),
      branch: branchName('feature/history'),
      scopePaths: ['hello.ts'],
      acceptance: 'Read hello.ts and describe its content',
      taskType: 'investigation',
      context: 'File analysis task',
      dependencies: [],
    });
    task.state = TaskState.READY;
    await deps.taskStore.createTask(task);

    const session = createLeaderSession('smoke-session-history', '/test/plan.md');
    session.status = LeaderSessionStatus.EXECUTING;
    session.totalTaskCount = 1;

    console.log('\n   🚀 Executing Leader loop...\n');

    const result = await executeLeaderLoop(deps, session, [task]);

    // === 検証 ===
    console.log('\n   ✅ 検証開始: タスク履歴の記録\n');

    assert.ok(!isErr(result), 'Leader loop should complete without error');

    const { session: finalSession } = result.val;
    const judgement = state.lastJudgementResult;

    // Judge判定が実行されたことを検証
    assert.ok(judgement, 'Judge should have been called');
    assert.ok(judgement.taskId, 'Judge result should have taskId');
    assert.ok(typeof judgement.success === 'boolean', 'Judge result should have boolean success');
    assert.ok(judgement.reason, 'Judge result should have reason');

    console.log(`   Judge判定が記録されていることを確認:`);
    console.log(`     taskId: ${judgement.taskId}`);
    console.log(`     success: ${judgement.success}`);
    console.log(`     reason: ${judgement.reason.slice(0, 80)}...`);

    // セッションの状態遷移を検証
    assert.notStrictEqual(
      finalSession.status,
      LeaderSessionStatus.EXECUTING,
      'Session should have transitioned from EXECUTING',
    );

    const isValidFinalStatus =
      finalSession.status === LeaderSessionStatus.COMPLETED ||
      finalSession.status === LeaderSessionStatus.ESCALATING ||
      finalSession.status === LeaderSessionStatus.REVIEWING ||
      finalSession.status === LeaderSessionStatus.FAILED;

    assert.ok(
      isValidFinalStatus,
      `Session should be in a valid final status. Got: ${finalSession.status}`,
    );

    console.log(`   セッション状態遷移: EXECUTING → ${finalSession.status}`);

    // タスクがストアに存在することを確認
    const finalTask = state.tasks.get(task.id);
    assert.ok(finalTask, 'Task should exist in store');
    console.log(`   タスク最終状態: ${finalTask.state}`);

    console.log('\n✅ タスク履歴記録検証完了');
  });
});
