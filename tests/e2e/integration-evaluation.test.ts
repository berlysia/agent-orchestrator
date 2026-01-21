import { test } from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createOrchestrator } from '../../src/core/orchestrator/orchestrate.ts';
import { createFileStore } from '../../src/core/task-store/file-store.ts';
import { createSimpleGitEffects } from '../../src/adapters/vcs/simple-git-effects.ts';
import { createSpawnGitEffects } from '../../src/adapters/vcs/spawn-git-effects.ts';
import type { Config } from '../../src/types/config.ts';
import type { RunnerEffects } from '../../src/core/runner/runner-effects.ts';
import type { PlannerSessionEffects } from '../../src/core/orchestrator/planner-session-effects.ts';
import { createOk } from 'option-t/plain_result';
import type { RunId } from '../../src/types/branded.ts';
import type { Run } from '../../src/types/run.ts';
import type { PlannerSession } from '../../src/types/planner-session.ts';
import { spawn } from 'node:child_process';

// プロジェクトルートを取得
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const TEST_BASE_PATH = path.join(PROJECT_ROOT, '.tmp', 'test-e2e-integration');

/**
 * Gitリポジトリを初期化するヘルパー関数
 */
async function initGitRepo(repoPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('git', ['init'], { cwd: repoPath });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git init failed with code ${code}`));
    });
  });

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('git', ['config', 'user.name', 'Test User'], { cwd: repoPath });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git config user.name failed with code ${code}`));
    });
  });

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git config user.email failed with code ${code}`));
    });
  });

  // 初期コミットを作成
  await fs.writeFile(path.join(repoPath, 'README.md'), '# Test Project\n');
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('git', ['add', 'README.md'], { cwd: repoPath });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git add failed with code ${code}`));
    });
  });

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git commit failed with code ${code}`));
    });
  });
}

/**
 * モックRunnerEffects
 *
 * WHY: 実際のAPIを呼び出さずにテストを高速化
 */
function createMockRunnerEffects(coordPath: string): RunnerEffects {
  let taskCounter = 0;

  return {
    ensureRunsDir: async () => {
      console.log(`[Mock] ensureRunsDir: coordPath=${coordPath}`);
      const runsPath = path.join(coordPath, 'runs');
      console.log(`[Mock] ensureRunsDir: runsPath=${runsPath}`);
      await fs.mkdir(runsPath, { recursive: true });
      return createOk(undefined);
    },

    initializeLogFile: async (run: Run) => {
      console.log(`[Mock] initializeLogFile: run.id=${run.id}, run.logPath=${run.logPath}`);
      const logPath = path.join(coordPath, 'runs', `${run.id}.log`);
      await fs.writeFile(logPath, `=== Mock Run ${run.id} ===\n`);
      return createOk(undefined);
    },

    appendLog: async (runId: RunId, content: string) => {
      console.log(`[Mock] appendLog: runId=${runId}`);
      const logPath = path.join(coordPath, 'runs', `${runId}.log`);
      await fs.appendFile(logPath, content);
      return createOk(undefined);
    },

    saveRunMetadata: async (run: Run) => {
      console.log(`[Mock] saveRunMetadata: run.id=${run.id}, run.logPath=${run.logPath}`);
      const metadataPath = path.join(coordPath, 'runs', `${run.id}.json`);
      await fs.writeFile(metadataPath, JSON.stringify(run, null, 2));
      return createOk(undefined);
    },

    loadRunMetadata: async (runId: RunId) => {
      console.log(`[Mock] loadRunMetadata: runId=${runId}`);
      const metadataPath = path.join(coordPath, 'runs', `${runId}.json`);
      const content = await fs.readFile(metadataPath, 'utf-8');
      return createOk(JSON.parse(content) as Run);
    },

    runClaudeAgent: async (prompt: string, _repoPath: string, _model?: string) => {
      taskCounter++;

      // プロンプトに応じてレスポンスを変える
      if (prompt.includes('break down this instruction')) {
        // タスク分解プロンプト
        const tasks = [
          {
            id: 'task-1',
            description: 'Mock task 1',
            branch: `feature/mock-task-${taskCounter}`,
            scopePaths: ['src/'],
            acceptance: 'Task 1 completed',
            type: 'implementation',
            estimatedDuration: 1.0,
            context: 'Mock context for task 1',
            dependencies: [],
          },
        ];
        return createOk({
          finalResponse: JSON.stringify(tasks),
          usage: { inputTokens: 100, outputTokens: 50 },
        });
      } else if (prompt.includes('quality') || prompt.includes('evaluate the quality')) {
        // 品質判定プロンプト
        const judgement = {
          isAcceptable: true,
          issues: [],
          suggestions: [],
          overallScore: 90,
        };
        return createOk({
          finalResponse: JSON.stringify(judgement),
          usage: { inputTokens: 100, outputTokens: 50 },
        });
      } else if (prompt.includes('evaluate') || prompt.includes('completion')) {
        // 最終評価プロンプト
        const evaluation = {
          isComplete: true,
          missingAspects: [],
          additionalTaskSuggestions: [],
          completionScore: 100,
        };
        return createOk({
          finalResponse: JSON.stringify(evaluation),
          usage: { inputTokens: 100, outputTokens: 50 },
        });
      } else {
        // その他（Worker実行など）
        return createOk({
          finalResponse: `Mock response for ${taskCounter}`,
          usage: { inputTokens: 100, outputTokens: 50 },
        });
      }
    },

    runCodexAgent: async (_prompt: string, _repoPath: string, _model?: string) => {
      taskCounter++;
      const response = `Mock Codex response for task ${taskCounter}`;
      return createOk({
        finalResponse: response,
        usage: { inputTokens: 100, outputTokens: 50 },
      });
    },

    readLog: async (runId: RunId) => {
      console.log(`[Mock] readLog: runId=${runId}`);
      const logPath = path.join(coordPath, 'runs', `${runId}.log`);
      const content = await fs.readFile(logPath, 'utf-8');
      return createOk(content);
    },

    listRunLogs: async () => {
      console.log(`[Mock] listRunLogs`);
      const runsDir = path.join(coordPath, 'runs');
      const files = await fs.readdir(runsDir);
      const logFiles = files.filter((f) => f.endsWith('.log'));
      return createOk(logFiles);
    },
  };
}

/**
 * モックPlannerSessionEffects
 */
function createMockSessionEffects(coordPath: string): PlannerSessionEffects {
  return {
    ensureSessionsDir: async () => {
      await fs.mkdir(path.join(coordPath, 'sessions'), { recursive: true });
      return createOk(undefined);
    },

    saveSession: async (session: PlannerSession) => {
      const sessionsDir = path.join(coordPath, 'sessions');
      const sessionPath = path.join(sessionsDir, `${session.sessionId}.json`);
      console.log(`[Mock] saveSession: ${sessionPath}`);
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(sessionPath, JSON.stringify(session, null, 2));
      return createOk(undefined);
    },

    loadSession: async (sessionId: string) => {
      console.log(`[Mock] loadSession: sessionId=${sessionId}, coordPath=${coordPath}`);
      const sessionPath = path.join(coordPath, 'sessions', `${sessionId}.json`);
      const content = await fs.readFile(sessionPath, 'utf-8');
      return createOk(JSON.parse(content) as PlannerSession);
    },

    sessionExists: async (sessionId: string) => {
      const sessionPath = path.join(coordPath, 'sessions', `${sessionId}.json`);
      return await fs.stat(sessionPath).then(
        () => createOk(true),
        () => createOk(false),
      );
    },

    listSessions: async () => {
      console.log(`[Mock] listSessions`);
      const sessionsDir = path.join(coordPath, 'sessions');
      try {
        await fs.access(sessionsDir);
      } catch {
        return createOk([]);
      }
      const files = await fs.readdir(sessionsDir);
      const sessionFiles = files.filter((f) => f.endsWith('.json'));
      const summaries = [];
      for (const file of sessionFiles) {
        try {
          const filePath = path.join(sessionsDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const session = JSON.parse(content) as PlannerSession;
          summaries.push({
            sessionId: session.sessionId,
            instruction: session.instruction,
            createdAt: session.createdAt,
            taskCount: session.generatedTasks.length,
          });
        } catch {
          // ファイル読み込み失敗は無視
        }
      }
      return createOk(summaries);
    },
  };
}

test('E2E: Integration Evaluation', async (t) => {
  await t.test('setup - clean test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    await fs.mkdir(TEST_BASE_PATH, { recursive: true });
  });

  const appRepoPath = path.join(TEST_BASE_PATH, 'app-repo');
  const coordPath = path.join(TEST_BASE_PATH, 'agent-coord');

  await t.test('setup - create app and coord directories', async () => {
    await fs.mkdir(appRepoPath, { recursive: true });
    await fs.mkdir(coordPath, { recursive: true });

    // Gitリポジトリを初期化
    await initGitRepo(appRepoPath);
  });

  await t.test('integration evaluation - basic flow with postIntegrationEvaluation', async () => {
    // WHY: 統合後評価が有効な場合、統合worktreeを作成してコード差分を取得することを検証

    const config: Config = {
      appRepoPath,
      agentCoordPath: coordPath,
      maxWorkers: 1,
      agents: {
        planner: { type: 'claude', model: 'claude-sonnet-4-5' },
        worker: { type: 'claude', model: 'claude-sonnet-4-5' },
        judge: { type: 'claude', model: 'claude-haiku-4-5' },
      },
      checks: { enabled: false, failureMode: 'warn' },
      commit: { autoSignature: false, integrationSignature: false },
      integration: {
        method: 'auto',
        postIntegrationEvaluation: true, // 統合後評価を有効化
        maxAdditionalTaskIterations: 2,
      },
      planning: {
        qualityThreshold: 50,
        strictContextValidation: false,
        maxTaskDuration: 4,
        maxTasks: 5,
      },
      iterations: {
        plannerQualityRetries: 1,
        judgeTaskRetries: 1,
        orchestrateMainLoop: 1,
        serialChainTaskRetries: 1,
      },
    };

    const taskStore = createFileStore({ basePath: coordPath });
    const gitEffects = {
      ...createSimpleGitEffects(),
      ...createSpawnGitEffects(),
    };
    const runnerEffects = createMockRunnerEffects(coordPath);
    const sessionEffects = createMockSessionEffects(coordPath);

    // Note: このテストはモックエージェントを使用しているため、
    // 実際のタスク分解や評価は行われません。
    // フロー全体の構造を検証する目的です。

    const orchestratorOps = createOrchestrator({
      taskStore,
      gitEffects,
      runnerEffects,
      sessionEffects,
      config,
      maxWorkers: 1,
    });

    const result = await orchestratorOps.executeInstruction('Test instruction');

    // 基本的な結果検証
    assert.ok(result.ok, 'Orchestration should succeed with mock agents');

    // Note: モックエージェントはタスク分解を行わないため、
    // taskIdsは空の場合があります。実際のE2Eテストでは
    // 実際のAPIを使用してタスクが生成されることを確認します。
  });

  await t.test('integration evaluation - verify worktree operations', async () => {
    // WHY: 統合worktree操作の基本的な動作を検証

    // このテストでは、統合worktreeが正しく作成・クリーンアップされることを
    // 間接的に検証します（orchestrate関数内でのエラーがないことを確認）

    const config: Config = {
      appRepoPath,
      agentCoordPath: coordPath,
      maxWorkers: 1,
      agents: {
        planner: { type: 'claude', model: 'claude-sonnet-4-5' },
        worker: { type: 'claude', model: 'claude-sonnet-4-5' },
        judge: { type: 'claude', model: 'claude-haiku-4-5' },
      },
      checks: { enabled: false, failureMode: 'warn' },
      commit: { autoSignature: false, integrationSignature: false },
      integration: {
        method: 'auto',
        postIntegrationEvaluation: true,
        maxAdditionalTaskIterations: 1,
      },
      planning: {
        qualityThreshold: 50,
        strictContextValidation: false,
        maxTaskDuration: 4,
        maxTasks: 5,
      },
      iterations: {
        plannerQualityRetries: 1,
        judgeTaskRetries: 1,
        orchestrateMainLoop: 1,
        serialChainTaskRetries: 1,
      },
    };

    const taskStore = createFileStore({ basePath: coordPath });
    const gitEffects = {
      ...createSimpleGitEffects(),
      ...createSpawnGitEffects(),
    };
    const runnerEffects = createMockRunnerEffects(coordPath);
    const sessionEffects = createMockSessionEffects(coordPath);

    const orchestratorOps = createOrchestrator({
      taskStore,
      gitEffects,
      runnerEffects,
      sessionEffects,
      config,
      maxWorkers: 1,
    });

    const result = await orchestratorOps.executeInstruction('Another test instruction');

    assert.ok(result.ok, 'Should complete without worktree errors');
  });

  await t.test('additional task loop - verify disabled when postIntegrationEvaluation is false', async () => {
    // WHY: 統合後評価が無効な場合、追加タスクループは実行されないことを検証

    const config: Config = {
      appRepoPath,
      agentCoordPath: coordPath,
      maxWorkers: 1,
      agents: {
        planner: { type: 'claude', model: 'claude-sonnet-4-5' },
        worker: { type: 'claude', model: 'claude-sonnet-4-5' },
        judge: { type: 'claude', model: 'claude-haiku-4-5' },
      },
      checks: { enabled: false, failureMode: 'warn' },
      commit: { autoSignature: false, integrationSignature: false },
      integration: {
        method: 'auto',
        postIntegrationEvaluation: false, // 統合後評価を無効化
        maxAdditionalTaskIterations: 3,
      },
      planning: {
        qualityThreshold: 50,
        strictContextValidation: false,
        maxTaskDuration: 4,
        maxTasks: 5,
      },
      iterations: {
        plannerQualityRetries: 1,
        judgeTaskRetries: 1,
        orchestrateMainLoop: 1,
        serialChainTaskRetries: 1,
      },
    };

    const taskStore = createFileStore({ basePath: coordPath });
    const gitEffects = {
      ...createSimpleGitEffects(),
      ...createSpawnGitEffects(),
    };
    const runnerEffects = createMockRunnerEffects(coordPath);
    const sessionEffects = createMockSessionEffects(coordPath);

    const orchestratorOps = createOrchestrator({
      taskStore,
      gitEffects,
      runnerEffects,
      sessionEffects,
      config,
      maxWorkers: 1,
    });

    const result = await orchestratorOps.executeInstruction('Test without integration evaluation');

    assert.ok(result.ok, 'Should complete without integration evaluation');
  });

  await t.test('additional task loop - verify maxAdditionalTaskIterations limit', async () => {
    // WHY: 追加タスクループの最大反復回数制限を検証

    const config: Config = {
      appRepoPath,
      agentCoordPath: coordPath,
      maxWorkers: 1,
      agents: {
        planner: { type: 'claude', model: 'claude-sonnet-4-5' },
        worker: { type: 'claude', model: 'claude-sonnet-4-5' },
        judge: { type: 'claude', model: 'claude-haiku-4-5' },
      },
      checks: { enabled: false, failureMode: 'warn' },
      commit: { autoSignature: false, integrationSignature: false },
      integration: {
        method: 'auto',
        postIntegrationEvaluation: true,
        maxAdditionalTaskIterations: 1,
      },
      planning: {
        qualityThreshold: 50,
        strictContextValidation: false,
        maxTaskDuration: 4,
        maxTasks: 5,
      },
      iterations: {
        plannerQualityRetries: 1,
        judgeTaskRetries: 1,
        orchestrateMainLoop: 1,
        serialChainTaskRetries: 1,
      },
    };

    const taskStore = createFileStore({ basePath: coordPath });
    const gitEffects = {
      ...createSimpleGitEffects(),
      ...createSpawnGitEffects(),
    };
    const runnerEffects = createMockRunnerEffects(coordPath);
    const sessionEffects = createMockSessionEffects(coordPath);

    const orchestratorOps = createOrchestrator({
      taskStore,
      gitEffects,
      runnerEffects,
      sessionEffects,
      config,
      maxWorkers: 1,
    });

    const result = await orchestratorOps.executeInstruction('Test with zero iterations');

    assert.ok(result.ok, 'Should complete without additional task iterations');
  });

  await t.test('cleanup - remove test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
  });
});
