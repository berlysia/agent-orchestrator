import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createOk, createErr } from 'option-t/plain_result';
import { ioError, agentExecutionError } from '../../src/types/errors.ts';
import { loadFromPlannerSession, loadFromPlanDocument } from '../../src/core/orchestrator/leader-input-loader.ts';
import type { PlannerSessionEffects } from '../../src/core/orchestrator/planner-session-effects.ts';
import type { RunnerEffects } from '../../src/core/runner/runner-effects.ts';
import type { PlannerSession } from '../../src/types/planner-session.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

describe('leader-input-loader', () => {
  describe('loadFromPlannerSession', () => {
    it('should load LeaderInput from valid PlannerSession', async () => {
      // モックPlannerSession
      const mockSession: PlannerSession = {
        sessionId: 'test-session-1',
        instruction: 'Implement authentication',
        conversationHistory: [],
        generatedTasks: [
          {
            id: 'task-1',
            description: 'Add JWT authentication',
            branch: 'feature/auth',
            scopePaths: ['src/auth/'],
            acceptance: 'JWT authentication works',
            type: 'implementation',
            estimatedDuration: 4,
            context: 'Implement JWT-based authentication',
            dependencies: [],
            summary: 'JWT auth',
          },
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        finalJudgement: null,
        continueIterationCount: 0,
      };

      // モック SessionEffects
      const mockSessionEffects: PlannerSessionEffects = {
        ensureSessionsDir: async () => createOk(undefined),
        saveSession: async () => createOk(undefined),
        loadSession: async (sessionId: string) => {
          assert.equal(sessionId, 'test-session-1');
          return createOk(mockSession);
        },
        sessionExists: async () => createOk(true),
        listSessions: async () => createOk([]),
      };

      // テスト実行
      const result = await loadFromPlannerSession('test-session-1', mockSessionEffects);

      // 検証
      assert.ok(result.ok);
      assert.equal(result.val.instruction, 'Implement authentication');
      assert.equal(result.val.tasks.length, 1);
      assert.equal(result.val.tasks[0]!.id, 'task-1');
      assert.equal(result.val.sourceType, 'planner-session');
      assert.equal(result.val.planDocumentContent, undefined);
    });

    it('should return error when PlannerSession does not exist', async () => {
      // モック SessionEffects (エラー返却)
      const mockSessionEffects: PlannerSessionEffects = {
        ensureSessionsDir: async () => createOk(undefined),
        saveSession: async () => createOk(undefined),
        loadSession: async () => createErr(ioError('Session not found')),
        sessionExists: async () => createOk(false),
        listSessions: async () => createOk([]),
      };

      // テスト実行
      const result = await loadFromPlannerSession('nonexistent', mockSessionEffects);

      // 検証
      assert.ok(!result.ok);
      assert.equal(result.err.type, 'IOError');
    });

    it('should return error when PlannerSession has no generated tasks', async () => {
      // モックPlannerSession (タスクなし)
      const mockSession: PlannerSession = {
        sessionId: 'test-session-2',
        instruction: 'Some instruction',
        conversationHistory: [],
        generatedTasks: [], // 空
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        finalJudgement: null,
        continueIterationCount: 0,
      };

      // モック SessionEffects
      const mockSessionEffects: PlannerSessionEffects = {
        ensureSessionsDir: async () => createOk(undefined),
        saveSession: async () => createOk(undefined),
        loadSession: async () => createOk(mockSession),
        sessionExists: async () => createOk(true),
        listSessions: async () => createOk([]),
      };

      // テスト実行
      const result = await loadFromPlannerSession('test-session-2', mockSessionEffects);

      // 検証
      assert.ok(!result.ok);
      assert.match(result.err.message, /no generated tasks/i);
    });
  });

  describe('loadFromPlanDocument', () => {
    it('should load LeaderInput from plan document with valid LLM output', async () => {
      // 一時計画文書を作成
      const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'leader-input-test-'));
      const planFile = path.join(tempDir, 'plan.md');
      const planContent = `
# Test Plan

## Tasks
- Task 1: Implement feature A
- Task 2: Implement feature B
`;
      await fs.writeFile(planFile, planContent, 'utf-8');

      // LLM の出力をモック
      const mockLLMOutput = JSON.stringify([
        {
          id: 'task-1',
          description: 'Implement feature A',
          branch: 'feature/a',
          scopePaths: ['src/a/'],
          acceptance: 'Feature A works',
          type: 'implementation',
          estimatedDuration: 2,
          context: 'Context for A',
          dependencies: [],
          summary: 'Feature A',
        },
        {
          id: 'task-2',
          description: 'Implement feature B',
          branch: 'feature/b',
          scopePaths: ['src/b/'],
          acceptance: 'Feature B works',
          type: 'implementation',
          estimatedDuration: 3,
          context: 'Context for B',
          dependencies: ['task-1'],
          summary: 'Feature B',
        },
      ]);

      // モック RunnerEffects
      const mockRunnerEffects: RunnerEffects = {
        runClaudeAgent: async (prompt: string) => {
          // LLM が呼び出されることを確認
          assert.ok(prompt.includes('Extract task breakdown'));
          return createOk({
            finalResponse: mockLLMOutput,
          });
        },
        runCodexAgent: async () => createOk({ finalResponse: mockLLMOutput }),
        ensureRunsDir: async () => createOk(undefined),
        initializeLogFile: async () => createOk(undefined),
        appendLog: async () => createOk(undefined),
        saveRunMetadata: async () => createOk(undefined),
        loadRunMetadata: async () => createErr(agentExecutionError('test', 'not implemented')),
        readLog: async () => createErr(agentExecutionError('test', 'not implemented')),
        listRunLogs: async () => createOk([]),
      };

      // テスト実行
      const result = await loadFromPlanDocument(planFile, mockRunnerEffects, 'claude', 'test-model', tempDir);

      // クリーンアップ
      await fs.rm(tempDir, { recursive: true, force: true });

      // 検証
      assert.ok(result.ok);
      assert.equal(result.val.instruction, 'Test Plan');
      assert.equal(result.val.tasks.length, 2);
      assert.equal(result.val.tasks[0]!.id, 'task-1');
      assert.equal(result.val.tasks[1]!.id, 'task-2');
      assert.deepEqual(result.val.tasks[1]!.dependencies, ['task-1']);
      assert.equal(result.val.sourceType, 'plan-document');
      assert.ok(result.val.planDocumentContent);
      assert.ok(result.val.planDocumentContent.includes('Test Plan'));
    });

    it('should handle LLM output with markdown code blocks', async () => {
      // 一時計画文書を作成
      const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'leader-input-test-'));
      const planFile = path.join(tempDir, 'plan.md');
      const planContent = '# Plan\nSome content';
      await fs.writeFile(planFile, planContent, 'utf-8');

      // LLM の出力をモック（マークダウンコードブロック付き）
      const mockLLMOutput = `
\`\`\`json
[
  {
    "id": "task-1",
    "description": "Test task",
    "branch": "test",
    "scopePaths": ["src/"],
    "acceptance": "Works",
    "type": "implementation",
    "estimatedDuration": 1,
    "context": "Test context",
    "dependencies": []
  }
]
\`\`\`
`;

      // モック RunnerEffects
      const mockRunnerEffects: RunnerEffects = {
        runClaudeAgent: async () => createOk({ finalResponse: mockLLMOutput }),
        runCodexAgent: async () => createOk({ finalResponse: mockLLMOutput }),
        ensureRunsDir: async () => createOk(undefined),
        initializeLogFile: async () => createOk(undefined),
        appendLog: async () => createOk(undefined),
        saveRunMetadata: async () => createOk(undefined),
        loadRunMetadata: async () => createErr(agentExecutionError('test', 'not implemented')),
        readLog: async () => createErr(agentExecutionError('test', 'not implemented')),
        listRunLogs: async () => createOk([]),
      };

      // テスト実行
      const result = await loadFromPlanDocument(planFile, mockRunnerEffects, 'claude', 'test-model', tempDir);

      // クリーンアップ
      await fs.rm(tempDir, { recursive: true, force: true });

      // 検証
      assert.ok(result.ok);
      assert.equal(result.val.tasks.length, 1);
      assert.equal(result.val.tasks[0]!.id, 'task-1');
    });

    it('should return error when file does not exist', async () => {
      // モック RunnerEffects（実際には呼ばれない）
      const mockRunnerEffects: RunnerEffects = {
        runClaudeAgent: async () => createOk({ finalResponse: '[]' }),
        runCodexAgent: async () => createOk({ finalResponse: '[]' }),
        ensureRunsDir: async () => createOk(undefined),
        initializeLogFile: async () => createOk(undefined),
        appendLog: async () => createOk(undefined),
        saveRunMetadata: async () => createOk(undefined),
        loadRunMetadata: async () => createErr(agentExecutionError('test', 'not implemented')),
        readLog: async () => createErr(agentExecutionError('test', 'not implemented')),
        listRunLogs: async () => createOk([]),
      };

      // テスト実行
      const result = await loadFromPlanDocument(
        '/nonexistent/file.md',
        mockRunnerEffects,
        'claude',
        'test-model',
        '/tmp',
      );

      // 検証
      assert.ok(!result.ok);
      assert.equal(result.err.type, 'IOError');
    });

    it('should return error when LLM output is invalid JSON', async () => {
      // 一時計画文書を作成
      const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'leader-input-test-'));
      const planFile = path.join(tempDir, 'plan.md');
      await fs.writeFile(planFile, '# Plan', 'utf-8');

      // LLM の出力をモック（不正なJSON）
      const mockLLMOutput = 'This is not valid JSON';

      // モック RunnerEffects
      const mockRunnerEffects: RunnerEffects = {
        runClaudeAgent: async () => createOk({ finalResponse: mockLLMOutput }),
        runCodexAgent: async () => createOk({ finalResponse: mockLLMOutput }),
        ensureRunsDir: async () => createOk(undefined),
        initializeLogFile: async () => createOk(undefined),
        appendLog: async () => createOk(undefined),
        saveRunMetadata: async () => createOk(undefined),
        loadRunMetadata: async () => createErr(agentExecutionError('test', 'not implemented')),
        readLog: async () => createErr(agentExecutionError('test', 'not implemented')),
        listRunLogs: async () => createOk([]),
      };

      // テスト実行
      const result = await loadFromPlanDocument(planFile, mockRunnerEffects, 'claude', 'test-model', tempDir);

      // クリーンアップ
      await fs.rm(tempDir, { recursive: true, force: true });

      // 検証
      assert.ok(!result.ok);
      assert.match(result.err.message, /Failed to parse LLM output as JSON/i);
    });

    it('should return error when LLM output does not match TaskBreakdown schema', async () => {
      // 一時計画文書を作成
      const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'leader-input-test-'));
      const planFile = path.join(tempDir, 'plan.md');
      await fs.writeFile(planFile, '# Plan', 'utf-8');

      // LLM の出力をモック（スキーマ不一致）
      const mockLLMOutput = JSON.stringify([
        {
          id: 'invalid-id', // "task-N" 形式でない
          description: 'Test',
          // 他のフィールドが不足
        },
      ]);

      // モック RunnerEffects
      const mockRunnerEffects: RunnerEffects = {
        runClaudeAgent: async () => createOk({ finalResponse: mockLLMOutput }),
        runCodexAgent: async () => createOk({ finalResponse: mockLLMOutput }),
        ensureRunsDir: async () => createOk(undefined),
        initializeLogFile: async () => createOk(undefined),
        appendLog: async () => createOk(undefined),
        saveRunMetadata: async () => createOk(undefined),
        loadRunMetadata: async () => createErr(agentExecutionError('test', 'not implemented')),
        readLog: async () => createErr(agentExecutionError('test', 'not implemented')),
        listRunLogs: async () => createOk([]),
      };

      // テスト実行
      const result = await loadFromPlanDocument(planFile, mockRunnerEffects, 'claude', 'test-model', tempDir);

      // クリーンアップ
      await fs.rm(tempDir, { recursive: true, force: true });

      // 検証
      assert.ok(!result.ok);
      assert.match(result.err.message, /does not match TaskBreakdown schema/i);
    });

    it('should extract instruction from first heading', async () => {
      // 一時計画文書を作成
      const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'leader-input-test-'));
      const planFile = path.join(tempDir, 'plan.md');
      const planContent = `
## Authentication Implementation Plan

This is the plan for implementing authentication.

### Tasks
- Task 1
`;
      await fs.writeFile(planFile, planContent, 'utf-8');

      // LLM の出力をモック
      const mockLLMOutput = JSON.stringify([
        {
          id: 'task-1',
          description: 'Task',
          branch: 'test',
          scopePaths: ['src/'],
          acceptance: 'Works',
          type: 'implementation',
          estimatedDuration: 1,
          context: 'Context',
          dependencies: [],
        },
      ]);

      // モック RunnerEffects
      const mockRunnerEffects: RunnerEffects = {
        runClaudeAgent: async () => createOk({ finalResponse: mockLLMOutput }),
        runCodexAgent: async () => createOk({ finalResponse: mockLLMOutput }),
        ensureRunsDir: async () => createOk(undefined),
        initializeLogFile: async () => createOk(undefined),
        appendLog: async () => createOk(undefined),
        saveRunMetadata: async () => createOk(undefined),
        loadRunMetadata: async () => createErr(agentExecutionError('test', 'not implemented')),
        readLog: async () => createErr(agentExecutionError('test', 'not implemented')),
        listRunLogs: async () => createOk([]),
      };

      // テスト実行
      const result = await loadFromPlanDocument(planFile, mockRunnerEffects, 'claude', 'test-model', tempDir);

      // クリーンアップ
      await fs.rm(tempDir, { recursive: true, force: true });

      // 検証
      assert.ok(result.ok);
      assert.equal(result.val.instruction, 'Authentication Implementation Plan');
    });
  });
});
