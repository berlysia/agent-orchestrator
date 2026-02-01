/**
 * Report Generator Unit Tests (ADR-032)
 */

import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import { isOk } from 'option-t/plain_result';
import { ReportGenerator } from '../../../../src/core/report/generator.ts';
import type {
  PlanningReportData,
  TaskBreakdownData,
  ScopeReportData,
  ExecutionReportData,
  ReviewReportData,
  SummaryReportData,
} from '../../../../src/core/report/types.ts';

const TEST_BASE_PATH = '/tmp/agent-test-report-generator';

// Mock dependencies
const mockSessionEffects = {
  loadSession: async () => ({ ok: true, val: { instruction: 'test' } }),
  listSessions: async () => ({ ok: true, val: [] }),
} as any;

const mockTaskStore = {
  readTask: async () => ({ ok: true, val: { id: 'task-001', state: 'DONE' } }),
  listTasks: async () => ({ ok: true, val: [] }),
} as any;

test('ReportGenerator: PlanningReport', async (t) => {
  await t.test('setup - clean test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    await fs.mkdir(TEST_BASE_PATH, { recursive: true });
  });

  const generator = new ReportGenerator(mockSessionEffects, mockTaskStore, TEST_BASE_PATH);

  await t.test('generatePlanningReport - should create planning report file', async () => {
    const data: PlanningReportData = {
      sessionId: 'session-001',
      createdAt: new Date().toISOString(),
      originalRequest: 'Implement feature X',
      clarifications: [
        { question: 'Which database?', answer: 'PostgreSQL' },
      ],
      designDecisions: [
        { decision: 'Use REST API', rationale: 'Simpler implementation' },
      ],
      approvedScope: 'Add new endpoint for feature X',
    };

    const result = await generator.generatePlanningReport(data);
    assert.ok(isOk(result), 'Should succeed');

    const filePath = result.val;
    assert.ok(filePath.endsWith('00-planning.md'));

    const content = await fs.readFile(filePath, 'utf-8');
    assert.ok(content.includes('Planning Session Report'));
    assert.ok(content.includes('Implement feature X'));
    assert.ok(content.includes('PostgreSQL'));
    assert.ok(content.includes('REST API'));
  });

  await t.test('cleanup - remove test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
  });
});

test('ReportGenerator: TaskBreakdownReport', async (t) => {
  await t.test('setup - clean test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    await fs.mkdir(TEST_BASE_PATH, { recursive: true });
  });

  const generator = new ReportGenerator(mockSessionEffects, mockTaskStore, TEST_BASE_PATH);

  await t.test('generateTaskBreakdownReport - should create task breakdown file', async () => {
    const data: TaskBreakdownData = {
      sessionId: 'session-001',
      createdAt: new Date().toISOString(),
      tasks: [
        {
          id: 'task-001',
          title: 'Create API endpoint',
          dependencies: [],
          priority: 'high',
          taskType: 'implementation',
        },
        {
          id: 'task-002',
          title: 'Add tests',
          dependencies: ['task-001'],
          priority: 'normal',
          taskType: 'implementation',
        },
      ],
    };

    const result = await generator.generateTaskBreakdownReport(data);
    assert.ok(isOk(result), 'Should succeed');

    const filePath = result.val;
    assert.ok(filePath.endsWith('01-task-breakdown.md'));

    const content = await fs.readFile(filePath, 'utf-8');
    assert.ok(content.includes('Task Breakdown'));
    assert.ok(content.includes('task-001'));
    assert.ok(content.includes('Create API endpoint'));
    assert.ok(content.includes('Dependency Graph'));
  });

  await t.test('cleanup - remove test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
  });
});

test('ReportGenerator: ScopeReport', async (t) => {
  await t.test('setup - clean test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    await fs.mkdir(TEST_BASE_PATH, { recursive: true });
  });

  const generator = new ReportGenerator(mockSessionEffects, mockTaskStore, TEST_BASE_PATH);

  await t.test('generateScopeReport - should create scope report file', async () => {
    const data: ScopeReportData = {
      taskId: 'task-001',
      title: 'User Authentication',
      description: 'Implement user authentication',
      plannedChanges: [
        { type: 'create', path: 'src/auth.ts', description: 'Auth module' },
        { type: 'modify', path: 'src/app.ts', description: 'Add auth middleware' },
      ],
      estimatedSize: 'medium',
      impactScope: ['authentication', 'middleware'],
    };

    const result = await generator.generateScopeReport('session-001', data);
    assert.ok(isOk(result), 'Should succeed');

    const filePath = result.val;
    assert.ok(filePath.includes('tasks/task-001'));
    assert.ok(filePath.endsWith('00-scope.md'));

    const content = await fs.readFile(filePath, 'utf-8');
    assert.ok(content.includes('Change Scope Declaration'));
    assert.ok(content.includes('src/auth.ts'));
    assert.ok(content.includes('Medium'));
  });

  await t.test('cleanup - remove test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
  });
});

