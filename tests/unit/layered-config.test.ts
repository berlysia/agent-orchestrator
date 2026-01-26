import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadTrackedConfig,
  setConfigValue,
  getConfigValue,
  resolveConfigLayerPaths,
} from '../../src/cli/utils/layered-config.ts';

describe('Layered Config', () => {
  let tempDir: string;
  let originalXdgConfigHome: string | undefined;

  beforeEach(async () => {
    // 一時ディレクトリを作成
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-config-test-'));

    // XDG_CONFIG_HOMEを一時ディレクトリに設定してグローバル設定を隔離
    originalXdgConfigHome = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = tempDir;
  });

  afterEach(async () => {
    // クリーンアップ
    await fs.rm(tempDir, { recursive: true, force: true });

    // XDG_CONFIG_HOMEを復元
    if (originalXdgConfigHome === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalXdgConfigHome;
    }
  });

  describe('resolveConfigLayerPaths', () => {
    it('should resolve config paths correctly', () => {
      const paths = resolveConfigLayerPaths(tempDir);

      const configHome = process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
      const globalConfigDir = path.join(configHome, 'agent-orchestrator');

      assert.strictEqual(paths.global, path.join(globalConfigDir, 'config.json'));
      assert.strictEqual(paths.globalLocal, path.join(globalConfigDir, 'config.local.json'));
      assert.strictEqual(paths.project, path.join(tempDir, '.agent', 'config.json'));
      assert.strictEqual(paths.projectLocal, path.join(tempDir, '.agent', 'config.local.json'));
    });
  });

  describe('loadTrackedConfig', () => {
    it('should load and merge config from multiple layers', async () => {
      // プロジェクト設定を作成
      const projectConfigPath = path.join(tempDir, '.agent', 'config.json');
      await fs.mkdir(path.dirname(projectConfigPath), { recursive: true });
      await fs.writeFile(
        projectConfigPath,
        JSON.stringify({
          appRepoPath: '.',
          agentCoordPath: '.agent/coord',
          maxWorkers: 5,
          agents: {
            planner: { type: 'claude', model: 'claude-opus-4-5' },
            worker: { type: 'claude', model: 'claude-sonnet-4-5' },
            judge: { type: 'claude', model: 'claude-haiku-4-5' },
          },
          checks: {
            enabled: true,
            failureMode: 'block',
            commands: ['pnpm test'],
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

      assert.strictEqual(result.val.config.maxWorkers, 5);
      assert.deepStrictEqual(result.val.config.checks.commands, ['pnpm test']);
    });

    it('should override lower layers with upper layers', async () => {
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

      // プロジェクトローカル設定（上書き）
      const projectLocalConfigPath = path.join(tempDir, '.agent', 'config.local.json');
      await fs.writeFile(
        projectLocalConfigPath,
        JSON.stringify({
          maxWorkers: 10,
        }),
      );

      const result = await loadTrackedConfig(tempDir);

      assert.ok(result.ok);
      if (!result.ok) return;

      // project-localがprojectを上書き
      assert.strictEqual(result.val.config.maxWorkers, 10);

      // 出所追跡の確認
      const source = result.val.sourceMap.get('maxWorkers');
      assert.ok(source);
      assert.strictEqual(source?.layer, 'project-local');
    });

    it('should handle $reset marker correctly', async () => {
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

      // プロジェクトローカルで$resetを使用
      const projectLocalConfigPath = path.join(tempDir, '.agent', 'config.local.json');
      await fs.writeFile(
        projectLocalConfigPath,
        JSON.stringify({
          checks: {
            commands: { $reset: true },
          },
        }),
      );

      const result = await loadTrackedConfig(tempDir);

      assert.ok(result.ok);
      if (!result.ok) return;

      // $resetにより、project-localのcommandsを無視してprojectの値を使用
      assert.deepStrictEqual(result.val.config.checks.commands, ['pnpm test', 'pnpm lint']);
    });
  });

  describe('setConfigValue', () => {
    it('should set config value correctly', async () => {
      const result = await setConfigValue('project', 'maxWorkers', 10, tempDir);

      assert.ok(result.ok);

      // ファイルが作成されたか確認
      const configPath = path.join(tempDir, '.agent', 'config.json');
      const content = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(content);

      assert.strictEqual(config.maxWorkers, 10);
    });

    it('should set nested config value correctly', async () => {
      const result = await setConfigValue('project', 'agents.worker.model', 'claude-opus-4-5', tempDir);

      assert.ok(result.ok);

      // ファイルが作成されたか確認
      const configPath = path.join(tempDir, '.agent', 'config.json');
      const content = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(content);

      assert.strictEqual(config.agents.worker.model, 'claude-opus-4-5');
    });

    it('should unset config value when value is undefined', async () => {
      // まず値を設定
      await setConfigValue('project', 'maxWorkers', 10, tempDir);

      // 値を削除
      const result = await setConfigValue('project', 'maxWorkers', undefined, tempDir);

      assert.ok(result.ok);

      // ファイルを確認
      const configPath = path.join(tempDir, '.agent', 'config.json');
      const content = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(content);

      assert.strictEqual(config.maxWorkers, undefined);
    });
  });

  describe('getConfigValue', () => {
    it('should get config value correctly', () => {
      const config = {
        maxWorkers: 5,
        agents: {
          worker: {
            model: 'claude-sonnet-4-5',
          },
        },
      };

      const value1 = getConfigValue(config, 'maxWorkers');
      assert.strictEqual(value1, 5);

      const value2 = getConfigValue(config, 'agents.worker.model');
      assert.strictEqual(value2, 'claude-sonnet-4-5');

      const value3 = getConfigValue(config, 'nonexistent.key');
      assert.strictEqual(value3, null);
    });
  });
});
