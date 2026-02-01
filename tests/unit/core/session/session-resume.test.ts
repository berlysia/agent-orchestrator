/**
 * Session Resume Context Unit Tests (ADR-027)
 */

import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isOk, isErr } from 'option-t/plain_result';
import {
  extractResumeContext,
  canResumeSession,
  formatResumeContext,
  getPendingTasks,
  getCompletedTasks,
  getNextExecutableTasks,
} from '../../../../src/core/session/session-resume.ts';
import { FileSessionPointerManager } from '../../../../src/core/session/session-pointer.ts';
import { sessionId, taskId } from '../../../../src/types/branded.ts';

const TEST_BASE_PATH = '/tmp/agent-test-session-resume';

// Helper to create NDJSON log file
async function createSessionLog(sessionId: string, records: object[]): Promise<void> {
  const sessionsDir = path.join(TEST_BASE_PATH, 'sessions');
  await fs.mkdir(sessionsDir, { recursive: true });
  const content = records.map((r) => JSON.stringify(r)).join('\n');
  await fs.writeFile(path.join(sessionsDir, `${sessionId}.jsonl`), content, 'utf-8');
}

test('extractResumeContext: basic extraction', async (t) => {
  await t.test('setup - clean test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    await fs.mkdir(TEST_BASE_PATH, { recursive: true });
  });

  await t.test('should extract context from session with tasks', async () => {
    const sid = 'test-session-001';
    const records = [
      {
        type: 'session_start',
        sessionId: sid,
        task: 'Implement feature X',
        timestamp: '2024-01-01T00:00:00.000Z',
      },
      {
        type: 'phase_start',
        phase: 'planning',
        sessionId: sid,
        timestamp: '2024-01-01T00:00:01.000Z',
      },
      {
        type: 'task_created',
        taskId: 'task-001',
        title: 'Create API endpoint',
        taskType: 'implementation',
        dependencies: [],
        timestamp: '2024-01-01T00:01:00.000Z',
      },
      {
        type: 'task_created',
        taskId: 'task-002',
        title: 'Add tests',
        taskType: 'implementation',
        dependencies: ['task-001'],
        timestamp: '2024-01-01T00:01:01.000Z',
      },
      {
        type: 'phase_complete',
        phase: 'planning',
        sessionId: sid,
        timestamp: '2024-01-01T00:02:00.000Z',
      },
      {
        type: 'phase_start',
        phase: 'execution',
        sessionId: sid,
        timestamp: '2024-01-01T00:02:01.000Z',
      },
      {
        type: 'worker_start',
        taskId: 'task-001',
        workerId: 'worker-001',
        timestamp: '2024-01-01T00:03:00.000Z',
      },
      {
        type: 'worker_complete',
        taskId: 'task-001',
        workerId: 'worker-001',
        status: 'success',
        timestamp: '2024-01-01T00:04:00.000Z',
      },
      {
        type: 'judge_complete',
        taskId: 'task-001',
        verdict: 'done',
        timestamp: '2024-01-01T00:05:00.000Z',
      },
      {
        type: 'session_abort',
        sessionId: sid,
        reason: 'User interrupted',
        timestamp: '2024-01-01T00:06:00.000Z',
      },
    ];

    await createSessionLog(sid, records);

    const result = await extractResumeContext(TEST_BASE_PATH, sid);
    assert.ok(isOk(result), 'Should succeed');

    const context = result.val;
    assert.strictEqual(context.originalTask, 'Implement feature X');
    assert.strictEqual(context.lastPhase, 'execution');
    assert.strictEqual(context.phaseCompleted, false);
    assert.strictEqual(context.completedTaskCount, 1);
    assert.strictEqual(context.pendingTaskCount, 1);
    assert.strictEqual(context.abortReason, 'User interrupted');
    assert.strictEqual(context.canResume, true);
    assert.strictEqual(context.resumeAction, 'continue_phase');

    // Task states
    assert.strictEqual(context.tasks.length, 2);
    const task1 = context.tasks.find((t) => String(t.taskId) === 'task-001');
    const task2 = context.tasks.find((t) => String(t.taskId) === 'task-002');
    assert.ok(task1, 'Task 1 should exist');
    assert.ok(task2, 'Task 2 should exist');
    assert.strictEqual(task1.status, 'done');
    assert.strictEqual(task1.iterations, 1);
    assert.strictEqual(task2.status, 'pending');
    assert.strictEqual(task2.iterations, 0);
  });

  await t.test('should handle session with completed phase', async () => {
    const sid = 'test-session-002';
    const records = [
      {
        type: 'session_start',
        sessionId: sid,
        task: 'Task Y',
        timestamp: '2024-01-01T00:00:00.000Z',
      },
      {
        type: 'phase_start',
        phase: 'planning',
        sessionId: sid,
        timestamp: '2024-01-01T00:00:01.000Z',
      },
      {
        type: 'task_created',
        taskId: 'task-100',
        title: 'Task 100',
        timestamp: '2024-01-01T00:01:00.000Z',
      },
      {
        type: 'phase_complete',
        phase: 'planning',
        sessionId: sid,
        timestamp: '2024-01-01T00:02:00.000Z',
      },
      {
        type: 'session_abort',
        sessionId: sid,
        reason: 'System crash',
        timestamp: '2024-01-01T00:03:00.000Z',
      },
    ];

    await createSessionLog(sid, records);

    const result = await extractResumeContext(TEST_BASE_PATH, sid);
    assert.ok(isOk(result), 'Should succeed');

    const context = result.val;
    assert.strictEqual(context.lastPhase, 'planning');
    assert.strictEqual(context.phaseCompleted, true);
    assert.strictEqual(context.resumeAction, 'restart_phase');
  });

  await t.test('should handle completed session (no resume needed)', async () => {
    const sid = 'test-session-003';
    const records = [
      {
        type: 'session_start',
        sessionId: sid,
        task: 'Simple task',
        timestamp: '2024-01-01T00:00:00.000Z',
      },
      {
        type: 'session_complete',
        sessionId: sid,
        summary: 'All done',
        timestamp: '2024-01-01T00:10:00.000Z',
      },
    ];

    await createSessionLog(sid, records);

    const result = await extractResumeContext(TEST_BASE_PATH, sid);
    assert.ok(isOk(result), 'Should succeed');

    const context = result.val;
    assert.strictEqual(context.canResume, false);
    assert.strictEqual(context.resumeAction, 'none');
  });

  await t.test('should extract error information', async () => {
    const sid = 'test-session-004';
    const records = [
      {
        type: 'session_start',
        sessionId: sid,
        task: 'Error task',
        timestamp: '2024-01-01T00:00:00.000Z',
      },
      {
        type: 'error',
        message: 'Something went wrong',
        errorType: 'RuntimeError',
        timestamp: '2024-01-01T00:01:00.000Z',
      },
      {
        type: 'session_abort',
        sessionId: sid,
        reason: 'Error occurred',
        timestamp: '2024-01-01T00:02:00.000Z',
      },
    ];

    await createSessionLog(sid, records);

    const result = await extractResumeContext(TEST_BASE_PATH, sid);
    assert.ok(isOk(result), 'Should succeed');

    const context = result.val;
    assert.strictEqual(context.lastError, 'Something went wrong');
    assert.strictEqual(context.abortReason, 'Error occurred');
  });

  await t.test('should return error for missing session start', async () => {
    const sid = 'test-session-005';
    const records = [
      {
        type: 'error',
        message: 'Some error',
        timestamp: '2024-01-01T00:00:00.000Z',
      },
    ];

    await createSessionLog(sid, records);

    const result = await extractResumeContext(TEST_BASE_PATH, sid);
    assert.ok(isErr(result), 'Should fail');
    assert.strictEqual(result.err.type, 'SessionResumeError');
  });

  await t.test('cleanup - remove test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
  });
});

