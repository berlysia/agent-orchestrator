import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createOk, createErr } from 'option-t/plain_result';
import { createPlanningOperations } from '../../../../src/core/orchestrator/planning-operations.ts';
import {
  createPlanningSession,
  PlanningSessionStatus,
  QuestionType,
} from '../../../../src/types/planning-session.ts';
import { ioError } from '../../../../src/types/errors.ts';
import type { RunnerError } from '../../../../src/types/errors.ts';
import type { PlanningSessionEffects } from '../../../../src/core/orchestrator/planning-session-effects.ts';
import type { PlannerSessionEffects } from '../../../../src/core/orchestrator/planner-session-effects.ts';
import type { RunnerEffects, AgentOutput } from '../../../../src/core/runner/runner-effects.ts';
import type { PlanningSession } from '../../../../src/types/planning-session.ts';
import { runId } from '../../../../src/types/branded.ts';

describe('PlanningOperations', () => {
  let mockPlanningSessionEffects: PlanningSessionEffects;
  let mockPlannerSessionEffects: PlannerSessionEffects;
  let mockRunnerEffects: RunnerEffects;
  let savedSessions: Map<string, PlanningSession>;

  beforeEach(() => {
    savedSessions = new Map();

    // Mock PlanningSessionEffects
    mockPlanningSessionEffects = {
      ensureSessionsDir: async () => createOk(undefined),
      saveSession: async (session) => {
        savedSessions.set(session.sessionId, session);
        return createOk(undefined);
      },
      loadSession: async (sessionId) => {
        const session = savedSessions.get(sessionId);
        if (!session) {
          return createErr(ioError('loadSession', new Error('Session not found')));
        }
        return createOk(session);
      },
      sessionExists: async (sessionId) => {
        return createOk(savedSessions.has(sessionId));
      },
      listSessions: async () => createOk([]),
      ensureLogsDir: async () => createOk(undefined),
      appendLog: async () => createOk(undefined),
    };

    // Mock PlannerSessionEffects
    mockPlannerSessionEffects = {
      ensureSessionsDir: async () => createOk(undefined),
      saveSession: async () => createOk(undefined),
      loadSession: async () => {
        return createErr(ioError('loadSession', new Error('Not implemented')));
      },
      sessionExists: async () => createOk(false),
      listSessions: async () => createOk([]),
    };

    // Mock RunnerEffects
    mockRunnerEffects = {
      runClaudeAgent: async () => {
        const mockResponse: AgentOutput = {
          finalResponse: JSON.stringify({
            questions: [
              {
                id: 'q1',
                type: 'clarification',
                question: 'What is the main goal?',
                options: null,
              },
              {
                id: 'q2',
                type: 'scope',
                question: 'What is the scope?',
                options: ['Full feature', 'Minimal feature'],
              },
            ],
          }),
        };
        return createOk(mockResponse);
      },
      runCodexAgent: async () => {
        const error: RunnerError = {
          type: 'AgentExecutionError',
          agentType: 'codex',
          message: 'Not implemented',
        };
        return createErr(error);
      },
      ensureRunsDir: async () => createOk(undefined),
      initializeLogFile: async () => createOk(undefined),
      appendLog: async () => createOk(undefined),
      saveRunMetadata: async () => createOk(undefined),
      loadRunMetadata: async () => {
        const error: RunnerError = {
          type: 'LogWriteError',
          runId: runId('test-run'),
          message: 'Not implemented',
        };
        return createErr(error);
      },
      readLog: async () => {
        const error: RunnerError = {
          type: 'LogWriteError',
          runId: runId('test-run'),
          message: 'Not implemented',
        };
        return createErr(error);
      },
      listRunLogs: async () => createOk([]),
    };
  });

  describe('startNewSession', () => {
    it('should create a new session in DISCOVERY status', async () => {
      const ops = createPlanningOperations({
        planningSessionEffects: mockPlanningSessionEffects,
        plannerSessionEffects: mockPlannerSessionEffects,
        runnerEffects: mockRunnerEffects,
        appRepoPath: '/test/app',
        agentType: 'claude',
        plannerModel: 'claude-sonnet-4',
      });

      const result = await ops.startNewSession('Test instruction');
      assert.ok(result.ok);

      if (result.ok) {
        assert.strictEqual(result.val.status, PlanningSessionStatus.DISCOVERY);
        assert.strictEqual(result.val.instruction, 'Test instruction');
        assert.strictEqual(result.val.questions.length, 2);
        assert.strictEqual(result.val.questions[0]?.id, 'q1');
        assert.strictEqual(result.val.questions[0]?.type, QuestionType.CLARIFICATION);
      }
    });

    it('should fail when LLM invocation fails', async () => {
      const failingRunnerEffects: RunnerEffects = {
        ...mockRunnerEffects,
        runClaudeAgent: async () => {
          const error: RunnerError = {
            type: 'AgentExecutionError',
            agentType: 'claude',
            message: 'LLM failed',
          };
          return createErr(error);
        },
      };

      const ops = createPlanningOperations({
        planningSessionEffects: mockPlanningSessionEffects,
        plannerSessionEffects: mockPlannerSessionEffects,
        runnerEffects: failingRunnerEffects,
        appRepoPath: '/test/app',
        agentType: 'claude',
        plannerModel: 'claude-sonnet-4',
      });

      const result = await ops.startNewSession('Test instruction');
      assert.ok(!result.ok);

      // セッションはFAILED状態で保存されているはず
      const sessions = Array.from(savedSessions.values());
      assert.strictEqual(sessions.length, 1);
      assert.strictEqual(sessions[0]?.status, PlanningSessionStatus.FAILED);
    });

    it('should fail when parsing questions fails', async () => {
      const invalidRunnerEffects: RunnerEffects = {
        ...mockRunnerEffects,
        runClaudeAgent: async () => {
          const mockResponse: AgentOutput = {
            finalResponse: 'Invalid JSON response',
          };
          return createOk(mockResponse);
        },
      };

      const ops = createPlanningOperations({
        planningSessionEffects: mockPlanningSessionEffects,
        plannerSessionEffects: mockPlannerSessionEffects,
        runnerEffects: invalidRunnerEffects,
        appRepoPath: '/test/app',
        agentType: 'claude',
        plannerModel: 'claude-sonnet-4',
      });

      const result = await ops.startNewSession('Test instruction');
      assert.ok(!result.ok);

      // リトライ後も失敗してFAILED状態になっているはず
      const sessions = Array.from(savedSessions.values());
      assert.ok(sessions.length >= 1);
      const lastSession = sessions[sessions.length - 1];
      assert.strictEqual(lastSession?.status, PlanningSessionStatus.FAILED);
    });
  });

  describe('answerQuestion', () => {
    it('should record answer to a question', async () => {
      const ops = createPlanningOperations({
        planningSessionEffects: mockPlanningSessionEffects,
        plannerSessionEffects: mockPlannerSessionEffects,
        runnerEffects: mockRunnerEffects,
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

      const result = await ops.answerQuestion(session, 'q1', 'My answer');
      assert.ok(result.ok);

      if (result.ok) {
        assert.strictEqual(result.val.questions[0]?.answer, 'My answer');
        assert.strictEqual(result.val.currentQuestionIndex, 1);
      }
    });

    it('should return error for non-existent question', async () => {
      const ops = createPlanningOperations({
        planningSessionEffects: mockPlanningSessionEffects,
        plannerSessionEffects: mockPlannerSessionEffects,
        runnerEffects: mockRunnerEffects,
        appRepoPath: '/test/app',
        agentType: 'claude',
        plannerModel: 'claude-sonnet-4',
      });

      const session = createPlanningSession('test-session', 'Test instruction');

      const result = await ops.answerQuestion(session, 'non-existent', 'My answer');
      assert.ok(!result.ok);
    });
  });

  describe('transitionToDesignPhase', () => {
    it('should transition from DISCOVERY to DESIGN', async () => {
      // Mock RunnerEffects for design phase
      const designRunnerEffects: RunnerEffects = {
        ...mockRunnerEffects,
        runClaudeAgent: async () => {
          const mockResponse: AgentOutput = {
            finalResponse: JSON.stringify({
              decisionPoints: [
                {
                  id: 'd1',
                  title: 'Architecture choice',
                  description: 'Choose the architecture',
                  options: [
                    {
                      label: 'Monolithic',
                      pros: ['Simple'],
                      cons: ['Harder to scale'],
                    },
                    {
                      label: 'Microservices',
                      pros: ['Scalable'],
                      cons: ['Complex'],
                    },
                  ],
                },
              ],
            }),
          };
          return createOk(mockResponse);
        },
      };

      const ops = createPlanningOperations({
        planningSessionEffects: mockPlanningSessionEffects,
        plannerSessionEffects: mockPlannerSessionEffects,
        runnerEffects: designRunnerEffects,
        appRepoPath: '/test/app',
        agentType: 'claude',
        plannerModel: 'claude-sonnet-4',
      });

      const session = createPlanningSession('test-session', 'Test instruction');
      session.status = PlanningSessionStatus.DISCOVERY;
      session.questions = [
        {
          id: 'q1',
          type: QuestionType.CLARIFICATION,
          question: 'What is the goal?',
          options: null,
          answer: 'Build a web app',
          timestamp: new Date().toISOString(),
        },
      ];

      const result = await ops.transitionToDesignPhase(session);
      assert.ok(result.ok);

      if (result.ok) {
        assert.strictEqual(result.val.status, PlanningSessionStatus.DESIGN);
        assert.strictEqual(result.val.decisionPoints.length, 1);
        assert.strictEqual(result.val.decisionPoints[0]?.id, 'd1');
      }
    });

    it('should fail if not in DISCOVERY status', async () => {
      const ops = createPlanningOperations({
        planningSessionEffects: mockPlanningSessionEffects,
        plannerSessionEffects: mockPlannerSessionEffects,
        runnerEffects: mockRunnerEffects,
        appRepoPath: '/test/app',
        agentType: 'claude',
        plannerModel: 'claude-sonnet-4',
      });

      const session = createPlanningSession('test-session', 'Test instruction');
      session.status = PlanningSessionStatus.DESIGN; // Wrong status

      const result = await ops.transitionToDesignPhase(session);
      assert.ok(!result.ok);
    });
  });

  describe('recordDecision', () => {
    it('should record a decision', async () => {
      const ops = createPlanningOperations({
        planningSessionEffects: mockPlanningSessionEffects,
        plannerSessionEffects: mockPlannerSessionEffects,
        runnerEffects: mockRunnerEffects,
        appRepoPath: '/test/app',
        agentType: 'claude',
        plannerModel: 'claude-sonnet-4',
      });

      const session = createPlanningSession('test-session', 'Test instruction');
      session.decisionPoints = [
        {
          id: 'd1',
          title: 'Architecture choice',
          description: 'Choose the architecture',
          options: [
            { label: 'Monolithic', pros: ['Simple'], cons: ['Hard to scale'] },
            { label: 'Microservices', pros: ['Scalable'], cons: ['Complex'] },
          ],
          selectedOption: null,
          rationale: null,
          timestamp: new Date().toISOString(),
        },
      ];

      const result = await ops.recordDecision(session, 'd1', 'Monolithic', 'Simpler for MVP');
      assert.ok(result.ok);

      if (result.ok) {
        assert.strictEqual(result.val.decisionPoints[0]?.selectedOption, 'Monolithic');
        assert.strictEqual(result.val.decisionPoints[0]?.rationale, 'Simpler for MVP');
        assert.strictEqual(result.val.currentDecisionIndex, 1);
      }
    });

    it('should return error for non-existent decision', async () => {
      const ops = createPlanningOperations({
        planningSessionEffects: mockPlanningSessionEffects,
        plannerSessionEffects: mockPlannerSessionEffects,
        runnerEffects: mockRunnerEffects,
        appRepoPath: '/test/app',
        agentType: 'claude',
        plannerModel: 'claude-sonnet-4',
      });

      const session = createPlanningSession('test-session', 'Test instruction');

      const result = await ops.recordDecision(session, 'non-existent', 'Option', 'Rationale');
      assert.ok(!result.ok);
    });
  });

  describe('rejectPlan', () => {
    it('should return to DESIGN phase on first rejection', async () => {
      const ops = createPlanningOperations({
        planningSessionEffects: mockPlanningSessionEffects,
        plannerSessionEffects: mockPlannerSessionEffects,
        runnerEffects: mockRunnerEffects,
        appRepoPath: '/test/app',
        agentType: 'claude',
        plannerModel: 'claude-sonnet-4',
      });

      const session = createPlanningSession('test-session', 'Test instruction');
      session.status = PlanningSessionStatus.REVIEW;
      session.rejectCount = 0;

      const result = await ops.rejectPlan(session, 'Need more details');
      assert.ok(result.ok);

      if (result.ok) {
        assert.strictEqual(result.val.status, PlanningSessionStatus.DESIGN);
        assert.strictEqual(result.val.rejectCount, 1);
      }
    });

    it('should transition to CANCELLED after 3 rejections', async () => {
      const ops = createPlanningOperations({
        planningSessionEffects: mockPlanningSessionEffects,
        plannerSessionEffects: mockPlannerSessionEffects,
        runnerEffects: mockRunnerEffects,
        appRepoPath: '/test/app',
        agentType: 'claude',
        plannerModel: 'claude-sonnet-4',
      });

      const session = createPlanningSession('test-session', 'Test instruction');
      session.status = PlanningSessionStatus.REVIEW;
      session.rejectCount = 2; // Already rejected twice

      const result = await ops.rejectPlan(session, 'Still not good enough');
      assert.ok(result.ok);

      if (result.ok) {
        assert.strictEqual(result.val.status, PlanningSessionStatus.CANCELLED);
        assert.strictEqual(result.val.rejectCount, 3);
      }
    });
  });

  describe('approvePlan', () => {
    it('should create PlannerSession and update status to APPROVED', async () => {
      const ops = createPlanningOperations({
        planningSessionEffects: mockPlanningSessionEffects,
        plannerSessionEffects: mockPlannerSessionEffects,
        runnerEffects: mockRunnerEffects,
        appRepoPath: '/test/app',
        agentType: 'claude',
        plannerModel: 'claude-sonnet-4',
      });

      const session = createPlanningSession('test-session', 'Test instruction');
      session.status = PlanningSessionStatus.REVIEW;
      session.questions = [
        {
          id: 'q1',
          type: QuestionType.CLARIFICATION,
          question: 'What is the goal?',
          options: null,
          answer: 'Build a web app',
          timestamp: new Date().toISOString(),
        },
      ];
      session.decisionPoints = [
        {
          id: 'd1',
          title: 'Architecture choice',
          description: 'Choose the architecture',
          options: [
            { label: 'Monolithic', pros: ['Simple'], cons: ['Hard to scale'] },
          ],
          selectedOption: 'Monolithic',
          rationale: 'Simpler for MVP',
          timestamp: new Date().toISOString(),
        },
      ];

      const result = await ops.approvePlan(session);
      assert.ok(result.ok);

      if (result.ok) {
        assert.strictEqual(result.val.status, PlanningSessionStatus.APPROVED);
        assert.ok(result.val.plannerSessionId);
        assert.ok(result.val.plannerSessionId?.startsWith('planner-'));
      }
    });

    it('should fail if not in REVIEW status', async () => {
      const ops = createPlanningOperations({
        planningSessionEffects: mockPlanningSessionEffects,
        plannerSessionEffects: mockPlannerSessionEffects,
        runnerEffects: mockRunnerEffects,
        appRepoPath: '/test/app',
        agentType: 'claude',
        plannerModel: 'claude-sonnet-4',
      });

      const session = createPlanningSession('test-session', 'Test instruction');
      session.status = PlanningSessionStatus.DESIGN; // Wrong status

      const result = await ops.approvePlan(session);
      assert.ok(!result.ok);
    });
  });
});
