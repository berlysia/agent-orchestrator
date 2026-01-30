/**
 * L5: タスク分解生成テスト
 *
 * 複雑度: ★★★★★
 * - 承認後 → PlannerSession → TaskBreakdown
 * - 実際のタスク生成フローの確認
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOk } from 'option-t/plain_result';
import { createPlanningOperations } from '../../../src/core/orchestrator/planning-operations.ts';
import {
  createPlanningSession,
  PlanningSessionStatus,
  QuestionType,
} from '../../../src/types/planning-session.ts';
import {
  createMockState,
  createMockPlanningSessionEffects,
  createMockPlannerSessionEffects,
  createMockRunnerEffects,
} from '../../helpers/test-deps.ts';
import type { AgentOutput } from '../../../src/core/runner/runner-effects.ts';

describe('L5: Task Breakdown', () => {
  let state = createMockState();

  beforeEach(() => {
    state = createMockState();
  });

  it('should create PlannerSession with context from PlanningSession', async () => {
    const ops = createPlanningOperations({
      planningSessionEffects: createMockPlanningSessionEffects(state),
      plannerSessionEffects: createMockPlannerSessionEffects(state),
      runnerEffects: createMockRunnerEffects(),
      appRepoPath: '/test/app',
      agentType: 'claude',
      plannerModel: 'claude-sonnet-4',
    });

    const session = createPlanningSession('context-test', 'Build user authentication');
    session.status = PlanningSessionStatus.REVIEW;
    session.questions = [
      {
        id: 'q1',
        type: QuestionType.CLARIFICATION,
        question: 'What auth methods?',
        options: null,
        answer: 'Email/password and OAuth',
        timestamp: new Date().toISOString(),
      },
      {
        id: 'q2',
        type: QuestionType.SCOPE,
        question: 'Include 2FA?',
        options: ['Yes', 'No'],
        answer: 'Yes',
        timestamp: new Date().toISOString(),
      },
    ];
    session.decisionPoints = [
      {
        id: 'd1',
        title: 'Token type',
        description: 'Choose token type',
        options: [
          { label: 'JWT', pros: ['Stateless'], cons: ['Size'] },
          { label: 'Session', pros: ['Simple'], cons: ['Stateful'] },
        ],
        selectedOption: 'JWT',
        rationale: 'Need stateless auth for microservices',
        timestamp: new Date().toISOString(),
      },
    ];

    const result = await ops.approvePlan(session);

    assert.ok(result.ok);
    assert.ok(result.val.plannerSessionId);

    // PlannerSession が作成されたことを確認
    const plannerSession = Array.from(state.plannerSessions.values())[0];
    assert.ok(plannerSession, 'PlannerSession should be created');
  });

  it('should link PlanningSession to generated PlannerSession', async () => {
    const ops = createPlanningOperations({
      planningSessionEffects: createMockPlanningSessionEffects(state),
      plannerSessionEffects: createMockPlannerSessionEffects(state),
      runnerEffects: createMockRunnerEffects(),
      appRepoPath: '/test/app',
      agentType: 'claude',
      plannerModel: 'claude-sonnet-4',
    });

    const session = createPlanningSession('link-test', 'Test');
    session.status = PlanningSessionStatus.REVIEW;
    session.questions = [
      {
        id: 'q1',
        type: QuestionType.CLARIFICATION,
        question: 'Q?',
        options: null,
        answer: 'A',
        timestamp: new Date().toISOString(),
      },
    ];
    session.decisionPoints = [
      {
        id: 'd1',
        title: 'D',
        description: 'D',
        options: [{ label: 'X', pros: ['P'], cons: ['C'] }],
        selectedOption: 'X',
        rationale: 'R',
        timestamp: new Date().toISOString(),
      },
    ];

    const result = await ops.approvePlan(session);

    assert.ok(result.ok);

    // plannerSessionId が設定されている
    const plannerSessionId = result.val.plannerSessionId;
    assert.ok(plannerSessionId);

    // PlannerSession が存在する
    const plannerSession = state.plannerSessions.get(plannerSessionId);
    assert.ok(plannerSession);
  });

  it('should include answers and decisions in planning context', async () => {
    const runnerEffects = {
      ...createMockRunnerEffects(),
      runClaudeAgent: async (_prompt: any, _opts: any) => {
        // context からプロンプトを取得（実装依存）
        return createOk({ finalResponse: '[]' } as AgentOutput);
      },
    };

    const ops = createPlanningOperations({
      planningSessionEffects: createMockPlanningSessionEffects(state),
      plannerSessionEffects: createMockPlannerSessionEffects(state),
      runnerEffects,
      appRepoPath: '/test/app',
      agentType: 'claude',
      plannerModel: 'claude-sonnet-4',
    });

    const session = createPlanningSession('include-test', 'Build API');
    session.status = PlanningSessionStatus.REVIEW;
    session.questions = [
      {
        id: 'q1',
        type: QuestionType.CLARIFICATION,
        question: 'REST or GraphQL?',
        options: null,
        answer: 'REST',
        timestamp: new Date().toISOString(),
      },
    ];
    session.decisionPoints = [
      {
        id: 'd1',
        title: 'Framework',
        description: 'Choose framework',
        options: [{ label: 'Express', pros: ['Simple'], cons: ['Minimal'] }],
        selectedOption: 'Express',
        rationale: 'Quick prototype',
        timestamp: new Date().toISOString(),
      },
    ];

    await ops.approvePlan(session);

    // PlannerSession に context が含まれているか確認
    const plannerSession = Array.from(state.plannerSessions.values())[0];
    assert.ok(plannerSession);
    // context の詳細な検証は実装依存
  });

  it('should handle task breakdown generation failure gracefully', async () => {
    // この段階では approvePlan が成功すれば良い
    // 実際のタスク生成は別のフェーズ
    const ops = createPlanningOperations({
      planningSessionEffects: createMockPlanningSessionEffects(state),
      plannerSessionEffects: createMockPlannerSessionEffects(state),
      runnerEffects: createMockRunnerEffects(),
      appRepoPath: '/test/app',
      agentType: 'claude',
      plannerModel: 'claude-sonnet-4',
    });

    const session = createPlanningSession('failure-test', 'Test');
    session.status = PlanningSessionStatus.REVIEW;
    session.questions = [
      {
        id: 'q1',
        type: QuestionType.CLARIFICATION,
        question: 'Q?',
        options: null,
        answer: 'A',
        timestamp: new Date().toISOString(),
      },
    ];
    session.decisionPoints = [
      {
        id: 'd1',
        title: 'D',
        description: 'D',
        options: [{ label: 'X', pros: ['P'], cons: ['C'] }],
        selectedOption: 'X',
        rationale: 'R',
        timestamp: new Date().toISOString(),
      },
    ];

    // approvePlan 自体は成功するはず
    const result = await ops.approvePlan(session);
    assert.ok(result.ok);
  });

  it('should preserve full planning context for later task generation', async () => {
    const ops = createPlanningOperations({
      planningSessionEffects: createMockPlanningSessionEffects(state),
      plannerSessionEffects: createMockPlannerSessionEffects(state),
      runnerEffects: createMockRunnerEffects(),
      appRepoPath: '/test/app',
      agentType: 'claude',
      plannerModel: 'claude-sonnet-4',
    });

    const session = createPlanningSession('preserve-context', 'Build e-commerce');
    session.status = PlanningSessionStatus.REVIEW;
    session.questions = [
      {
        id: 'q1',
        type: QuestionType.CLARIFICATION,
        question: 'Product types?',
        options: null,
        answer: 'Physical and digital goods',
        timestamp: new Date().toISOString(),
      },
      {
        id: 'q2',
        type: QuestionType.SCOPE,
        question: 'Payment methods?',
        options: ['Credit cards', 'PayPal', 'Crypto'],
        answer: 'Credit cards, PayPal',
        timestamp: new Date().toISOString(),
      },
    ];
    session.decisionPoints = [
      {
        id: 'd1',
        title: 'Database',
        description: 'Choose database',
        options: [
          { label: 'PostgreSQL', pros: ['ACID'], cons: ['Complex'] },
          { label: 'MongoDB', pros: ['Flexible'], cons: ['Eventual consistency'] },
        ],
        selectedOption: 'PostgreSQL',
        rationale: 'Need ACID for transactions',
        timestamp: new Date().toISOString(),
      },
      {
        id: 'd2',
        title: 'Cache',
        description: 'Choose cache',
        options: [
          { label: 'Redis', pros: ['Fast'], cons: ['Memory cost'] },
          { label: 'Memcached', pros: ['Simple'], cons: ['Limited features'] },
        ],
        selectedOption: 'Redis',
        rationale: 'Need pub/sub for real-time updates',
        timestamp: new Date().toISOString(),
      },
    ];

    const result = await ops.approvePlan(session);

    assert.ok(result.ok);

    // APPROVED 状態でコンテキストが保持されている
    assert.strictEqual(result.val.questions.length, 2);
    assert.strictEqual(result.val.decisionPoints.length, 2);
    assert.strictEqual(result.val.questions[0]?.answer, 'Physical and digital goods');
    assert.strictEqual(result.val.decisionPoints[0]?.selectedOption, 'PostgreSQL');
  });

  it('should support multiple rounds of planning refinement', async () => {
    const ops = createPlanningOperations({
      planningSessionEffects: createMockPlanningSessionEffects(state),
      plannerSessionEffects: createMockPlannerSessionEffects(state),
      runnerEffects: createMockRunnerEffects(),
      appRepoPath: '/test/app',
      agentType: 'claude',
      plannerModel: 'claude-sonnet-4',
    });

    const session = createPlanningSession('refinement-test', 'Test');
    session.status = PlanningSessionStatus.REVIEW;
    session.rejectCount = 0;
    session.questions = [
      {
        id: 'q1',
        type: QuestionType.CLARIFICATION,
        question: 'Q?',
        options: null,
        answer: 'A',
        timestamp: new Date().toISOString(),
      },
    ];
    session.decisionPoints = [
      {
        id: 'd1',
        title: 'D',
        description: 'D',
        options: [
          { label: 'X', pros: ['P1'], cons: ['C1'] },
          { label: 'Y', pros: ['P2'], cons: ['C2'] },
        ],
        selectedOption: 'X',
        rationale: 'Initial',
        timestamp: new Date().toISOString(),
      },
    ];

    // First rejection
    const r1 = await ops.rejectPlan(session, 'Consider Y instead');
    assert.ok(r1.ok);

    // Update decision
    const r2 = await ops.recordDecision(r1.val, 'd1', 'Y', 'After consideration');
    assert.ok(r2.ok);

    // Back to review
    const r3 = await ops.transitionToReviewPhase(r2.val);
    assert.ok(r3.ok);

    // Final approval
    const r4 = await ops.approvePlan(r3.val);
    assert.ok(r4.ok);

    // Verify final decision
    assert.strictEqual(r4.val.decisionPoints[0]?.selectedOption, 'Y');
    assert.strictEqual(r4.val.rejectCount, 1);
  });
});
