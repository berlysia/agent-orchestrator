/**
 * Session Logger Unit Tests (ADR-027)
 */

import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isOk, isErr } from 'option-t/plain_result';
import { sessionId } from '../../../../src/types/branded.ts';
import {
  NdjsonSessionLogger,
  generateSessionId,
} from '../../../../src/core/session/ndjson-writer.ts';
import { FileSessionPointerManager } from '../../../../src/core/session/session-pointer.ts';
import {
  SessionLogType,
  SessionPhase,
  WorkerStatus,
  JudgeVerdict,
  createPhaseStartRecord,
  createTaskCreatedRecord,
  createWorkerStartRecord,
  createWorkerCompleteRecord,
  createJudgeCompleteRecord,
  createErrorRecord,
} from '../../../../src/types/session-log.ts';
import { taskId, workerId } from '../../../../src/types/branded.ts';

const TEST_BASE_PATH = '/tmp/agent-test-session-logger';

test('SessionLogger: NDJSON logging', async (t) => {
  // Setup
  await t.test('setup - clean test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    await fs.mkdir(TEST_BASE_PATH, { recursive: true });
  });

  const pointerManager = new FileSessionPointerManager(TEST_BASE_PATH);
  const logger = new NdjsonSessionLogger(TEST_BASE_PATH, pointerManager);
  const testSessionId = sessionId('test-session-001');

  await t.test('start - should write session_start record', async () => {
    const result = await logger.start(testSessionId, 'Test task description');
    assert.ok(isOk(result), 'start() should succeed');

    // Verify file was created
    const logFile = path.join(TEST_BASE_PATH, 'sessions', `${testSessionId}.jsonl`);
    const content = await fs.readFile(logFile, 'utf-8');
    const lines = content.trim().split('\n');
    assert.strictEqual(lines.length, 1, 'Should have one line');
    assert.ok(lines[0] !== undefined, 'First line should exist');

    const record = JSON.parse(lines[0]);
    assert.strictEqual(record.type, SessionLogType.SESSION_START);
    assert.strictEqual(record.sessionId, String(testSessionId));
    assert.strictEqual(record.task, 'Test task description');
  });

  await t.test('log - should append phase_start record', async () => {
    const phaseRecord = createPhaseStartRecord(SessionPhase.PLANNING, testSessionId);
    const result = await logger.log(phaseRecord);
    assert.ok(isOk(result), 'log() should succeed');

    const logFile = path.join(TEST_BASE_PATH, 'sessions', `${testSessionId}.jsonl`);
    const content = await fs.readFile(logFile, 'utf-8');
    const lines = content.trim().split('\n');
    assert.strictEqual(lines.length, 2, 'Should have two lines');
    assert.ok(lines[1] !== undefined, 'Second line should exist');

    const record = JSON.parse(lines[1]);
    assert.strictEqual(record.type, SessionLogType.PHASE_START);
    assert.strictEqual(record.phase, SessionPhase.PLANNING);
  });

  await t.test('log - should append task_created record', async () => {
    const taskRecord = createTaskCreatedRecord(taskId('task-001'), 'Test task', {
      taskType: 'implementation',
      dependencies: [],
    });
    const result = await logger.log(taskRecord);
    assert.ok(isOk(result), 'log() should succeed');

    const logFile = path.join(TEST_BASE_PATH, 'sessions', `${testSessionId}.jsonl`);
    const content = await fs.readFile(logFile, 'utf-8');
    const lines = content.trim().split('\n');
    assert.strictEqual(lines.length, 3, 'Should have three lines');

    const line2 = lines[2];
    assert.ok(line2 !== undefined, 'Third line should exist');
    const record = JSON.parse(line2);
    assert.strictEqual(record.type, SessionLogType.TASK_CREATED);
    assert.strictEqual(record.taskId, 'task-001');
  });

  await t.test('log - should append worker_start and worker_complete records', async () => {
    const startRecord = createWorkerStartRecord(taskId('task-001'), workerId('worker-1'), 0);
    const startResult = await logger.log(startRecord);
    assert.ok(isOk(startResult), 'worker_start log() should succeed');

    const completeRecord = createWorkerCompleteRecord(
      taskId('task-001'),
      workerId('worker-1'),
      WorkerStatus.SUCCESS,
      { duration: 5000, changesCount: 3 },
    );
    const completeResult = await logger.log(completeRecord);
    assert.ok(isOk(completeResult), 'worker_complete log() should succeed');

    const logFile = path.join(TEST_BASE_PATH, 'sessions', `${testSessionId}.jsonl`);
    const content = await fs.readFile(logFile, 'utf-8');
    const lines = content.trim().split('\n');
    assert.strictEqual(lines.length, 5, 'Should have five lines');
  });

  await t.test('log - should append judge_complete record', async () => {
    const judgeRecord = createJudgeCompleteRecord(taskId('task-001'), JudgeVerdict.DONE, {
      reason: 'All requirements met',
    });
    const result = await logger.log(judgeRecord);
    assert.ok(isOk(result), 'log() should succeed');

    const logFile = path.join(TEST_BASE_PATH, 'sessions', `${testSessionId}.jsonl`);
    const content = await fs.readFile(logFile, 'utf-8');
    const lines = content.trim().split('\n');

    const lastLine = lines.at(-1);
    assert.ok(lastLine !== undefined, 'Last line should exist');
    const record = JSON.parse(lastLine);
    assert.strictEqual(record.type, SessionLogType.JUDGE_COMPLETE);
    assert.strictEqual(record.verdict, JudgeVerdict.DONE);
  });

  await t.test('log - should append error record', async () => {
    const errorRecord = createErrorRecord('Something went wrong', {
      errorType: 'TestError',
      taskId: taskId('task-001'),
      context: { foo: 'bar' },
    });
    const result = await logger.log(errorRecord);
    assert.ok(isOk(result), 'log() should succeed');

    const logFile = path.join(TEST_BASE_PATH, 'sessions', `${testSessionId}.jsonl`);
    const content = await fs.readFile(logFile, 'utf-8');
    const lines = content.trim().split('\n');

    const lastLine = lines.at(-1);
    assert.ok(lastLine !== undefined, 'Last line should exist');
    const record = JSON.parse(lastLine);
    assert.strictEqual(record.type, SessionLogType.ERROR);
    assert.strictEqual(record.message, 'Something went wrong');
  });

  await t.test('complete - should write session_complete record', async () => {
    const result = await logger.complete('Session completed successfully', {
      tasksCompleted: 1,
      duration: 10000,
    });
    assert.ok(isOk(result), 'complete() should succeed');

    const logFile = path.join(TEST_BASE_PATH, 'sessions', `${testSessionId}.jsonl`);
    const content = await fs.readFile(logFile, 'utf-8');
    const lines = content.trim().split('\n');

    const lastLine = lines.at(-1);
    assert.ok(lastLine !== undefined, 'Last line should exist');
    const record = JSON.parse(lastLine);
    assert.strictEqual(record.type, SessionLogType.SESSION_COMPLETE);
    assert.strictEqual(record.summary, 'Session completed successfully');
    assert.strictEqual(record.tasksCompleted, 1);
  });

  await t.test('getCurrentSessionId - should return undefined after complete', async () => {
    const currentId = logger.getCurrentSessionId();
    assert.strictEqual(currentId, undefined, 'Session should be cleared after complete');
  });

  // Cleanup
  await t.test('cleanup - remove test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
  });
});

