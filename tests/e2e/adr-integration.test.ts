/**
 * ADR Integration E2E Tests
 *
 * ADR-027 (NDJSON Session Logging), ADR-029 (GitHub Issue Integration),
 * and ADR-032 (Report Generation) の統合テスト。
 */

import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const TEST_BASE_PATH = '/tmp/agent-test-adr-integration';

// ===== ADR-027: Session Logging Tests =====

test('ADR-027: Session logging infrastructure', async (t) => {
  const { NdjsonSessionLogger } = await import(
    '../../src/core/session/ndjson-writer.ts'
  );
  const { FileSessionPointerManager } = await import(
    '../../src/core/session/session-pointer.ts'
  );
  const { sessionId } = await import('../../src/types/branded.ts');

  const basePath = path.join(TEST_BASE_PATH, 'adr027');

  await t.test('setup - clean test directory', async () => {
    await fs.rm(basePath, { recursive: true, force: true });
    await fs.mkdir(basePath, { recursive: true });
  });

  await t.test('should create session log and pointer files', async () => {
    const pointerManager = new FileSessionPointerManager(basePath);
    const logger = new NdjsonSessionLogger(basePath, pointerManager);
    const sid = sessionId('test-session-' + Date.now());

    // セッション開始
    const startResult = await logger.start(sid, 'Test task');
    assert.ok(startResult.ok, 'Session start should succeed');

    // ログファイルが存在するか確認
    const logPath = path.join(basePath, 'sessions', `${sid}.jsonl`);
    const logExists = await fs.access(logPath).then(() => true).catch(() => false);
    assert.ok(logExists, 'Log file should exist');

    // セッション完了
    const completeResult = await logger.complete('Task completed', { tasksCompleted: 1 });
    assert.ok(completeResult.ok, 'Session complete should succeed');

    // ログ内容を確認
    const logContent = await fs.readFile(logPath, 'utf-8');
    const lines = logContent.trim().split('\n');
    assert.ok(lines.length >= 2, 'Should have at least 2 log lines');

    const firstLine = lines[0];
    assert.ok(firstLine, 'First line should exist');
    const firstParsed = JSON.parse(firstLine);
    assert.strictEqual(firstParsed.type, 'session_start');
    assert.strictEqual(firstParsed.task, 'Test task');

    const lastLine = lines[lines.length - 1];
    assert.ok(lastLine, 'Last line should exist');
    const lastParsed = JSON.parse(lastLine);
    assert.strictEqual(lastParsed.type, 'session_complete');
  });

  await t.test('should support session resume context extraction', async () => {
    const { extractResumeContext } = await import(
      '../../src/core/session/session-resume.ts'
    );

    // テスト用ログを作成
    const sid = 'resume-test-session';
    const logPath = path.join(basePath, 'sessions', `${sid}.jsonl`);

    const records = [
      {
        type: 'session_start',
        sessionId: sid,
        task: 'Resume test',
        timestamp: new Date().toISOString(),
      },
      {
        type: 'task_created',
        taskId: 'task-1',
        title: 'Test task 1',
        timestamp: new Date().toISOString(),
      },
      {
        type: 'session_abort',
        sessionId: sid,
        reason: 'Test abort',
        timestamp: new Date().toISOString(),
      },
    ];

    await fs.writeFile(logPath, records.map(r => JSON.stringify(r)).join('\n'), 'utf-8');

    const result = await extractResumeContext(basePath, sid);
    assert.ok(result.ok, 'Context extraction should succeed');

    const context = result.val;
    assert.strictEqual(context.originalTask, 'Resume test');
    assert.strictEqual(context.abortReason, 'Test abort');
    assert.ok(context.canResume, 'Should be resumable');
  });

  await t.test('cleanup - remove test directory', async () => {
    await fs.rm(basePath, { recursive: true, force: true });
  });
});

// ===== ADR-029: GitHub Issue Integration Tests =====

