/**
 * Prompt Builder Tests (ADR-032)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  buildTaskPrompt,
  buildContextAwarePrompt,
  buildRelatedTasksContext,
  buildReviewContext,
  type WorkerExecutionContext,
} from '../../../../src/core/runner/prompt-builder.ts';
import { createInitialTask } from '../../../../src/types/task.ts';
import { taskId, branchName, repoPath } from '../../../../src/types/branded.ts';

const createMockTask = (overrides: Partial<Parameters<typeof createInitialTask>[0]> = {}) =>
  createInitialTask({
    id: taskId('task-001'),
    repo: repoPath('/test/repo'),
    branch: branchName('feature/test'),
    scopePaths: [],
    acceptance: 'Test acceptance criteria',
    taskType: 'implementation',
    context: 'Test context',
    dependencies: [],
    ...overrides,
  });

describe('buildTaskPrompt', () => {
  test('should build basic prompt', () => {
    const task = createMockTask();
    const result = buildTaskPrompt(task);
    assert.ok(result.includes('task-001'));
    assert.ok(result.includes('実装してください'));
  });

  test('should include scope paths when present', () => {
    const task = createMockTask({
      scopePaths: ['src/auth.ts', 'src/login.ts'],
    });
    const result = buildTaskPrompt(task);
    assert.ok(result.includes('src/auth.ts'));
    assert.ok(result.includes('src/login.ts'));
  });

  test('should include acceptance criteria when present', () => {
    const task = createMockTask({
      acceptance: 'All tests must pass',
    });
    const result = buildTaskPrompt(task);
    assert.ok(result.includes('All tests must pass'));
  });
});

describe('buildContextAwarePrompt', () => {
  test('should return base prompt when no context provided', () => {
    const task = createMockTask();
    const context: WorkerExecutionContext = {};
    const result = buildContextAwarePrompt(task, context);
    assert.strictEqual(result, buildTaskPrompt(task));
  });

  test('should include planning context', () => {
    const task = createMockTask();
    const context: WorkerExecutionContext = {
      planningContext: 'User requested authentication feature with OAuth support.',
    };
    const result = buildContextAwarePrompt(task, context);
    assert.ok(result.includes('Planning Sessionからのコンテキスト'));
    assert.ok(result.includes('OAuth support'));
  });

  test('should include task breakdown context', () => {
    const task = createMockTask();
    const context: WorkerExecutionContext = {
      taskBreakdownContext: 'Task 1: Auth module\nTask 2: Login UI',
    };
    const result = buildContextAwarePrompt(task, context);
    assert.ok(result.includes('タスク分解情報'));
    assert.ok(result.includes('Auth module'));
  });

  test('should include related tasks context', () => {
    const task = createMockTask();
    const context: WorkerExecutionContext = {
      relatedTasksContext: 'task-000 is completed with auth service.',
    };
    const result = buildContextAwarePrompt(task, context);
    assert.ok(result.includes('関連タスクの状況'));
    assert.ok(result.includes('task-000'));
  });

  test('should include previous review context for continuation', () => {
    const task = createMockTask();
    const context: WorkerExecutionContext = {
      previousReviewContext: 'NEEDS_CONTINUATION: Missing error handling.',
    };
    const result = buildContextAwarePrompt(task, context);
    assert.ok(result.includes('前回のレビュー結果'));
    assert.ok(result.includes('Missing error handling'));
  });

  test('should combine all context sections', () => {
    const task = createMockTask();
    const context: WorkerExecutionContext = {
      planningContext: 'Planning info',
      taskBreakdownContext: 'Breakdown info',
      relatedTasksContext: 'Related info',
      previousReviewContext: 'Review info',
    };
    const result = buildContextAwarePrompt(task, context);
    assert.ok(result.includes('Planning info'));
    assert.ok(result.includes('Breakdown info'));
    assert.ok(result.includes('Related info'));
    assert.ok(result.includes('Review info'));
    assert.ok(result.includes('---')); // Separator
    assert.ok(result.includes('task-001')); // Base prompt
  });
});

describe('buildRelatedTasksContext', () => {
  test('should return message for empty tasks', () => {
    const result = buildRelatedTasksContext([]);
    assert.strictEqual(result, '依存タスクはありません。');
  });

  test('should list completed tasks', () => {
    const tasks = [
      { id: 'task-001', summary: 'Auth service implemented' },
      { id: 'task-002', summary: 'Database schema created' },
    ];
    const result = buildRelatedTasksContext(tasks);
    assert.ok(result.includes('task-001: Auth service implemented'));
    assert.ok(result.includes('task-002: Database schema created'));
  });

  test('should include deliverables when present', () => {
    const tasks = [
      {
        id: 'task-001',
        summary: 'Auth module',
        deliverables: ['src/auth/service.ts', 'src/auth/types.ts'],
      },
    ];
    const result = buildRelatedTasksContext(tasks);
    assert.ok(result.includes('成果物:'));
    assert.ok(result.includes('src/auth/service.ts'));
  });
});

describe('buildReviewContext', () => {
  test('should format basic review context', () => {
    const result = buildReviewContext('NEEDS_CONTINUATION', 'Missing tests');
    assert.ok(result.includes('前回の判定: NEEDS_CONTINUATION'));
    assert.ok(result.includes('フィードバック: Missing tests'));
  });

  test('should include issues when present', () => {
    const issues = [
      { severity: 'Warning', location: 'src/auth.ts:42', description: 'Unused import' },
      { severity: 'Error', location: 'src/login.ts:10', description: 'Missing validation' },
    ];
    const result = buildReviewContext('NEEDS_CONTINUATION', 'Fix issues', issues);
    assert.ok(result.includes('[Warning] src/auth.ts:42: Unused import'));
    assert.ok(result.includes('[Error] src/login.ts:10: Missing validation'));
  });

  test('should handle empty issues array', () => {
    const result = buildReviewContext('DONE', 'All good', []);
    assert.ok(!result.includes('指摘事項'));
  });
});