test('ReportGenerator: ExecutionReport', async (t) => {
  await t.test('setup - clean test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    await fs.mkdir(TEST_BASE_PATH, { recursive: true });
  });

  const generator = new ReportGenerator(mockSessionEffects, mockTaskStore, TEST_BASE_PATH);

  await t.test('generateExecutionReport - should create execution report file', async () => {
    const data: ExecutionReportData = {
      taskId: 'task-001',
      workerId: 'worker-001',
      startedAt: '2024-01-01T00:00:00Z',
      completedAt: '2024-01-01T00:05:00Z',
      duration: 300000,
      changes: [
        { type: 'create', path: 'src/auth.ts', linesAdded: 100 },
        { type: 'modify', path: 'src/app.ts', linesAdded: 10, linesRemoved: 2 },
      ],
      commands: [
        { command: 'pnpm test', status: 'success' },
      ],
      notes: 'Implementation completed successfully',
    };

    const result = await generator.generateExecutionReport('session-001', data);
    assert.ok(isOk(result), 'Should succeed');

    const filePath = result.val;
    assert.ok(filePath.endsWith('01-execution.md'));

    const content = await fs.readFile(filePath, 'utf-8');
    assert.ok(content.includes('Execution Report'));
    assert.ok(content.includes('worker-001'));
    assert.ok(content.includes('300s') || content.includes('5m'));
    assert.ok(content.includes('pnpm test'));
  });

  await t.test('cleanup - remove test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
  });
});

test('ReportGenerator: ReviewReport', async (t) => {
  await t.test('setup - clean test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    await fs.mkdir(TEST_BASE_PATH, { recursive: true });
  });

  const generator = new ReportGenerator(mockSessionEffects, mockTaskStore, TEST_BASE_PATH);

  await t.test('generateReviewReport - should create review report file', async () => {
    const data: ReviewReportData = {
      taskId: 'task-001',
      verdict: 'done',
      reviewedAt: '2024-01-01T00:10:00Z',
      evaluations: [
        { aspect: 'Tests', result: 'pass', notes: 'All tests passing' },
        { aspect: 'Code Quality', result: 'pass' },
      ],
      issues: [],
    };

    const result = await generator.generateReviewReport('session-001', data);
    assert.ok(isOk(result), 'Should succeed');

    const filePath = result.val;
    assert.ok(filePath.endsWith('02-review.md'));

    const content = await fs.readFile(filePath, 'utf-8');
    assert.ok(content.includes('Judge Review Report'));
    assert.ok(content.includes('DONE'));
    assert.ok(content.includes('All tests passing'));
  });

  await t.test('cleanup - remove test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
  });
});

test('ReportGenerator: SummaryReport', async (t) => {
  await t.test('setup - clean test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    await fs.mkdir(TEST_BASE_PATH, { recursive: true });
  });

  const generator = new ReportGenerator(mockSessionEffects, mockTaskStore, TEST_BASE_PATH);

  await t.test('generateSummaryReport - should create summary report file', async () => {
    const data: SummaryReportData = {
      sessionId: 'session-001',
      originalRequest: 'Implement feature X',
      totalDuration: 600000,
      status: 'complete',
      startedAt: '2024-01-01T00:00:00Z',
      completedAt: '2024-01-01T00:10:00Z',
      deliverables: [
        { type: 'create', path: 'src/feature.ts', summary: 'Main implementation' },
      ],
      taskResults: [
        { taskId: 'task-001', title: 'Implement feature', status: 'done', iterations: 1 },
      ],
      reviewResults: {
        judge: 'Approved',
      },
      verificationCommands: [
        'pnpm test',
        'pnpm typecheck',
      ],
    };

    const result = await generator.generateSummaryReport(data);
    assert.ok(isOk(result), 'Should succeed');

    const filePath = result.val;
    assert.ok(filePath.endsWith('summary.md'));

    const content = await fs.readFile(filePath, 'utf-8');
    assert.ok(content.includes('Task Completion Summary'));
    assert.ok(content.includes('Implement feature X'));
    assert.ok(content.includes('Complete'));
    assert.ok(content.includes('pnpm test'));
  });

  await t.test('cleanup - remove test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
  });
});