test('ADR-029: GitHub Issue parsing and conversion', async (t) => {
  const { parseIssueRef, isIssueRef } = await import(
    '../../src/adapters/github/issue-parser.ts'
  );
  const { convertIssueToTaskContext, inferTaskType } = await import(
    '../../src/adapters/github/issue-to-task.ts'
  );
  const { sanitizeIssueContent, sanitizeIssueTitle } = await import(
    '../../src/adapters/github/issue-sanitizer.ts'
  );
  const { isOk } = await import('option-t/plain_result');

  await t.test('should parse various issue reference formats', () => {
    // #123 format
    const result1 = parseIssueRef('#123');
    assert.ok(isOk(result1), 'Should parse #123');
    assert.strictEqual(result1.val.number, 123);

    // owner/repo#123 format
    const result2 = parseIssueRef('owner/repo#456');
    assert.ok(isOk(result2), 'Should parse owner/repo#456');
    assert.strictEqual(result2.val.number, 456);
    assert.strictEqual(result2.val.type, 'url', 'Should be url type');
    if (result2.val.type === 'url') {
      assert.strictEqual(result2.val.owner, 'owner');
      assert.strictEqual(result2.val.repo, 'repo');
    }

    // URL format
    const result3 = parseIssueRef('https://github.com/org/project/issues/789');
    assert.ok(isOk(result3), 'Should parse URL');
    assert.strictEqual(result3.val.number, 789);
  });

  await t.test('should detect issue references', () => {
    assert.ok(isIssueRef('#1'), '#1 is an issue ref');
    assert.ok(isIssueRef('owner/repo#42'), 'owner/repo#42 is an issue ref');
    assert.ok(isIssueRef('https://github.com/o/r/issues/1'), 'URL is an issue ref');
    assert.ok(!isIssueRef('hello world'), 'plain text is not an issue ref');
    assert.ok(!isIssueRef('just a comment'), 'comment is not an issue ref');
  });

  await t.test('should convert issue to task context', () => {
    const mockIssue = {
      number: 42,
      title: 'Add feature X',
      body: 'Please implement feature X.',
      labels: ['enhancement', 'priority-high'],
      assignees: ['user1'],
      milestone: undefined,
      state: 'OPEN' as const,
      url: 'https://github.com/test/repo/issues/42',
      comments: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const context = convertIssueToTaskContext(mockIssue);
    assert.ok(context.includes('Add feature X'), 'Context should include title');
    assert.ok(context.includes('42') || context.includes('#42'), 'Context should include issue number');
  });

  await t.test('should infer task type from labels', () => {
    const createIssue = (labels: string[]) => ({
      number: 1,
      title: 'Test',
      body: '',
      labels,
      assignees: [],
      milestone: undefined,
      state: 'OPEN' as const,
      url: 'https://github.com/test/repo/issues/1',
      comments: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    assert.strictEqual(inferTaskType(createIssue(['documentation'])), 'documentation');
    assert.strictEqual(inferTaskType(createIssue(['research'])), 'investigation');
    assert.strictEqual(inferTaskType(createIssue(['integration'])), 'integration');
    assert.strictEqual(inferTaskType(createIssue(['enhancement'])), 'implementation');
  });

  await t.test('should sanitize issue content', () => {
    const dangerous = 'Run this: sudo rm -rf /';
    const sanitized = sanitizeIssueContent(dangerous);
    assert.ok(sanitized.includes('WARNING'), 'Should warn about dangerous commands');

    const normal = 'Please add feature X';
    const sanitizedNormal = sanitizeIssueContent(normal);
    assert.ok(sanitizedNormal.includes('feature X'), 'Should preserve normal content');
  });

  await t.test('should sanitize issue title', () => {
    const longTitle = 'A'.repeat(200);
    const sanitized = sanitizeIssueTitle(longTitle, 50);
    assert.ok(sanitized.length <= 53, 'Should truncate long titles');
  });
});

// ===== ADR-032: Report Generation Tests =====

test('ADR-032: Report generation', async (t) => {
  const { ReportGenerator } = await import('../../src/core/report/generator.ts');
  const { isOk } = await import('option-t/plain_result');

  const basePath = path.join(TEST_BASE_PATH, 'adr032');

  // Mock dependencies
  const mockSessionEffects = {
    loadSession: async () => ({ ok: true, val: { instruction: 'test' } }),
    listSessions: async () => ({ ok: true, val: [] }),
  } as any;

  const mockTaskStore = {
    readTask: async () => ({ ok: true, val: { id: 'task-001', state: 'DONE' } }),
    listTasks: async () => ({ ok: true, val: [] }),
  } as any;

  await t.test('setup - clean test directory', async () => {
    await fs.rm(basePath, { recursive: true, force: true });
    await fs.mkdir(basePath, { recursive: true });
  });

  await t.test('should generate planning report', async () => {
    const generator = new ReportGenerator(mockSessionEffects, mockTaskStore, basePath);

    const data = {
      sessionId: 'test-session',
      createdAt: new Date().toISOString(),
      originalRequest: 'Implement feature X',
      clarifications: [
        { question: 'Database?', answer: 'PostgreSQL' },
      ],
      designDecisions: [
        { decision: 'Use REST', rationale: 'Simple' },
      ],
      approvedScope: 'Add API endpoint',
    };

    const result = await generator.generatePlanningReport(data);
    assert.ok(isOk(result), 'Should generate planning report');
    assert.ok(result.val.endsWith('00-planning.md'));

    const content = await fs.readFile(result.val, 'utf-8');
    assert.ok(content.includes('Planning Session Report'));
    assert.ok(content.includes('Implement feature X'));
  });

  await t.test('should generate task breakdown report', async () => {
    const generator = new ReportGenerator(mockSessionEffects, mockTaskStore, basePath);

    const data = {
      sessionId: 'test-session',
      createdAt: new Date().toISOString(),
      tasks: [
        {
          id: 'task-001',
          title: 'Create API',
          dependencies: [],
          priority: 'high' as const,
          taskType: 'implementation' as const,
        },
      ],
    };

    const result = await generator.generateTaskBreakdownReport(data);
    assert.ok(isOk(result), 'Should generate task breakdown report');
    assert.ok(result.val.endsWith('01-task-breakdown.md'));

    const content = await fs.readFile(result.val, 'utf-8');
    assert.ok(content.includes('Task Breakdown'));
    assert.ok(content.includes('task-001'));
  });

  await t.test('should generate summary report', async () => {
    const generator = new ReportGenerator(mockSessionEffects, mockTaskStore, basePath);

    const data = {
      sessionId: 'test-session',
      originalRequest: 'Implement feature',
      status: 'complete' as const,
      startedAt: '2024-01-01T00:00:00Z',
      completedAt: '2024-01-01T01:00:00Z',
      totalDuration: 3600000,
      deliverables: [
        { type: 'create' as const, path: 'src/api.ts', summary: 'API implementation' },
      ],
      taskResults: [
        { taskId: 'task-001', title: 'Create API', status: 'done' as const, iterations: 1 },
      ],
      reviewResults: { judge: 'Approved' },
      verificationCommands: ['pnpm test'],
    };

    const result = await generator.generateSummaryReport(data);
    assert.ok(isOk(result), 'Should generate summary report');
    assert.ok(result.val.endsWith('summary.md'));

    const content = await fs.readFile(result.val, 'utf-8');
    assert.ok(content.includes('Task Completion Summary'));
    assert.ok(content.includes('Implement feature'));
    assert.ok(content.includes('Complete'));
  });

  await t.test('cleanup - remove test directory', async () => {
    await fs.rm(basePath, { recursive: true, force: true });
  });
});

// ===== Integration: Full Flow Test =====

test('ADR Integration: Session logging + Report generation flow', async (t) => {
  const { NdjsonSessionLogger } = await import(
    '../../src/core/session/ndjson-writer.ts'
  );
  const { FileSessionPointerManager } = await import(
    '../../src/core/session/session-pointer.ts'
  );
  const { ReportGenerator } = await import('../../src/core/report/generator.ts');
  const { readSessionLog } = await import('../../src/core/report/ndjson-extractor.ts');
  const { sessionId } = await import('../../src/types/branded.ts');
  const { isOk } = await import('option-t/plain_result');

  const basePath = path.join(TEST_BASE_PATH, 'integration');

  // Mock dependencies
  const mockSessionEffects = {
    loadSession: async () => ({ ok: true, val: { instruction: 'Integration test' } }),
    listSessions: async () => ({ ok: true, val: [] }),
  } as any;

  const mockTaskStore = {
    readTask: async () => ({ ok: true, val: { id: 'task-001', state: 'DONE' } }),
    listTasks: async () => ({ ok: true, val: [] }),
  } as any;

  await t.test('setup - clean test directory', async () => {
    await fs.rm(basePath, { recursive: true, force: true });
    await fs.mkdir(basePath, { recursive: true });
  });

  await t.test('should complete full session lifecycle with reports', async () => {
    const sid = sessionId('integration-test-' + Date.now());
    const pointerManager = new FileSessionPointerManager(basePath);
    const logger = new NdjsonSessionLogger(basePath, pointerManager);
    const reportGenerator = new ReportGenerator(mockSessionEffects, mockTaskStore, basePath);

    // 1. Start session
    const startResult = await logger.start(sid, 'Integration test task');
    assert.ok(startResult.ok, 'Session start should succeed');

    // 2. Log task creation
    const { createTaskCreatedRecord, createPhaseStartRecord, createPhaseCompleteRecord, SessionPhase } = await import(
      '../../src/types/session-log.ts'
    );
    const { taskId: toTaskId } = await import('../../src/types/branded.ts');

    await logger.log(createPhaseStartRecord(SessionPhase.PLANNING, sid));
    await logger.log(createTaskCreatedRecord(toTaskId('task-001'), 'Test task', { taskType: 'implementation' }));
    await logger.log(createPhaseCompleteRecord(SessionPhase.PLANNING, { sessionId: sid }));

    // 3. Complete session
    const completeResult = await logger.complete('Integration test completed', { tasksCompleted: 1 });
    assert.ok(completeResult.ok, 'Session complete should succeed');

    // 4. Verify log can be read
    const records: unknown[] = [];
    for await (const record of readSessionLog(basePath, String(sid))) {
      records.push(record);
    }
    assert.ok(records.length >= 4, 'Should have logged multiple records');

    // 5. Generate reports
    const summaryData = {
      sessionId: String(sid),
      originalRequest: 'Integration test task',
      status: 'complete' as const,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      totalDuration: 1000,
      deliverables: [],
      taskResults: [{ taskId: 'task-001', title: 'Test task', status: 'done' as const, iterations: 1 }],
      reviewResults: { judge: 'Approved' },
      verificationCommands: [],
    };

    const reportResult = await reportGenerator.generateSummaryReport(summaryData);
    assert.ok(isOk(reportResult), 'Summary report generation should succeed');

    // 6. Verify report file exists
    const reportExists = await fs.access(reportResult.val).then(() => true).catch(() => false);
    assert.ok(reportExists, 'Report file should exist');
  });

  await t.test('cleanup - remove test directory', async () => {
    await fs.rm(basePath, { recursive: true, force: true });
  });
});