test('canResumeSession: check resumability', async (t) => {
  await t.test('setup - clean test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    await fs.mkdir(TEST_BASE_PATH, { recursive: true });
  });

  const pointerManager = new FileSessionPointerManager(TEST_BASE_PATH);

  await t.test('should return null when no latest pointer', async () => {
    const result = await canResumeSession(TEST_BASE_PATH, pointerManager);
    assert.ok(isOk(result), 'Should succeed');
    assert.strictEqual(result.val, null);
  });

  await t.test('should return session for running status', async () => {
    await pointerManager.updateLatest({
      sessionId: 'running-session',
      startedAt: '2024-01-01T00:00:00.000Z',
      status: 'running',
    });

    const result = await canResumeSession(TEST_BASE_PATH, pointerManager);
    assert.ok(isOk(result), 'Should succeed');
    assert.ok(result.val !== null, 'Should return session info');
    assert.strictEqual(result.val?.sessionId, 'running-session');
    assert.strictEqual(result.val?.status, 'running');
  });

  await t.test('should return session for aborted status', async () => {
    await pointerManager.updateLatest({
      sessionId: 'aborted-session',
      startedAt: '2024-01-01T00:00:00.000Z',
      status: 'aborted',
    });

    const result = await canResumeSession(TEST_BASE_PATH, pointerManager);
    assert.ok(isOk(result), 'Should succeed');
    assert.ok(result.val !== null, 'Should return session info');
    assert.strictEqual(result.val?.status, 'aborted');
  });

  await t.test('should return null for completed status', async () => {
    await pointerManager.updateLatest({
      sessionId: 'completed-session',
      startedAt: '2024-01-01T00:00:00.000Z',
      status: 'completed',
    });

    const result = await canResumeSession(TEST_BASE_PATH, pointerManager);
    assert.ok(isOk(result), 'Should succeed');
    assert.strictEqual(result.val, null);
  });

  await t.test('cleanup - remove test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
  });
});

