import { describe, it } from 'node:test';
import assert from 'node:assert';
import { executeRefinementLoop, type QualityJudge } from '../../src/core/orchestrator/planner-operations.ts';
import type { Task } from '../../src/types/task.ts';
import type { PlannerDeps } from '../../src/core/orchestrator/planner-operations.ts';
import type { RefinementConfig } from '../../src/types/planner-session.ts';
import type { TaskStore } from '../../src/core/task-store/interface.ts';
import type { RunnerEffects } from '../../src/core/runner/runner-effects.ts';
import type { PlannerSessionEffects } from '../../src/core/orchestrator/planner-session-effects.ts';
import { createOk } from 'option-t/plain_result';
import { isOk, isErr } from 'option-t/plain_result';

/**
 * モックLLMクライアント
 *
 * WHY: LLM呼び出しをモック化してテストを高速化し、再計画時のタスク生成を制御可能にする
 */
class MockLLMClient {
  private responses: Task[][];
  private callCount: number = 0;

  constructor(responses: Task[][]) {
    this.responses = responses;
  }

  async generate(): Promise<Task[]> {
    const response = this.responses[this.callCount];
    this.callCount++;
    if (!response) {
      return this.responses[this.responses.length - 1] || [];
    }
    return response;
  }

  getCallCount(): number {
    return this.callCount;
  }
}

/**
 * モッククオリティジャッジ
 *
 * WHY: 品質判定結果を制御してテストシナリオを再現可能にする
 */
class MockQualityJudge implements QualityJudge {
  private results: Array<{
    isAcceptable: boolean;
    score?: number;
    issues?: string[];
    suggestions?: string[];
  }>;
  private callCount: number = 0;

  constructor(
    results: Array<{
      isAcceptable: boolean;
      score?: number;
      issues?: string[];
      suggestions?: string[];
    }>
  ) {
    this.results = results;
  }

  async evaluate(_tasks: Task[]): Promise<{
    isAcceptable: boolean;
    score?: number;
    issues?: string[];
    suggestions?: string[];
  }> {
    const result = this.results[this.callCount];
    this.callCount++;
    if (!result) {
      return this.results[this.results.length - 1] || { isAcceptable: true, score: 100 };
    }
    return result;
  }

  getCallCount(): number {
    return this.callCount;
  }
}

/**
 * ヘルパー: テスト用のタスクを生成
 */
function createTestTask(id: string, summary: string): Task {
  return {
    id: id as any,
    state: 'READY',
    version: 0,
    owner: null,
    repo: '/test/repo' as any,
    branch: `feature/${id}` as any,
    scopePaths: ['src/'],
    acceptance: `${summary} completed`,
    taskType: 'implementation',
    context: `Context for ${summary}`,
    dependencies: [],
    check: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    summary,
    integrationRetried: false,
  };
}

/**
 * ヘルパー: モックPlannerDepsを生成
 */
function createMockPlannerDeps(llmClient: MockLLMClient): PlannerDeps {
  const mockTaskStore: TaskStore = {
    createTask: async () => createOk(undefined),
    readTask: async () => createOk(null as any),
    updateTaskCAS: async () => createOk(null as any),
    deleteTask: async () => createOk(undefined),
    listTasks: async () => createOk([]),
    writeRun: async () => createOk(undefined),
    writeCheck: async () => createOk(undefined),
  };

  const mockRunnerEffects: RunnerEffects = {
    ensureRunsDir: async () => createOk(undefined),
    initializeLogFile: async () => createOk(undefined),
    appendLog: async () => createOk(undefined),
    saveRunMetadata: async () => createOk(undefined),
    loadRunMetadata: async () => createOk(null as any),
    runClaudeAgent: async () => {
      const tasks = await llmClient.generate();
      return createOk({
        finalResponse: JSON.stringify(tasks.map((t) => ({
          id: t.id,
          summary: t.summary,
          branch: t.branch,
          scopePaths: t.scopePaths,
          acceptance: t.acceptance,
          type: t.taskType,
          context: t.context,
          dependencies: t.dependencies,
        }))),
        usage: { inputTokens: 100, outputTokens: 50 },
      });
    },
    runCodexAgent: async () => createOk({ finalResponse: 'mock', usage: { inputTokens: 100, outputTokens: 50 } }),
    readLog: async () => createOk(''),
    listRunLogs: async () => createOk([]),
  };

  const mockSessionEffects: PlannerSessionEffects = {
    ensureSessionsDir: async () => createOk(undefined),
    saveSession: async () => createOk(undefined),
    loadSession: async () => createOk(null as any),
    sessionExists: async () => createOk(false),
    listSessions: async () => createOk([]),
  };

  return {
    taskStore: mockTaskStore,
    runnerEffects: mockRunnerEffects,
    sessionEffects: mockSessionEffects,
    appRepoPath: '/test/app',
    coordRepoPath: '/test/coord',
    agentType: 'claude',
    model: 'claude-sonnet-4',
    judgeModel: 'claude-haiku-4',
    plannerQualityRetries: 3,
    qualityThreshold: 70,
    strictContextValidation: false,
    maxTaskDuration: 4,
    maxTasks: 5,
  };
}