test('SessionLogger: abort handling', async (t) => {
  await t.test('setup - clean test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    await fs.mkdir(TEST_BASE_PATH, { recursive: true });
  });

  const pointerManager = new FileSessionPointerManager(TEST_BASE_PATH);
  const logger = new NdjsonSessionLogger(TEST_BASE_PATH, pointerManager);
  const testSessionId = sessionId('test-session-abort');

  await t.test('abort - should write session_abort record', async () => {
    await logger.start(testSessionId, 'Task to abort');
    const result = await logger.abort('Process interrupted', 'InterruptError');
    assert.ok(isOk(result), 'abort() should succeed');

    const logFile = path.join(TEST_BASE_PATH, 'sessions', `${testSessionId}.jsonl`);
    const content = await fs.readFile(logFile, 'utf-8');
    const lines = content.trim().split('\n');

    const lastLine = lines.at(-1);
    assert.ok(lastLine !== undefined, 'Last line should exist');
    const record = JSON.parse(lastLine);
    assert.strictEqual(record.type, SessionLogType.SESSION_ABORT);
    assert.strictEqual(record.reason, 'Process interrupted');
    assert.strictEqual(record.errorType, 'InterruptError');
  });

  await t.test('cleanup - remove test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
  });
});

test('SessionPointerManager: pointer file management', async (t) => {
  await t.test('setup - clean test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    await fs.mkdir(TEST_BASE_PATH, { recursive: true });
  });

  const pointerManager = new FileSessionPointerManager(TEST_BASE_PATH);

  await t.test('getLatest - should return error when no pointer exists', async () => {
    const result = await pointerManager.getLatest();
    assert.ok(isErr(result), 'getLatest() should fail when no pointer exists');
  });

  await t.test('updateLatest - should create latest.json', async () => {
    const info = {
      sessionId: 'session-001',
      startedAt: new Date().toISOString(),
      status: 'running' as const,
    };
    const result = await pointerManager.updateLatest(info);
    assert.ok(isOk(result), 'updateLatest() should succeed');

    const latestResult = await pointerManager.getLatest();
    assert.ok(isOk(latestResult), 'getLatest() should succeed');
    assert.strictEqual(latestResult.val.sessionId, 'session-001');
    assert.strictEqual(latestResult.val.status, 'running');
  });

  await t.test('updateLatest - should rotate to previous.json', async () => {
    const info2 = {
      sessionId: 'session-002',
      startedAt: new Date().toISOString(),
      status: 'running' as const,
    };
    const result = await pointerManager.updateLatest(info2);
    assert.ok(isOk(result), 'updateLatest() should succeed');

    const latestResult = await pointerManager.getLatest();
    assert.ok(isOk(latestResult), 'getLatest() should succeed');
    assert.strictEqual(latestResult.val.sessionId, 'session-002');

    const previousResult = await pointerManager.getPrevious();
    assert.ok(isOk(previousResult), 'getPrevious() should succeed');
    assert.strictEqual(previousResult.val.sessionId, 'session-001');
  });

  await t.test('updateStatus - should update pointer status', async () => {
    const result = await pointerManager.updateStatus('session-002', 'completed');
    assert.ok(isOk(result), 'updateStatus() should succeed');

    const latestResult = await pointerManager.getLatest();
    assert.ok(isOk(latestResult), 'getLatest() should succeed');
    assert.strictEqual(latestResult.val.status, 'completed');
  });

  await t.test('cleanup - remove test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
  });
});

test('generateSessionId: should generate unique IDs', async (t) => {
  await t.test('should generate IDs with default prefix', () => {
    const id1 = generateSessionId();
    const id2 = generateSessionId();

    assert.ok(String(id1).startsWith('session-'), 'Should have default prefix');
    assert.notStrictEqual(String(id1), String(id2), 'IDs should be unique');
  });

  await t.test('should generate IDs with custom prefix', () => {
    const id = generateSessionId('planner');
    assert.ok(String(id).startsWith('planner-'), 'Should have custom prefix');
  });
});
