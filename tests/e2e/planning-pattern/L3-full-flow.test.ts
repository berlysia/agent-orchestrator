/**
 * L3: 完全フローテスト
 *
 * 複雑度: ★★★☆☆
 * - Discovery → Design → Review → Approved
 * - 完全なプランニングフローの動作確認
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

describe('L3: Full Planning Flow', () => {
  let state = createMockState();

  beforeEach(() => {
    state = createMockState();
  });

  it('should complete full flow: Discovery → Design → Review → Approved', async () => {
    let callCount = 0;

    // Discovery: 質問を返す
    // Design: 決定ポイントを返す
    const runnerEffects = {
      ...createMockRunnerEffects(),
      runClaudeAgent: async () => {
        callCount++;
        if (callCount === 1) {
          // Discovery phase
          return createOk({
            finalResponse: JSON.stringify({
              questions: [
                {
                  id: 'q1',
                  type: 'clarification',
                  question: 'What is the target platform?',
                  options: null,
                },
              ],
            }),
          } as AgentOutput);
        }
        // Design phase
        return createOk({
          finalResponse: JSON.stringify({
            decisionPoints: [
              {
                id: 'd1',
                title: 'Framework',
                description: 'Choose framework',
                options: [
                  { label: 'Express', pros: ['Fast'], cons: ['Minimal'] },
                  { label: 'NestJS', pros: ['Full-featured'], cons: ['Complex'] },
                ],
              },
            ],
          }),
        } as AgentOutput);
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

    // Step 1: Start session (Discovery)
    const startResult = await ops.startNewSession('Build API server');
    assert.ok(startResult.ok);
    let session = startResult.val;
    assert.strictEqual(session.status, PlanningSessionStatus.DISCOVERY);

    // Step 2: Answer question
    const answerResult = await ops.answerQuestion(session, 'q1', 'Node.js backend');
    assert.ok(answerResult.ok);
    session = answerResult.val;

    // Step 3: Transition to Design
    const designResult = await ops.transitionToDesignPhase(session);
    assert.ok(designResult.ok);
    session = designResult.val;
    assert.strictEqual(session.status, PlanningSessionStatus.DESIGN);

    // Step 4: Record decision
    const decisionResult = await ops.recordDecision(
      session,
      'd1',
      'Express',
      'Need lightweight solution',
    );
    assert.ok(decisionResult.ok);
    session = decisionResult.val;

    // Step 5: Transition to Review
    const reviewResult = await ops.transitionToReviewPhase(session);
    assert.ok(reviewResult.ok);
    session = reviewResult.val;
    assert.strictEqual(session.status, PlanningSessionStatus.REVIEW);

    // Step 6: Approve plan
    const approveResult = await ops.approvePlan(session);
    assert.ok(approveResult.ok);
    session = approveResult.val;
    assert.strictEqual(session.status, PlanningSessionStatus.APPROVED);
    assert.ok(session.plannerSessionId, 'Should have plannerSessionId');
  });

  it('should preserve answers and decisions throughout flow', async () => {
    const runnerEffects = {
      ...createMockRunnerEffects(),
      runClaudeAgent: async () =>
        createOk({
          finalResponse: JSON.stringify({
            decisionPoints: [
              {
                id: 'd1',
                title: 'Test',
                description: 'Test decision',
                options: [{ label: 'A', pros: ['X'], cons: ['Y'] }],
              },
            ],
          }),
        } as AgentOutput),
    };

    const ops = createPlanningOperations({
      planningSessionEffects: createMockPlanningSessionEffects(state),
      plannerSessionEffects: createMockPlannerSessionEffects(state),
      runnerEffects,
      appRepoPath: '/test/app',
      agentType: 'claude',
      plannerModel: 'claude-sonnet-4',
    });

    const session = createPlanningSession('preserve-test', 'Test');
    session.status = PlanningSessionStatus.DISCOVERY;
    session.questions = [
      {
        id: 'q1',
        type: QuestionType.CLARIFICATION,
        question: 'Question?',
        options: null,
        answer: 'Important answer',
        timestamp: new Date().toISOString(),
      },
    ];

    // Transition through phases
    const designResult = await ops.transitionToDesignPhase(session);
    assert.ok(designResult.ok);

    // Answer should be preserved
    assert.strictEqual(
      designResult.val.questions[0]?.answer,
      'Important answer',
      'Answer should be preserved',
    );

    // Record decision
    const decisionResult = await ops.recordDecision(
      designResult.val,
      'd1',
      'A',
      'Reason A',
    );
    assert.ok(decisionResult.ok);

    // Transition to review
    const reviewResult = await ops.transitionToReviewPhase(decisionResult.val);
    assert.ok(reviewResult.ok);

    // Both answer and decision should be preserved
    assert.strictEqual(reviewResult.val.questions[0]?.answer, 'Important answer');
    assert.strictEqual(reviewResult.val.decisionPoints[0]?.selectedOption, 'A');
  });

  it('should create PlannerSession on approval', async () => {
    const ops = createPlanningOperations({
      planningSessionEffects: createMockPlanningSessionEffects(state),
      plannerSessionEffects: createMockPlannerSessionEffects(state),
      runnerEffects: createMockRunnerEffects(),
      appRepoPath: '/test/app',
      agentType: 'claude',
      plannerModel: 'claude-sonnet-4',
    });

    const session = createPlanningSession('approve-test', 'Test');
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
        description: 'Decision',
        options: [{ label: 'X', pros: ['P'], cons: ['C'] }],
        selectedOption: 'X',
        rationale: 'R',
        timestamp: new Date().toISOString(),
      },
    ];

    const result = await ops.approvePlan(session);

    assert.ok(result.ok);
    assert.ok(result.val.plannerSessionId?.startsWith('planner-'));

    // PlannerSession が作成されたか確認
    assert.ok(
      state.plannerSessions.size > 0,
      'PlannerSession should be created',
    );
  });

  it('should fail to approve if not in REVIEW status', async () => {
    const ops = createPlanningOperations({
      planningSessionEffects: createMockPlanningSessionEffects(state),
      plannerSessionEffects: createMockPlannerSessionEffects(state),
      runnerEffects: createMockRunnerEffects(),
      appRepoPath: '/test/app',
      agentType: 'claude',
      plannerModel: 'claude-sonnet-4',
    });

    const session = createPlanningSession('wrong-status', 'Test');
    session.status = PlanningSessionStatus.DESIGN; // Wrong status

    const result = await ops.approvePlan(session);

    assert.ok(!result.ok, 'Should fail when not in REVIEW status');
  });

  it('should track session progress through phases', async () => {
    const runnerEffects = {
      ...createMockRunnerEffects(),
      runClaudeAgent: async () =>
        createOk({
          finalResponse: JSON.stringify({
            decisionPoints: [
              {
                id: 'd1',
                title: 'Test',
                description: 'Test',
                options: [{ label: 'A', pros: ['P'], cons: ['C'] }],
              },
            ],
          }),
        } as AgentOutput),
    };

    const ops = createPlanningOperations({
      planningSessionEffects: createMockPlanningSessionEffects(state),
      plannerSessionEffects: createMockPlannerSessionEffects(state),
      runnerEffects,
      appRepoPath: '/test/app',
      agentType: 'claude',
      plannerModel: 'claude-sonnet-4',
    });

    const session = createPlanningSession('progress-test', 'Test');
    session.status = PlanningSessionStatus.DISCOVERY;
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

    const statusHistory: string[] = [session.status];

    // DISCOVERY → DESIGN
    const r1 = await ops.transitionToDesignPhase(session);
    assert.ok(r1.ok);
    statusHistory.push(r1.val.status);

    // Record decision
    const r2 = await ops.recordDecision(r1.val, 'd1', 'A', 'R');
    assert.ok(r2.ok);

    // DESIGN → REVIEW
    const r3 = await ops.transitionToReviewPhase(r2.val);
    assert.ok(r3.ok);
    statusHistory.push(r3.val.status);

    // REVIEW → APPROVED
    const r4 = await ops.approvePlan(r3.val);
    assert.ok(r4.ok);
    statusHistory.push(r4.val.status);

    assert.deepStrictEqual(statusHistory, [
      PlanningSessionStatus.DISCOVERY,
      PlanningSessionStatus.DESIGN,
      PlanningSessionStatus.REVIEW,
      PlanningSessionStatus.APPROVED,
    ]);
  });
});