test('formatResumeContext: format for display', async (t) => {
  await t.test('should format context with tasks', () => {
    const context = {
      sessionId: sessionId('test-session'),
      originalTask: 'Implement feature',
      startedAt: '2024-01-01T00:00:00.000Z',
      lastPhase: 'execution' as const,
      phaseCompleted: false,
      tasks: [
        {
          taskId: taskId('task-001'),
          title: 'API endpoint',
          status: 'done' as const,
          iterations: 1,
          lastVerdict: 'done' as const,
          dependencies: [],
        },
        {
          taskId: taskId('task-002'),
          title: 'Tests',
          status: 'pending' as const,
          iterations: 0,
          dependencies: [taskId('task-001')],
        },
      ],
      completedTaskCount: 1,
      pendingTaskCount: 1,
      canResume: true,
      resumeAction: 'continue_phase' as const,
    };

    const formatted = formatResumeContext(context);
    assert.ok(formatted.includes('Session Resume Context'));
    assert.ok(formatted.includes('test-session'));
    assert.ok(formatted.includes('Implement feature'));
    assert.ok(formatted.includes('execution'));
    assert.ok(formatted.includes('API endpoint'));
    assert.ok(formatted.includes('Tests'));
    assert.ok(formatted.includes('Completed: 1'));
    assert.ok(formatted.includes('Pending: 1'));
    assert.ok(formatted.includes('Can Resume: Yes'));
    assert.ok(formatted.includes('Continue from last phase'));
  });

  await t.test('should format context with abort reason', () => {
    const context = {
      sessionId: sessionId('aborted-session'),
      originalTask: 'Task',
      startedAt: '2024-01-01T00:00:00.000Z',
      lastPhase: 'planning' as const,
      phaseCompleted: true,
      tasks: [],
      completedTaskCount: 0,
      pendingTaskCount: 0,
      abortReason: 'User cancelled',
      canResume: true,
      resumeAction: 'restart_session' as const,
    };

    const formatted = formatResumeContext(context);
    assert.ok(formatted.includes('Abort Info'));
    assert.ok(formatted.includes('User cancelled'));
  });
});

