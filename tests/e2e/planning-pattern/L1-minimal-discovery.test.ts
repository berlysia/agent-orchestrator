/**
 * L1: 最小 Discovery テスト
 *
 * 複雑度: ★☆☆☆☆
 * - 1質問 → 回答
 * - Discovery フェーズの基本動作確認
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

describe('L1: Minimal Discovery', () => {
  let state = createMockState();

  beforeEach(() => {
    state = createMockState();
  });

  it('should start a new session in DISCOVERY status', async () => {
    const mockResponse: AgentOutput = {
      finalResponse: JSON.stringify({
        questions: [
          {
            id: 'q1',
            type: 'clarification',
            question: 'What is the main goal of this feature?',
            options: null,
          },
        ],
      }),
    };

    const runnerEffects = {
      ...createMockRunnerEffects(),
      runClaudeAgent: async () => createOk(mockResponse),
    };

    const ops = createPlanningOperations({
      planningSessionEffects: createMockPlanningSessionEffects(state),
      plannerSessionEffects: createMockPlannerSessionEffects(state),
      runnerEffects,
      appRepoPath: '/test/app',
      agentType: 'claude',
      plannerModel: 'claude-sonnet-4',
    });

    const result = await ops.startNewSession('Build a user authentication system');

    assert.ok(result.ok, 'startNewSession should succeed');

    if (result.ok) {
      assert.strictEqual(result.val.status, PlanningSessionStatus.DISCOVERY);
      assert.strictEqual(result.val.instruction, 'Build a user authentication system');
      assert.strictEqual(result.val.questions.length, 1);
      assert.strictEqual(result.val.questions[0]?.id, 'q1');
    }
  });

  it('should parse question type correctly', async () => {
    const mockResponse: AgentOutput = {
      finalResponse: JSON.stringify({
        questions: [
          {
            id: 'q1',
            type: 'clarification',
            question: 'Clarification question',
            options: null,
          },
          {
            id: 'q2',
            type: 'scope',
            question: 'Scope question',
            options: ['Option A', 'Option B'],
          },
        ],
      }),
    };

    const runnerEffects = {
      ...createMockRunnerEffects(),
      runClaudeAgent: async () => createOk(mockResponse),
    };

    const ops = createPlanningOperations({
      planningSessionEffects: createMockPlanningSessionEffects(state),
      plannerSessionEffects: createMockPlannerSessionEffects(state),
      runnerEffects,
      appRepoPath: '/test/app',
      agentType: 'claude',
      plannerModel: 'claude-sonnet-4',
    });

    const result = await ops.startNewSession('Test instruction');

    assert.ok(result.ok);

    if (result.ok) {
      assert.strictEqual(result.val.questions[0]?.type, QuestionType.CLARIFICATION);
      assert.strictEqual(result.val.questions[1]?.type, QuestionType.SCOPE);
    }
  });

  it('should answer a single question', async () => {
    const ops = createPlanningOperations({
      planningSessionEffects: createMockPlanningSessionEffects(state),
      plannerSessionEffects: createMockPlannerSessionEffects(state),
      runnerEffects: createMockRunnerEffects(),
      appRepoPath: '/test/app',
      agentType: 'claude',
      plannerModel: 'claude-sonnet-4',
    });

    const session = createPlanningSession('test-session', 'Test instruction');
    session.questions = [
      {
        id: 'q1',
        type: QuestionType.CLARIFICATION,
        question: 'What is the goal?',
        options: null,
        answer: null,
        timestamp: new Date().toISOString(),
      },
    ];

    const result = await ops.answerQuestion(session, 'q1', 'Build a REST API');

    assert.ok(result.ok, 'answerQuestion should succeed');

    if (result.ok) {
      assert.strictEqual(result.val.questions[0]?.answer, 'Build a REST API');
      assert.strictEqual(result.val.currentQuestionIndex, 1);
    }
  });

  it('should save session after answering question', async () => {
    const ops = createPlanningOperations({
      planningSessionEffects: createMockPlanningSessionEffects(state),
      plannerSessionEffects: createMockPlannerSessionEffects(state),
      runnerEffects: createMockRunnerEffects(),
      appRepoPath: '/test/app',
      agentType: 'claude',
      plannerModel: 'claude-sonnet-4',
    });

    const session = createPlanningSession('save-test', 'Test');
    session.questions = [
      {
        id: 'q1',
        type: QuestionType.CLARIFICATION,
        question: 'Question?',
        options: null,
        answer: null,
        timestamp: new Date().toISOString(),
      },
    ];

    await ops.answerQuestion(session, 'q1', 'Answer');

    // セッションが保存されたか確認
    const savedSession = state.planningSessions.get('save-test');
    assert.ok(savedSession, 'Session should be saved');
    assert.strictEqual(savedSession?.questions[0]?.answer, 'Answer');
  });

  it('should return error for non-existent question', async () => {
    const ops = createPlanningOperations({
      planningSessionEffects: createMockPlanningSessionEffects(state),
      plannerSessionEffects: createMockPlannerSessionEffects(state),
      runnerEffects: createMockRunnerEffects(),
      appRepoPath: '/test/app',
      agentType: 'claude',
      plannerModel: 'claude-sonnet-4',
    });

    const session = createPlanningSession('error-test', 'Test');
    session.questions = [];

    const result = await ops.answerQuestion(session, 'non-existent', 'Answer');

    assert.ok(!result.ok, 'Should fail for non-existent question');
  });
});
