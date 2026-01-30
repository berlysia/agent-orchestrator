/**
 * L2: Design Phase テスト
 *
 * 複雑度: ★★☆☆☆
 * - Discovery 完了 → 設計決定
 * - Design フェーズへの遷移
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

describe('L2: Design Phase', () => {
  let state = createMockState();

  beforeEach(() => {
    state = createMockState();
  });

  it('should transition from DISCOVERY to DESIGN', async () => {
    const designResponse: AgentOutput = {
      finalResponse: JSON.stringify({
        decisionPoints: [
          {
            id: 'd1',
            title: 'Architecture choice',
            description: 'Choose the system architecture',
            options: [
              { label: 'Monolithic', pros: ['Simple'], cons: ['Hard to scale'] },
              { label: 'Microservices', pros: ['Scalable'], cons: ['Complex'] },
            ],
          },
        ],
      }),
    };

    const runnerEffects = {
      ...createMockRunnerEffects(),
      runClaudeAgent: async () => createOk(designResponse),
    };

    const ops = createPlanningOperations({
      planningSessionEffects: createMockPlanningSessionEffects(state),
      plannerSessionEffects: createMockPlannerSessionEffects(state),
      runnerEffects,
      appRepoPath: '/test/app',
      agentType: 'claude',
      plannerModel: 'claude-sonnet-4',
    });

    const session = createPlanningSession('test-session', 'Build auth system');
    session.status = PlanningSessionStatus.DISCOVERY;
    session.questions = [
      {
        id: 'q1',
        type: QuestionType.CLARIFICATION,
        question: 'What is the goal?',
        options: null,
        answer: 'Build user authentication',
        timestamp: new Date().toISOString(),
      },
    ];

    const result = await ops.transitionToDesignPhase(session);

    assert.ok(result.ok, 'transitionToDesignPhase should succeed');

    if (result.ok) {
      assert.strictEqual(result.val.status, PlanningSessionStatus.DESIGN);
      assert.strictEqual(result.val.decisionPoints.length, 1);
      assert.strictEqual(result.val.decisionPoints[0]?.id, 'd1');
      assert.strictEqual(result.val.decisionPoints[0]?.title, 'Architecture choice');
    }
  });

  it('should fail to transition if not in DISCOVERY status', async () => {
    const ops = createPlanningOperations({
      planningSessionEffects: createMockPlanningSessionEffects(state),
      plannerSessionEffects: createMockPlannerSessionEffects(state),
      runnerEffects: createMockRunnerEffects(),
      appRepoPath: '/test/app',
      agentType: 'claude',
      plannerModel: 'claude-sonnet-4',
    });

    const session = createPlanningSession('wrong-status', 'Test');
    session.status = PlanningSessionStatus.DESIGN; // Already in DESIGN

    const result = await ops.transitionToDesignPhase(session);

    assert.ok(!result.ok, 'Should fail when not in DISCOVERY status');
  });

  it('should record a design decision', async () => {
    const ops = createPlanningOperations({
      planningSessionEffects: createMockPlanningSessionEffects(state),
      plannerSessionEffects: createMockPlannerSessionEffects(state),
      runnerEffects: createMockRunnerEffects(),
      appRepoPath: '/test/app',
      agentType: 'claude',
      plannerModel: 'claude-sonnet-4',
    });

    const session = createPlanningSession('decision-test', 'Test');
    session.status = PlanningSessionStatus.DESIGN;
    session.decisionPoints = [
      {
        id: 'd1',
        title: 'Database choice',
        description: 'Choose database',
        options: [
          { label: 'PostgreSQL', pros: ['ACID'], cons: ['Complex setup'] },
          { label: 'MongoDB', pros: ['Flexible'], cons: ['No ACID'] },
        ],
        selectedOption: null,
        rationale: null,
        timestamp: new Date().toISOString(),
      },
    ];

    const result = await ops.recordDecision(
      session,
      'd1',
      'PostgreSQL',
      'Need ACID compliance for financial data',
    );

    assert.ok(result.ok, 'recordDecision should succeed');

    if (result.ok) {
      assert.strictEqual(result.val.decisionPoints[0]?.selectedOption, 'PostgreSQL');
      assert.strictEqual(
        result.val.decisionPoints[0]?.rationale,
        'Need ACID compliance for financial data',
      );
      assert.strictEqual(result.val.currentDecisionIndex, 1);
    }
  });

  it('should parse multiple decision points', async () => {
    const designResponse: AgentOutput = {
      finalResponse: JSON.stringify({
        decisionPoints: [
          {
            id: 'd1',
            title: 'Frontend framework',
            description: 'Choose frontend',
            options: [
              { label: 'React', pros: ['Popular'], cons: ['Learning curve'] },
              { label: 'Vue', pros: ['Simple'], cons: ['Smaller ecosystem'] },
            ],
          },
          {
            id: 'd2',
            title: 'State management',
            description: 'Choose state management',
            options: [
              { label: 'Redux', pros: ['Predictable'], cons: ['Boilerplate'] },
              { label: 'MobX', pros: ['Less code'], cons: ['Magic'] },
            ],
          },
        ],
      }),
    };

    const runnerEffects = {
      ...createMockRunnerEffects(),
      runClaudeAgent: async () => createOk(designResponse),
    };

    const ops = createPlanningOperations({
      planningSessionEffects: createMockPlanningSessionEffects(state),
      plannerSessionEffects: createMockPlannerSessionEffects(state),
      runnerEffects,
      appRepoPath: '/test/app',
      agentType: 'claude',
      plannerModel: 'claude-sonnet-4',
    });

    const session = createPlanningSession('multi-decision', 'Build UI');
    session.status = PlanningSessionStatus.DISCOVERY;
    session.questions = [
      {
        id: 'q1',
        type: QuestionType.CLARIFICATION,
        question: 'What kind of UI?',
        options: null,
        answer: 'Dashboard',
        timestamp: new Date().toISOString(),
      },
    ];

    const result = await ops.transitionToDesignPhase(session);

    assert.ok(result.ok);

    if (result.ok) {
      assert.strictEqual(result.val.decisionPoints.length, 2);
      assert.strictEqual(result.val.decisionPoints[0]?.id, 'd1');
      assert.strictEqual(result.val.decisionPoints[1]?.id, 'd2');
    }
  });

  it('should return error for non-existent decision', async () => {
    const ops = createPlanningOperations({
      planningSessionEffects: createMockPlanningSessionEffects(state),
      plannerSessionEffects: createMockPlannerSessionEffects(state),
      runnerEffects: createMockRunnerEffects(),
      appRepoPath: '/test/app',
      agentType: 'claude',
      plannerModel: 'claude-sonnet-4',
    });

    const session = createPlanningSession('no-decision', 'Test');
    session.decisionPoints = [];

    const result = await ops.recordDecision(session, 'non-existent', 'Option', 'Reason');

    assert.ok(!result.ok, 'Should fail for non-existent decision');
  });

  it('should save session after recording decision', async () => {
    const ops = createPlanningOperations({
      planningSessionEffects: createMockPlanningSessionEffects(state),
      plannerSessionEffects: createMockPlannerSessionEffects(state),
      runnerEffects: createMockRunnerEffects(),
      appRepoPath: '/test/app',
      agentType: 'claude',
      plannerModel: 'claude-sonnet-4',
    });

    const session = createPlanningSession('save-decision', 'Test');
    session.decisionPoints = [
      {
        id: 'd1',
        title: 'Test',
        description: 'Test decision',
        options: [{ label: 'A', pros: ['X'], cons: ['Y'] }],
        selectedOption: null,
        rationale: null,
        timestamp: new Date().toISOString(),
      },
    ];

    await ops.recordDecision(session, 'd1', 'A', 'Because A');

    const savedSession = state.planningSessions.get('save-decision');
    assert.ok(savedSession);
    assert.strictEqual(savedSession?.decisionPoints[0]?.selectedOption, 'A');
  });
});
