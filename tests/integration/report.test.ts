/**
 * Integration tests for report generation functionality
 *
 * VERIFY:
 * (1) 実際のセッション・タスクデータでレポート生成テストが通る
 * (2) CLIコマンドのE2Eテストが通る
 * (3) 自動生成フックのテストが通る
 * (4) エッジケース（空セッション、全失敗）のテストが通る
 * (5) CI環境でテストが通る
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createFileStore } from '../../src/core/task-store/file-store.ts';
import { PlannerSessionEffectsImpl } from '../../src/core/orchestrator/planner-session-effects-impl.ts';
import { ReportGenerator } from '../../src/core/report/index.ts';
import { createInitialTask, TaskState, BlockReason } from '../../src/types/task.ts';
import { taskId, repoPath, branchName } from '../../src/types/branded.ts';
import type { PlannerSession } from '../../src/types/planner-session.ts';
import { SessionStatus } from '../../src/types/planner-session.ts';

// プロジェクトルートを取得
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const TEST_BASE_PATH = path.join(PROJECT_ROOT, '.tmp', 'test-integration-report');
const CLI_PATH = path.resolve(PROJECT_ROOT, 'src', 'cli', 'index.ts');

/**
 * CLIコマンドを実行するヘルパー関数
 */
async function runCLI(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn('node', [CLI_PATH, ...args], {
      cwd,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

/**
 * テスト用セッションを作成
 */
async function createTestSession(
  coordPath: string,
  sessionData: Partial<PlannerSession> & { sessionId: string },
): Promise<void> {
  const session: PlannerSession = {
    instruction: sessionData.instruction ?? 'Test instruction',
    conversationHistory: sessionData.conversationHistory ?? [],
    generatedTasks: sessionData.generatedTasks ?? [],
    generatedTaskIds: sessionData.generatedTaskIds,
    createdAt: sessionData.createdAt ?? new Date().toISOString(),
    updatedAt: sessionData.updatedAt ?? new Date().toISOString(),
    plannerLogPath: sessionData.plannerLogPath ?? null,
    plannerMetadataPath: sessionData.plannerMetadataPath ?? null,
    finalJudgement: sessionData.finalJudgement ?? null,
    continueIterationCount: sessionData.continueIterationCount ?? 0,
    status: sessionData.status ?? SessionStatus.COMPLETED,
    ...sessionData,
  };

  const sessionDir = path.join(
    coordPath,
    'planner-sessions',
  );
  await fs.mkdir(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, `${sessionData.sessionId}.json`);
  await fs.writeFile(sessionPath, JSON.stringify(session, null, 2), 'utf-8');
}

test('Integration: Report Generation', async (t) => {
  await t.test('setup - clean test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    await fs.mkdir(TEST_BASE_PATH, { recursive: true });
  });

  const coordPath = path.join(TEST_BASE_PATH, 'agent-coord');
  const taskStore = createFileStore({ basePath: coordPath });
  const sessionEffects = new PlannerSessionEffectsImpl(coordPath);
  const reportGenerator = new ReportGenerator(sessionEffects, taskStore, coordPath);

  await t.test('(1) Normal case - multiple tasks with real session data', async () => {
    const rootSessionId = 'session-normal-001';
    const now = new Date();
    const earlier = new Date(now.getTime() - 3600000); // 1 hour ago

    // Create session
    await createTestSession(coordPath, {
      sessionId: rootSessionId,
      rootSessionId: rootSessionId,
      instruction: 'Implement user authentication feature',
      createdAt: earlier.toISOString(),
      updatedAt: now.toISOString(),
      generatedTaskIds: ['task-normal-1', 'task-normal-2', 'task-normal-3'],
      status: SessionStatus.COMPLETED,
      finalJudgement: {
        isComplete: true,
        missingAspects: [],
        additionalTaskSuggestions: [],
        completionScore: 95,
        evaluatedAt: now.toISOString(),
      },
    });

    // Create tasks with different states
    const task1 = createInitialTask({
      id: taskId('task-normal-1'),
      repo: repoPath('/test/repo'),
      branch: branchName('feat/auth-login'),
      scopePaths: ['src/auth/'],
      acceptance: 'Login functionality implemented',
      taskType: 'implementation',
      context: 'Implement login endpoint',
      rootSessionId: rootSessionId,
    });
    task1.state = TaskState.DONE;
    task1.createdAt = earlier.toISOString();
    task1.updatedAt = new Date(earlier.getTime() + 1800000).toISOString(); // 30 min later

    const task2 = createInitialTask({
      id: taskId('task-normal-2'),
      repo: repoPath('/test/repo'),
      branch: branchName('feat/auth-signup'),
      scopePaths: ['src/auth/'],
      acceptance: 'Signup functionality implemented',
      taskType: 'implementation',
      context: 'Implement signup endpoint',
      rootSessionId: rootSessionId,
    });
    task2.state = TaskState.DONE;
    task2.createdAt = new Date(earlier.getTime() + 1800000).toISOString();
    task2.updatedAt = new Date(earlier.getTime() + 3000000).toISOString(); // 50 min from start

    const task3 = createInitialTask({
      id: taskId('task-normal-3'),
      repo: repoPath('/test/repo'),
      branch: branchName('feat/auth-tests'),
      scopePaths: ['tests/auth/'],
      acceptance: 'Authentication tests passing',
      taskType: 'integration',
      context: 'Write authentication tests',
      rootSessionId: rootSessionId,
    });
    task3.state = TaskState.DONE;
    task3.createdAt = new Date(earlier.getTime() + 3000000).toISOString();
    task3.updatedAt = now.toISOString();

    await taskStore.createTask(task1);
    await taskStore.createTask(task2);
    await taskStore.createTask(task3);

    // Generate report
    const report = await reportGenerator.generate(rootSessionId);

    // Verify report content
    assert(report.includes('# 監視レポート'), 'Report should have title');
    // Note: rootSessionId is not included in the report output format
    assert(report.includes('task-normal-1'), 'Report should include task 1');
    assert(report.includes('task-normal-2'), 'Report should include task 2');
    assert(report.includes('task-normal-3'), 'Report should include task 3');
    assert(report.includes('Login functionality implemented'), 'Report should include task acceptance');

    // Save report to file
    const reportPath = await reportGenerator.saveReport(rootSessionId);
    assert(reportPath, 'Report should be saved successfully');
    assert(reportPath.includes(`${rootSessionId}.md`), 'Report path should include session ID');

    // Verify file exists
    const fileExists = await fs.stat(reportPath).then(() => true, () => false);
    assert(fileExists, 'Report file should exist');

    // Verify file content matches generated report
    const savedContent = await fs.readFile(reportPath, 'utf-8');
    assert.strictEqual(savedContent, report, 'Saved report should match generated report');
  });

  await t.test('(2) Chained sessions - parentSessionId linking', async () => {
    const rootSessionId = 'session-chain-root';
    const childSessionId = 'session-chain-child';
    const now = new Date();

    // Create root session
    await createTestSession(coordPath, {
      sessionId: rootSessionId,
      rootSessionId: rootSessionId,
      instruction: 'Initial implementation',
      generatedTaskIds: ['task-chain-1'],
      status: SessionStatus.COMPLETED,
    });

    // Create child session (from continue command)
    await createTestSession(coordPath, {
      sessionId: childSessionId,
      parentSessionId: rootSessionId,
      rootSessionId: rootSessionId,
      instruction: 'Additional improvements',
      generatedTaskIds: ['task-chain-2', 'task-chain-3'],
      status: SessionStatus.COMPLETED,
      continueIterationCount: 1,
    });

    // Create tasks for both sessions
    const task1 = createInitialTask({
      id: taskId('task-chain-1'),
      repo: repoPath('/test/repo'),
      branch: branchName('feat/initial'),
      scopePaths: ['src/'],
      acceptance: 'Initial feature implemented',
      taskType: 'implementation',
      context: 'Initial implementation',
      rootSessionId: rootSessionId,
    });
    task1.state = TaskState.DONE;
    task1.createdAt = new Date(now.getTime() - 7200000).toISOString(); // 2 hours ago
    task1.updatedAt = new Date(now.getTime() - 5400000).toISOString(); // 1.5 hours ago

    const task2 = createInitialTask({
      id: taskId('task-chain-2'),
      repo: repoPath('/test/repo'),
      branch: branchName('feat/improvement-1'),
      scopePaths: ['src/'],
      acceptance: 'Improvement 1 completed',
      taskType: 'implementation',
      context: 'First improvement',
      rootSessionId: rootSessionId,
    });
    task2.state = TaskState.DONE;
    task2.createdAt = new Date(now.getTime() - 3600000).toISOString(); // 1 hour ago
    task2.updatedAt = new Date(now.getTime() - 1800000).toISOString(); // 30 min ago

    const task3 = createInitialTask({
      id: taskId('task-chain-3'),
      repo: repoPath('/test/repo'),
      branch: branchName('feat/improvement-2'),
      scopePaths: ['src/'],
      acceptance: 'Improvement 2 completed',
      taskType: 'implementation',
      context: 'Second improvement',
      rootSessionId: rootSessionId,
    });
    task3.state = TaskState.DONE;
    task3.createdAt = new Date(now.getTime() - 1800000).toISOString();
    task3.updatedAt = now.toISOString();

    await taskStore.createTask(task1);
    await taskStore.createTask(task2);
    await taskStore.createTask(task3);

    // Generate report for root session
    const report = await reportGenerator.generate(rootSessionId);

    // Verify all tasks from both sessions are included
    assert(report.includes('task-chain-1'), 'Report should include task from root session');
    assert(report.includes('task-chain-2'), 'Report should include task from child session');
    assert(report.includes('task-chain-3'), 'Report should include task from child session');
    assert(report.includes('| 総数 | 3 |') || report.includes('Total: 3'), 'Report should show 3 total tasks');
  });

  await t.test('(3) Empty session - zero tasks', async () => {
    const emptySessionId = 'session-empty-001';

    // Create session with no tasks
    await createTestSession(coordPath, {
      sessionId: emptySessionId,
      rootSessionId: emptySessionId,
      instruction: 'Empty session test',
      generatedTaskIds: [],
      status: SessionStatus.PLANNING,
    });

    // Generate report
    const report = await reportGenerator.generate(emptySessionId);

    // Verify report handles empty session gracefully
    assert(report.includes('# 監視レポート'), 'Report should have title');
    // Note: sessionId is not included in the report output format
    assert(report.includes('| 総数 | 0 |') || report.includes('Total: 0'), 'Report should show 0 total tasks');
    assert(report.includes('| 完了 | 0 |') || report.includes('Completed: 0'), 'Report should show 0 completed tasks');

    // Save report
    const reportPath = await reportGenerator.saveReport(emptySessionId);
    assert(reportPath, 'Empty session report should be saved successfully');
  });

  await t.test('(4) All failed - all tasks failed or blocked', async () => {
    const failedSessionId = 'session-failed-001';
    const now = new Date();

    // Create session
    await createTestSession(coordPath, {
      sessionId: failedSessionId,
      rootSessionId: failedSessionId,
      instruction: 'Failed implementation attempt',
      generatedTaskIds: ['task-failed-1', 'task-failed-2', 'task-failed-3'],
      status: SessionStatus.FAILED,
      finalJudgement: {
        isComplete: false,
        missingAspects: ['All tasks failed'],
        additionalTaskSuggestions: [],
        completionScore: 0,
        evaluatedAt: now.toISOString(),
      },
    });

    // Create failed tasks
    const task1 = createInitialTask({
      id: taskId('task-failed-1'),
      repo: repoPath('/test/repo'),
      branch: branchName('feat/failed-1'),
      scopePaths: ['src/'],
      acceptance: 'Should fail',
      taskType: 'implementation',
      context: 'Failed task 1',
      rootSessionId: failedSessionId,
    });
    task1.state = TaskState.CANCELLED;
    task1.createdAt = now.toISOString();
    task1.updatedAt = now.toISOString();

    const task2 = createInitialTask({
      id: taskId('task-failed-2'),
      repo: repoPath('/test/repo'),
      branch: branchName('feat/failed-2'),
      scopePaths: ['src/'],
      acceptance: 'Should be blocked',
      taskType: 'implementation',
      context: 'Blocked task',
      rootSessionId: failedSessionId,
    });
    task2.state = TaskState.BLOCKED;
    task2.blockReason = BlockReason.CONFLICT;
    task2.blockMessage = 'Merge conflict detected in src/main.ts';
    task2.createdAt = now.toISOString();
    task2.updatedAt = now.toISOString();

    const task3 = createInitialTask({
      id: taskId('task-failed-3'),
      repo: repoPath('/test/repo'),
      branch: branchName('feat/failed-3'),
      scopePaths: ['src/'],
      acceptance: 'Should be replaced',
      taskType: 'implementation',
      context: 'Replaced task',
      rootSessionId: failedSessionId,
    });
    task3.state = TaskState.REPLACED_BY_REPLAN;
    task3.replanningInfo = {
      iteration: 0,
      maxIterations: 3,
      replanReason: 'Task requirements changed',
    };
    task3.createdAt = now.toISOString();
    task3.updatedAt = now.toISOString();

    await taskStore.createTask(task1);
    await taskStore.createTask(task2);
    await taskStore.createTask(task3);

    // Generate report
    const report = await reportGenerator.generate(failedSessionId);

    // Verify report shows all failures
    assert(report.includes('# 監視レポート'), 'Report should have title');
    assert(report.includes('| 総数 | 3 |') || report.includes('Total: 3'), 'Report should show 3 total tasks');
    assert(report.includes('| 完了 | 0 |') || report.includes('Completed: 0'), 'Report should show 0 completed tasks');
    assert(report.includes('| 失敗 | 2 |') || report.includes('Failed: 2'), 'Report should show 2 failed tasks (CANCELLED + REPLACED)');
    assert(report.includes('| ブロック | 1 |') || report.includes('Blocked: 1'), 'Report should show 1 blocked task');

    // Verify events section includes conflict
    assert(report.includes('コンフリクト') || report.includes('CONFLICT') || report.includes('Merge conflict'),
      'Report should include conflict event details');
  });

  await t.test('(5) Edge cases - retry events and conflicts', async () => {
    const retrySessionId = 'session-retry-001';
    const now = new Date();

    // Create session
    await createTestSession(coordPath, {
      sessionId: retrySessionId,
      rootSessionId: retrySessionId,
      instruction: 'Task with retries',
      generatedTaskIds: ['task-retry-1'],
      status: SessionStatus.COMPLETED,
    });

    // Create task with retry information
    const task = createInitialTask({
      id: taskId('task-retry-1'),
      repo: repoPath('/test/repo'),
      branch: branchName('feat/retry'),
      scopePaths: ['src/'],
      acceptance: 'Eventually succeeded',
      taskType: 'implementation',
      context: 'Task with retries',
      rootSessionId: retrySessionId,
    });
    task.state = TaskState.DONE;
    task.judgementFeedback = {
      iteration: 2,
      maxIterations: 3,
      lastJudgement: {
        reason: 'Tests passed after fixes',
        missingRequirements: [],
        evaluatedAt: now.toISOString(),
      },
    };
    task.createdAt = new Date(now.getTime() - 3600000).toISOString();
    task.updatedAt = now.toISOString();

    await taskStore.createTask(task);

    // Generate report
    const report = await reportGenerator.generate(retrySessionId);

    // Verify retry event is captured
    assert(report.includes('リトライ') || report.includes('RETRY') || report.includes('retried') || report.includes('2 time'),
      'Report should include retry event information');
  });

  await t.test('cleanup - remove test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
  });
});

test('Integration: CLI E2E - report command', async (t) => {
  const testDir = path.join(TEST_BASE_PATH, 'cli-e2e');
  const coordPath = path.join(testDir, 'agent-coord');

  await t.test('setup - prepare CLI test environment', async () => {
    await fs.rm(testDir, { recursive: true, force: true });
    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(coordPath, { recursive: true });

    // Initialize stores
    const taskStore = createFileStore({ basePath: coordPath });
    const sessionEffects = new PlannerSessionEffectsImpl(coordPath);

    // Create a test session
    const sessionId = 'cli-test-session';
    await createTestSession(coordPath, {
      sessionId,
      rootSessionId: sessionId,
      instruction: 'CLI test session',
      generatedTaskIds: ['cli-task-1', 'cli-task-2'],
      status: SessionStatus.COMPLETED,
    });

    // Create test tasks
    const task1 = createInitialTask({
      id: taskId('cli-task-1'),
      repo: repoPath('/test/repo'),
      branch: branchName('feat/cli-1'),
      scopePaths: ['src/'],
      acceptance: 'CLI task 1 completed',
      taskType: 'implementation',
      context: 'CLI test task 1',
      rootSessionId: sessionId,
    });
    task1.state = TaskState.DONE;

    const task2 = createInitialTask({
      id: taskId('cli-task-2'),
      repo: repoPath('/test/repo'),
      branch: branchName('feat/cli-2'),
      scopePaths: ['src/'],
      acceptance: 'CLI task 2 completed',
      taskType: 'implementation',
      context: 'CLI test task 2',
      rootSessionId: sessionId,
    });
    task2.state = TaskState.DONE;

    await taskStore.createTask(task1);
    await taskStore.createTask(task2);

    // Create config file for CLI
    const configDir = path.join(testDir, '.agent');
    await fs.mkdir(configDir, { recursive: true });
    const config = {
      agentCoordPath: coordPath,
      appRepoPath: testDir,
      maxWorkers: 3,
      agents: {
        planner: { type: 'claude', model: 'claude-sonnet-4-5' },
        worker: { type: 'claude', model: 'claude-sonnet-4-5' },
        judge: { type: 'claude', model: 'claude-sonnet-4-5' },
      },
      worktree: { postSetup: [] },
    };
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify(config, null, 2),
      'utf-8',
    );
  });

  await t.test('(2) CLI command - generate report with session ID', async () => {
    const result = await runCLI(['report', 'cli-test-session'], testDir);

    if (result.exitCode !== 0) {
      console.log('CLI stdout:', result.stdout);
      console.log('CLI stderr:', result.stderr);
    }
    assert.strictEqual(result.exitCode, 0, 'CLI report command should succeed');

    // Verify report file was created
    const reportPath = path.join(coordPath, 'reports', 'cli-test-session.md');
    const fileExists = await fs.stat(reportPath).then(() => true, () => false);
    assert(fileExists, 'Report file should be created by CLI command');

    // Verify report content
    const content = await fs.readFile(reportPath, 'utf-8');
    assert(content.includes('# 監視レポート'), 'Report should have title');
    assert(content.includes('cli-task-1'), 'Report should include task 1');
    assert(content.includes('cli-task-2'), 'Report should include task 2');
  });

  await t.test('(2) CLI command - stdout output', async () => {
    const result = await runCLI(['report', 'cli-test-session', '--stdout'], testDir);

    assert.strictEqual(result.exitCode, 0, 'CLI report command with --stdout should succeed');
    assert(result.stdout.includes('# 監視レポート'), 'Stdout should contain report');
  });

  await t.test('(2) CLI command - report without session ID (latest)', async () => {
    const result = await runCLI(['report'], testDir);

    // Should use the latest session
    assert.strictEqual(result.exitCode, 0, 'CLI report without session ID should succeed');

    // Verify a report file was created (should be for the latest session)
    const reportsDir = path.join(coordPath, 'reports');
    const files = await fs.readdir(reportsDir);
    assert(files.length > 0, 'At least one report file should exist');
  });

  await t.test('(2) CLI command - error on non-existent session', async () => {
    const result = await runCLI(['report', 'non-existent-session'], testDir);

    assert.notStrictEqual(result.exitCode, 0, 'CLI should fail for non-existent session');
    assert(
      result.stderr.includes('not found') || result.stderr.includes('Session not found'),
      'Error message should indicate session not found',
    );
  });

  await t.test('cleanup - remove CLI test directory', async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });
});