test('getPendingTasks and getCompletedTasks', async (t) => {
  const context = {
    sessionId: sessionId('test'),
    originalTask: 'Test',
    startedAt: '2024-01-01T00:00:00.000Z',
    lastPhase: null,
    phaseCompleted: false,
    tasks: [
      {
        taskId: taskId('t1'),
        title: 'Done task',
        status: 'done' as const,
        iterations: 1,
        dependencies: [],
      },
      {
        taskId: taskId('t2'),
        title: 'Pending task',
        status: 'pending' as const,
        iterations: 0,
        dependencies: [],
      },
      {
        taskId: taskId('t3'),
        title: 'Blocked task',
        status: 'blocked' as const,
        iterations: 0,
        dependencies: [],
      },
      {
        taskId: taskId('t4'),
        title: 'Needs continuation',
        status: 'needs_continuation' as const,
        iterations: 2,
        dependencies: [],
      },
    ],
    completedTaskCount: 1,
    pendingTaskCount: 2,
    canResume: true,
    resumeAction: 'continue_phase' as const,
  };

  await t.test('getPendingTasks should return non-done and non-blocked tasks', () => {
    const pending = getPendingTasks(context);
    assert.strictEqual(pending.length, 2);
    assert.ok(pending.some((t) => String(t.taskId) === 't2'));
    assert.ok(pending.some((t) => String(t.taskId) === 't4'));
  });

  await t.test('getCompletedTasks should return only done tasks', () => {
    const completed = getCompletedTasks(context);
    assert.strictEqual(completed.length, 1);
    const firstTask = completed[0];
    assert.ok(firstTask, 'Should have first task');
    assert.strictEqual(String(firstTask.taskId), 't1');
  });
});

test('getNextExecutableTasks: dependency-aware', async (t) => {
  await t.test('should return tasks with satisfied dependencies', () => {
    const context = {
      sessionId: sessionId('test'),
      originalTask: 'Test',
      startedAt: '2024-01-01T00:00:00.000Z',
      lastPhase: null,
      phaseCompleted: false,
      tasks: [
        {
          taskId: taskId('t1'),
          title: 'Done task',
          status: 'done' as const,
          iterations: 1,
          dependencies: [],
        },
        {
          taskId: taskId('t2'),
          title: 'Pending - deps met',
          status: 'pending' as const,
          iterations: 0,
          dependencies: [taskId('t1')],
        },
        {
          taskId: taskId('t3'),
          title: 'Pending - deps not met',
          status: 'pending' as const,
          iterations: 0,
          dependencies: [taskId('t2')],
        },
        {
          taskId: taskId('t4'),
          title: 'Pending - no deps',
          status: 'pending' as const,
          iterations: 0,
          dependencies: [],
        },
      ],
      completedTaskCount: 1,
      pendingTaskCount: 3,
      canResume: true,
      resumeAction: 'continue_phase' as const,
    };

    const executable = getNextExecutableTasks(context);
    assert.strictEqual(executable.length, 2);
    assert.ok(executable.some((t) => String(t.taskId) === 't2'));
    assert.ok(executable.some((t) => String(t.taskId) === 't4'));
    assert.ok(!executable.some((t) => String(t.taskId) === 't3'));
  });

  await t.test('should not include blocked tasks', () => {
    const context = {
      sessionId: sessionId('test'),
      originalTask: 'Test',
      startedAt: '2024-01-01T00:00:00.000Z',
      lastPhase: null,
      phaseCompleted: false,
      tasks: [
        {
          taskId: taskId('t1'),
          title: 'Blocked task',
          status: 'blocked' as const,
          iterations: 0,
          dependencies: [],
        },
      ],
      completedTaskCount: 0,
      pendingTaskCount: 0,
      canResume: true,
      resumeAction: 'continue_phase' as const,
    };

    const executable = getNextExecutableTasks(context);
    assert.strictEqual(executable.length, 0);
  });
});
