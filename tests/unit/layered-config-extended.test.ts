import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadTrackedConfig } from '../../src/cli/utils/layered-config.ts';

describe('Layered Config - Extended Tests', () => {
  let tempDir: string;
  let originalXdgConfigHome: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-config-ext-test-'));

    // XDG_CONFIG_HOMEを一時ディレクトリに設定してグローバル設定を隔離
    originalXdgConfigHome = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tempDir;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });

    // XDG_CONFIG_HOMEを復元
    if (originalXdgConfigHome === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalXdgConfigHome;
    }
  });

  describe('$replace marker', () => {
    it('should replace entire object without merging', async () => {
      // プロジェクト設定
      const projectConfigPath = path.join(tempDir, '.agent', 'config.json');
      await fs.mkdir(path.dirname(projectConfigPath), { recursive: true });
      await fs.writeFile(
        projectConfigPath,
        JSON.stringify({
          appRepoPath: '.',
          agentCoordPath: '.agent/coord',
          maxWorkers: 3,
          agents: {
            planner: { type: 'claude', model: 'claude-opus-4-5' },
            worker: { type: 'claude', model: 'claude-sonnet-4-5' },
            judge: { type: 'claude', model: 'claude-haiku-4-5' },
          },
          checks: {
            enabled: true,
            failureMode: 'block',
            commands: ['pnpm test', 'pnpm lint'],
            maxRetries: 3,
          },
          commit: {
            autoSignature: false,
            integrationSignature: true,
          },
          integration: {
            method: 'auto',
            postIntegrationEvaluation: true,
            maxAdditionalTaskIterations: 3,
            mergeStrategy: 'ff-prefer',
          },
          planning: {
            qualityThreshold: 60,
            strictContextValidation: false,
            maxTaskDuration: 4,
            maxTasks: 5,
          },
          iterations: {
            plannerQualityRetries: 5,
            judgeTaskRetries: 3,
            orchestrateMainLoop: 3,
            serialChainTaskRetries: 3,
          },
          replanning: {
            enabled: true,
            maxIterations: 3,
            timeoutSeconds: 300,
          },
          worktree: {
            postCreate: [],
          },
        }),
      );

      // プロジェクトローカルで$replaceを使用
      const projectLocalConfigPath = path.join(tempDir, '.agent', 'config.local.json');
      await fs.writeFile(
        projectLocalConfigPath,
        JSON.stringify({
          checks: {
            $replace: {
              enabled: false,
              failureMode: 'warn',
              commands: ['pnpm typecheck'],
              maxRetries: 1,
            },
          },
        }),
      );

      const result = await loadTrackedConfig(tempDir);

      assert.ok(result.ok);
      if (!result.ok) return;

      // $replaceにより、projectのchecksを完全に置き換え
      assert.strictEqual(result.val.config.checks.enabled, false);
      assert.strictEqual(result.val.config.checks.failureMode, 'warn');
      assert.deepStrictEqual(result.val.config.checks.commands, ['pnpm typecheck']);
      assert.strictEqual(result.val.config.checks.maxRetries, 1);
    });
  });

  describe('Path resolution', () => {
    it('should resolve relative paths based on config file location', async () => {
      // プロジェクト設定（相対パス）
      const projectConfigPath = path.join(tempDir, '.agent', 'config.json');
      await fs.mkdir(path.dirname(projectConfigPath), { recursive: true });
      await fs.writeFile(
        projectConfigPath,
        JSON.stringify({
          appRepoPath: '.',
          agentCoordPath: '.agent/coord',
          maxWorkers: 3,
          agents: {
            planner: { type: 'claude', model: 'claude-opus-4-5' },
            worker: { type: 'claude', model: 'claude-sonnet-4-5' },
            judge: { type: 'claude', model: 'claude-haiku-4-5' },
          },
          checks: {
            enabled: true,
            failureMode: 'block',
            commands: [],
            maxRetries: 3,
          },
          commit: {
            autoSignature: false,
            integrationSignature: true,
          },
          integration: {
            method: 'auto',
            postIntegrationEvaluation: true,
            maxAdditionalTaskIterations: 3,
            mergeStrategy: 'ff-prefer',
          },
          planning: {
            qualityThreshold: 60,
            strictContextValidation: false,
            maxTaskDuration: 4,
            maxTasks: 5,
          },
          iterations: {
            plannerQualityRetries: 5,
            judgeTaskRetries: 3,
            orchestrateMainLoop: 3,
            serialChainTaskRetries: 3,
          },
          replanning: {
            enabled: true,
            maxIterations: 3,
            timeoutSeconds: 300,
          },
          worktree: {
            postCreate: [],
          },
        }),
      );

      const result = await loadTrackedConfig(tempDir);

      assert.ok(result.ok);
      if (!result.ok) return;

      // 相対パスが絶対パスに解決される
      assert.ok(path.isAbsolute(result.val.config.appRepoPath));
      assert.ok(path.isAbsolute(result.val.config.agentCoordPath));

      // パスがtempDirを基準に解決される
      assert.strictEqual(result.val.config.appRepoPath, tempDir);
      assert.strictEqual(result.val.config.agentCoordPath, path.join(tempDir, '.agent', 'coord'));
    });
  });

  describe('Deep merge behavior', () => {
    it('should merge nested objects recursively', async () => {
      // プロジェクト設定
      const projectConfigPath = path.join(tempDir, '.agent', 'config.json');
      await fs.mkdir(path.dirname(projectConfigPath), { recursive: true });
      await fs.writeFile(
        projectConfigPath,
        JSON.stringify({
          appRepoPath: '.',
          agentCoordPath: '.agent/coord',
          maxWorkers: 3,
          agents: {
            planner: { type: 'claude', model: 'claude-opus-4-5' },
            worker: { type: 'claude', model: 'claude-sonnet-4-5' },
            judge: { type: 'claude', model: 'claude-haiku-4-5' },
          },
          checks: {
            enabled: true,
            failureMode: 'block',
            commands: [],
            maxRetries: 3,
          },
          commit: {
            autoSignature: false,
            integrationSignature: true,
          },
          integration: {
            method: 'auto',
            postIntegrationEvaluation: true,
            maxAdditionalTaskIterations: 3,
            mergeStrategy: 'ff-prefer',
          },
          planning: {
            qualityThreshold: 60,
            strictContextValidation: false,
            maxTaskDuration: 4,
            maxTasks: 5,
          },
          iterations: {
            plannerQualityRetries: 5,
            judgeTaskRetries: 3,
            orchestrateMainLoop: 3,
            serialChainTaskRetries: 3,
          },
          replanning: {
            enabled: true,
            maxIterations: 3,
            timeoutSeconds: 300,
          },
          worktree: {
            postCreate: [],
          },
        }),
      );

      // プロジェクトローカルで一部のみ上書き
      const projectLocalConfigPath = path.join(tempDir, '.agent', 'config.local.json');
      await fs.writeFile(
        projectLocalConfigPath,
        JSON.stringify({
          agents: {
            worker: {
              model: 'claude-opus-4-5',
            },
          },
        }),
      );

      const result = await loadTrackedConfig(tempDir);

      assert.ok(result.ok);
      if (!result.ok) return;

      // agents.worker.modelのみ上書き、typeは維持
      assert.strictEqual(result.val.config.agents.worker.type, 'claude');
      assert.strictEqual(result.val.config.agents.worker.model, 'claude-opus-4-5');

      // 他のエージェント設定は変更なし
      assert.strictEqual(result.val.config.agents.planner.model, 'claude-opus-4-5');
      assert.strictEqual(result.val.config.agents.judge.model, 'claude-haiku-4-5');
    });

    it('should replace arrays completely', async () => {
      // プロジェクト設定
      const projectConfigPath = path.join(tempDir, '.agent', 'config.json');
      await fs.mkdir(path.dirname(projectConfigPath), { recursive: true });
      await fs.writeFile(
        projectConfigPath,
        JSON.stringify({
          appRepoPath: '.',
          agentCoordPath: '.agent/coord',
          maxWorkers: 3,
          agents: {
            planner: { type: 'claude', model: 'claude-opus-4-5' },
            worker: { type: 'claude', model: 'claude-sonnet-4-5' },
            judge: { type: 'claude', model: 'claude-haiku-4-5' },
          },
          checks: {
            enabled: true,
            failureMode: 'block',
            commands: ['pnpm test', 'pnpm lint'],
            maxRetries: 3,
          },
          commit: {
            autoSignature: false,
            integrationSignature: true,
          },
          integration: {
            method: 'auto',
            postIntegrationEvaluation: true,
            maxAdditionalTaskIterations: 3,
            mergeStrategy: 'ff-prefer',
          },
          planning: {
            qualityThreshold: 60,
            strictContextValidation: false,
            maxTaskDuration: 4,
            maxTasks: 5,
          },
          iterations: {
            plannerQualityRetries: 5,
            judgeTaskRetries: 3,
            orchestrateMainLoop: 3,
            serialChainTaskRetries: 3,
          },
          replanning: {
            enabled: true,
            maxIterations: 3,
            timeoutSeconds: 300,
          },
          worktree: {
            postCreate: ['pnpm install'],
          },
        }),
      );

      // プロジェクトローカルで配列を上書き
      const projectLocalConfigPath = path.join(tempDir, '.agent', 'config.local.json');
      await fs.writeFile(
        projectLocalConfigPath,
        JSON.stringify({
          worktree: {
            postCreate: ['npm install', 'npm run build'],
          },
        }),
      );

      const result = await loadTrackedConfig(tempDir);

      assert.ok(result.ok);
      if (!result.ok) return;

      // 配列は完全置換（マージではない）
      assert.deepStrictEqual(result.val.config.worktree.postCreate, ['npm install', 'npm run build']);
    });
  });

  describe('Source tracking', () => {
    it('should track config sources correctly', async () => {
      // プロジェクト設定
      const projectConfigPath = path.join(tempDir, '.agent', 'config.json');
      await fs.mkdir(path.dirname(projectConfigPath), { recursive: true });
      await fs.writeFile(
        projectConfigPath,
        JSON.stringify({
          appRepoPath: '.',
          agentCoordPath: '.agent/coord',
          maxWorkers: 3,
          agents: {
            planner: { type: 'claude', model: 'claude-opus-4-5' },
            worker: { type: 'claude', model: 'claude-sonnet-4-5' },
            judge: { type: 'claude', model: 'claude-haiku-4-5' },
          },
          checks: {
            enabled: true,
            failureMode: 'block',
            commands: [],
            maxRetries: 3,
          },
          commit: {
            autoSignature: false,
            integrationSignature: true,
          },
          integration: {
            method: 'auto',
            postIntegrationEvaluation: true,
            maxAdditionalTaskIterations: 3,
            mergeStrategy: 'ff-prefer',
          },
          planning: {
            qualityThreshold: 60,
            strictContextValidation: false,
            maxTaskDuration: 4,
            maxTasks: 5,
          },
          iterations: {
            plannerQualityRetries: 5,
            judgeTaskRetries: 3,
            orchestrateMainLoop: 3,
            serialChainTaskRetries: 3,
          },
          replanning: {
            enabled: true,
            maxIterations: 3,
            timeoutSeconds: 300,
          },
          worktree: {
            postCreate: [],
          },
        }),
      );

      // プロジェクトローカル設定
      const projectLocalConfigPath = path.join(tempDir, '.agent', 'config.local.json');
      await fs.writeFile(
        projectLocalConfigPath,
        JSON.stringify({
          maxWorkers: 10,
          agents: {
            worker: {
              model: 'claude-opus-4-5',
            },
          },
        }),
      );

      const result = await loadTrackedConfig(tempDir);

      assert.ok(result.ok);
      if (!result.ok) return;

      // maxWorkersの出所を確認
      const maxWorkersSource = result.val.sourceMap.get('maxWorkers');
      assert.ok(maxWorkersSource);
      assert.strictEqual(maxWorkersSource.layer, 'project-local');

      // agents.worker.modelの出所を確認
      const workerModelSource = result.val.sourceMap.get('agents.worker.model');
      assert.ok(workerModelSource);
      assert.strictEqual(workerModelSource.layer, 'project-local');
    });
  });
});