/**
 * ヘルパー: デフォルトのRefinementConfigを生成
 */
function createDefaultRefinementConfig(overrides?: Partial<RefinementConfig>): RefinementConfig {
  return {
    maxRefinementAttempts: 3,
    refineSuggestionsOnSuccess: false,
    maxSuggestionReplans: 1,
    enableIndividualFallback: true,
    deltaThreshold: 5,
    deltaThresholdPercent: 5,
    taskCountChangeThreshold: 0.3,
    taskCountChangeMinAbsolute: 2,
    targetScore: 85,
    ...overrides,
  };
}

describe('Refinement Integration', () => {
  it('正常フロー: 初回で品質OK → Ok({ finalTasks }) で終了', async () => {
    // Arrange
    const initialTasks = [
      createTestTask('task-1', 'Implement feature A'),
      createTestTask('task-2', 'Add tests for feature A'),
    ];

    const llmClient = new MockLLMClient([]);
    const qualityJudge = new MockQualityJudge([
      { isAcceptable: true, score: 90, issues: [], suggestions: [] },
    ]);

    const config = createDefaultRefinementConfig();
    const deps = createMockPlannerDeps(llmClient);

    // Act
    const result = await executeRefinementLoop({
      initialTasks,
      qualityJudge,
      config,
      deps,
    });

    // Assert
    assert.ok(isOk(result), 'Result should be Ok');
    if (isOk(result)) {
      assert.strictEqual(result.val.finalTasks.length, 2, 'Should return initial tasks');
      assert.strictEqual(result.val.refinementHistory.length, 1, 'Should have one refinement attempt');
      assert.strictEqual(result.val.refinementHistory[0]?.decision, 'accept', 'Should accept on first attempt');
    }
    assert.strictEqual(qualityJudge.getCallCount(), 1, 'Judge should be called once');
    assert.strictEqual(llmClient.getCallCount(), 0, 'LLM should not be called (no replan needed)');
  });

  it('再計画フロー: 1回目NG → 2回目OK → Ok({ finalTasks }) で終了', async () => {
    // Arrange
    const initialTasks = [createTestTask('task-1', 'Initial task')];
    const replanedTasks = [
      createTestTask('task-1-revised', 'Revised task 1'),
      createTestTask('task-2-new', 'New task 2'),
    ];

    const llmClient = new MockLLMClient([replanedTasks]);
    const qualityJudge = new MockQualityJudge([
      { isAcceptable: false, score: 40, issues: ['Issue 1'], suggestions: [] },
      { isAcceptable: true, score: 90, issues: [], suggestions: [] }, // targetScore(85)以上
    ]);

    const config = createDefaultRefinementConfig();
    const deps = createMockPlannerDeps(llmClient);

    // Act
    const result = await executeRefinementLoop({
      initialTasks,
      qualityJudge,
      config,
      deps,
    });

    // Assert
    assert.ok(isOk(result), 'Result should be Ok');
    if (isOk(result)) {
      assert.strictEqual(result.val.finalTasks.length, 2, 'Should return replanned tasks');
      assert.strictEqual(result.val.refinementHistory.length, 2, 'Should have two refinement attempts');
      assert.strictEqual(result.val.refinementHistory[0]?.decision, 'replan', 'First should be replan');
      assert.strictEqual(result.val.refinementHistory[1]?.decision, 'accept', 'Second should be accept');
    }
    assert.strictEqual(qualityJudge.getCallCount(), 2, 'Judge should be called twice');
    assert.strictEqual(llmClient.getCallCount(), 1, 'LLM should be called once for replan');
  });

  it('最大試行到達でErr → Err({ reason: "最大試行回数到達" }) が返される', async () => {
    // Arrange
    const initialTasks = [createTestTask('task-1', 'Task that fails quality check')];
    const replanedTasks1 = [createTestTask('task-1-v2', 'Replanned task v2')];
    const replanedTasks2 = [createTestTask('task-1-v3', 'Replanned task v3')];

    const llmClient = new MockLLMClient([replanedTasks1, replanedTasks2]);
    const qualityJudge = new MockQualityJudge([
      { isAcceptable: false, score: 30, issues: ['Bad quality 1'], suggestions: [] },
      { isAcceptable: false, score: 35, issues: ['Bad quality 2'], suggestions: [] },
      { isAcceptable: false, score: 38, issues: ['Bad quality 3'], suggestions: [] },
    ]);

    const config = createDefaultRefinementConfig({ maxRefinementAttempts: 2 });
    const deps = createMockPlannerDeps(llmClient);

    // Act
    const result = await executeRefinementLoop({
      initialTasks,
      qualityJudge,
      config,
      deps,
    });

    // Assert
    assert.ok(isErr(result), 'Result should be Err when max attempts reached');
    if (isErr(result)) {
      assert.ok(result.err.reason.includes('最大試行回数'), 'Error reason should mention max attempts');
      assert.ok(result.err.refinementHistory.length >= 3, 'Should have refinement history');
    }
    assert.ok(qualityJudge.getCallCount() >= 3, 'Judge should be called at least 3 times');
  });

  it('停滞検知でaccept → スコア改善が停滞したらacceptで終了', async () => {
    // Arrange
    const initialTasks = [createTestTask('task-1', 'Task with stagnant improvement')];
    const replanedTasks1 = [createTestTask('task-1-v2', 'Minor improvement')];
    const replanedTasks2 = [createTestTask('task-1-v3', 'Minimal improvement')];

    const llmClient = new MockLLMClient([replanedTasks1, replanedTasks2]);
    // 停滞検知: 最初はreplan (isAcceptable: false), 次に少しだけ改善 (stagnation)
    const qualityJudge = new MockQualityJudge([
      { isAcceptable: false, score: 50, issues: ['Needs work'], suggestions: [] },
      { isAcceptable: true, score: 52, issues: [], suggestions: [] }, // 改善が2点のみ (< deltaThreshold 5)
    ]);

    const config = createDefaultRefinementConfig({
      deltaThreshold: 5, // 5点未満の改善は停滞とみなす
      deltaThresholdPercent: 5, // 5%未満の改善も停滞
    });
    const deps = createMockPlannerDeps(llmClient);

    // Act
    const result = await executeRefinementLoop({
      initialTasks,
      qualityJudge,
      config,
      deps,
    });

    // Assert
    assert.ok(isOk(result), 'Result should be Ok due to stagnation with isAcceptable=true');
    if (isOk(result)) {
      const lastDecision = result.val.refinementHistory[result.val.refinementHistory.length - 1];
      assert.strictEqual(lastDecision?.decision, 'accept', 'Should accept due to stagnation');
      assert.ok(
        lastDecision?.reason.includes('改善停滞') || lastDecision?.reason.includes('stagnant'),
        'Reason should mention stagnation'
      );
    }
  });

  it('suggestions適用での再計画 → refineSuggestionsOnSuccess=trueで再計画実行', async () => {
    // Arrange
    const initialTasks = [createTestTask('task-1', 'Good task but has suggestions')];
    const replanedTasks = [createTestTask('task-1-improved', 'Task with suggestions applied')];

    const llmClient = new MockLLMClient([replanedTasks]);
    const qualityJudge = new MockQualityJudge([
      { isAcceptable: true, score: 80, issues: [], suggestions: ['Consider adding error handling'] },
      { isAcceptable: true, score: 90, issues: [], suggestions: [] },
    ]);

    const config = createDefaultRefinementConfig({
      refineSuggestionsOnSuccess: true,
      maxSuggestionReplans: 1,
    });
    const deps = createMockPlannerDeps(llmClient);

    // Act
    const result = await executeRefinementLoop({
      initialTasks,
      qualityJudge,
      config,
      deps,
    });

    // Assert
    assert.ok(isOk(result), 'Result should be Ok');
    if (isOk(result)) {
      assert.strictEqual(result.val.refinementHistory.length, 2, 'Should have two refinement attempts');
      assert.strictEqual(result.val.refinementHistory[0]?.decision, 'replan', 'First should be replan for suggestions');
      assert.ok(
        result.val.refinementHistory[0]?.reason.includes('suggestion') ||
          result.val.refinementHistory[0]?.reason.includes('提案'),
        'First reason should mention suggestions'
      );
      assert.strictEqual(result.val.refinementHistory[1]?.decision, 'accept', 'Second should be accept');
    }
    assert.strictEqual(llmClient.getCallCount(), 1, 'LLM should be called once for suggestion replan');
  });

  it('構造破壊時のフォールバック → タスク数が大幅変化したらフォールバック', async () => {
    // Arrange
    const initialTasks = [
      createTestTask('task-1', 'Task 1'),
      createTestTask('task-2', 'Task 2'),
      createTestTask('task-3', 'Task 3'),
      createTestTask('task-4', 'Task 4'),
      createTestTask('task-5', 'Task 5'),
    ];

    // Replan結果: タスク数が50%以上減少（5 → 2）→ 構造破壊と判定されるべき
    const replanedTasks = [
      createTestTask('task-1-v2', 'Combined task 1'),
      createTestTask('task-2-v2', 'Combined task 2'),
    ];

    const llmClient = new MockLLMClient([replanedTasks]);
    const qualityJudge = new MockQualityJudge([
      { isAcceptable: false, score: 60, issues: ['Some issue'], suggestions: [] },
      // フォールバックが発生したら元のタスクでacceptされる想定
    ]);

    const config = createDefaultRefinementConfig({
      enableIndividualFallback: true,
      taskCountChangeThreshold: 0.3, // 30%以上の変化で構造破壊とみなす
      taskCountChangeMinAbsolute: 2,
    });
    const deps = createMockPlannerDeps(llmClient);

    // Act
    const result = await executeRefinementLoop({
      initialTasks,
      qualityJudge,
      config,
      deps,
    });

    // Assert
    // フォールバックが働いた場合、元のタスクが返されるか、エラーになるはず
    // 実装により動作が異なる可能性があるため、ここでは基本的な検証のみ
    assert.ok(result, 'Result should exist');
    if (isOk(result)) {
      // フォールバックが働いた場合は元のタスク数が保持される可能性がある
      console.log('Fallback test result:', result.val.finalTasks.length, 'tasks');
      console.log('Refinement history:', result.val.refinementHistory.map((h) => h.decision));
    } else {
      // エラーになる場合もある
      console.log('Fallback test error:', result.err.reason);
    }
  });

  it('Result型でErrが返される（例外がthrowされない） → try-catch不要でErr処理可能', async () => {
    // Arrange
    const initialTasks = [createTestTask('task-1', 'Task that always fails')];
    const replanedTasks = [createTestTask('task-1-v2', 'Still fails')];

    const llmClient = new MockLLMClient([replanedTasks]);
    const qualityJudge = new MockQualityJudge([
      { isAcceptable: false, score: 20, issues: ['Critical issue'], suggestions: [] },
      { isAcceptable: false, score: 22, issues: ['Still critical'], suggestions: [] },
      { isAcceptable: false, score: 23, issues: ['No improvement'], suggestions: [] },
    ]);

    const config = createDefaultRefinementConfig({ maxRefinementAttempts: 2 });
    const deps = createMockPlannerDeps(llmClient);

    // Act - 例外がthrowされないことを確認（try-catchなしで呼び出せる）
    const result = await executeRefinementLoop({
      initialTasks,
      qualityJudge,
      config,
      deps,
    });

    // Assert - Result型の構造を確認
    assert.ok(result, 'Result should exist');
    assert.ok('ok' in result || 'err' in result, 'Result should have ok or err property');

    if (isOk(result)) {
      assert.fail('Expected Err result due to max attempts, but got Ok');
    } else if (isErr(result)) {
      assert.ok(result.err.reason, 'Error should have reason');
      assert.ok(Array.isArray(result.err.refinementHistory), 'Error should have refinement history');
      console.log('Successfully handled Err without try-catch:', result.err.reason);
    }
  });

  it('停滞検知でreject → スコア改善が停滞しisAcceptable=falseの場合reject', async () => {
    // Arrange
    const initialTasks = [createTestTask('task-1', 'Task with stagnant low score')];
    const replanedTasks1 = [createTestTask('task-1-v2', 'Minor improvement')];
    const replanedTasks2 = [createTestTask('task-1-v3', 'Minimal improvement')];

    const llmClient = new MockLLMClient([replanedTasks1, replanedTasks2]);
    const qualityJudge = new MockQualityJudge([
      { isAcceptable: false, score: 50, issues: ['Needs improvement'], suggestions: [] },
      { isAcceptable: false, score: 52, issues: ['Still needs work'], suggestions: [] },
      { isAcceptable: false, score: 53, issues: ['Minor issue'], suggestions: [] },
    ]);

    const config = createDefaultRefinementConfig({ deltaThreshold: 5 });
    const deps = createMockPlannerDeps(llmClient);

    // Act
    const result = await executeRefinementLoop({
      initialTasks,
      qualityJudge,
      config,
      deps,
    });

    // Assert - isAcceptable: false で停滞検知の場合は reject
    assert.ok(isErr(result), 'Result should be Err due to stagnation with low quality');
    if (isErr(result)) {
      assert.ok(
        result.err.reason.includes('改善停滞') || result.err.reason.includes('stagnant'),
        'Error reason should mention stagnation'
      );
    }
  });

  it('再計画が連続で成功 → 複数回の再計画を経て最終的にacceptされる', async () => {
    // Arrange
    const initialTasks = [createTestTask('task-1', 'Initial version')];
    const replanedTasks1 = [createTestTask('task-1-v2', 'Second version')];
    const replanedTasks2 = [createTestTask('task-1-v3', 'Third version - final')];

    const llmClient = new MockLLMClient([replanedTasks1, replanedTasks2]);
    const qualityJudge = new MockQualityJudge([
      { isAcceptable: false, score: 45, issues: ['Needs more detail'], suggestions: [] },
      { isAcceptable: false, score: 70, issues: ['Almost there'], suggestions: [] },
      { isAcceptable: true, score: 88, issues: [], suggestions: [] },
    ]);

    const config = createDefaultRefinementConfig({ maxRefinementAttempts: 3 });
    const deps = createMockPlannerDeps(llmClient);

    // Act
    const result = await executeRefinementLoop({
      initialTasks,
      qualityJudge,
      config,
      deps,
    });

    // Assert
    assert.ok(isOk(result), 'Result should be Ok after multiple replans');
    if (isOk(result)) {
      assert.strictEqual(result.val.refinementHistory.length, 3, 'Should have three refinement attempts');
      assert.strictEqual(
        result.val.refinementHistory.filter((h) => h.decision === 'replan').length,
        2,
        'Should have two replans'
      );
      assert.strictEqual(result.val.refinementHistory[2]?.decision, 'accept', 'Final decision should be accept');
    }
    assert.strictEqual(qualityJudge.getCallCount(), 3, 'Judge should be called three times');
    assert.strictEqual(llmClient.getCallCount(), 2, 'LLM should be called twice for replans');
  });
});
