import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createDefaultConfig, ConfigSchema } from '../../types/config.ts';
import { toDisplayPath } from '../utils/display-path.ts';

/**
 * `agent init` コマンドの実装
 *
 * プロジェクトの初期化を行う：
 * - .agent/config.json の生成
 * - agent-coord リポジトリのディレクトリ構造作成
 */
export function createInitCommand(): Command {
  const initCommand = new Command('init')
    .description('Initialize agent orchestrator configuration')
    .option('--global', 'Initialize global configuration (~/.agent/config.json)', false)
    .option('--app-repo <path>', 'Path to application repository', process.cwd())
    .option(
      '--agent-coord <path>',
      'Path to agent coordination repository',
      path.join(process.cwd(), '.agent', 'coord'),
    )
    .option('--force', 'Overwrite existing configuration without confirmation', false)
    .action(async (options) => {
      try {
        if (options.global) {
          await initializeGlobalConfig({ force: options.force });
        } else {
          await initializeProject({
            appRepoPath: path.resolve(options.appRepo),
            agentCoordPath: path.resolve(options.agentCoord),
            force: options.force,
          });
        }
      } catch (error) {
        console.error('Initialization failed:', error);
        process.exit(1);
      }
    });

  return initCommand;
}

/**
 * プロジェクト初期化の実装
 */
async function initializeProject(params: {
  appRepoPath: string;
  agentCoordPath: string;
  force: boolean;
}): Promise<void> {
  const { appRepoPath, agentCoordPath, force } = params;

  const configPath = path.join(appRepoPath, '.agent', 'config.json');

  // 既存設定ファイルチェック
  if (!force) {
    try {
      await fs.access(configPath);
      console.error(
        `Configuration file already exists: ${toDisplayPath(configPath)}\nUse --force to overwrite`,
      );
      process.exit(1);
    } catch {
      // ファイルが存在しない場合は続行
    }
  }

  // 設定ファイル生成
  const config = createDefaultConfig({
    appRepoPath,
    agentCoordPath,
  });

  // スキーマバリデーション
  const validatedConfig = ConfigSchema.parse(config);

  // .agent ディレクトリ作成
  await fs.mkdir(path.dirname(configPath), { recursive: true });

  // config.json 書き込み
  await fs.writeFile(configPath, JSON.stringify(validatedConfig, null, 2) + '\n', 'utf-8');

  console.log(`✓ Configuration file created: ${toDisplayPath(configPath)}`);

  // agent-coord リポジトリのディレクトリ構造作成
  await createCoordRepoStructure(agentCoordPath);

  console.log(`\n✓ Initialization complete!`);
  console.log(`\nNext steps:`);
  console.log(`  1. Run: agent run "your task description"`);
  console.log(`  2. Check progress: agent status`);
}

/**
 * agent-coord リポジトリのディレクトリ構造を作成
 */
async function createCoordRepoStructure(coordPath: string): Promise<void> {
  const directories = [
    path.join(coordPath, 'tasks'),
    path.join(coordPath, 'runs'),
    path.join(coordPath, 'checks'),
  ];

  for (const dir of directories) {
    await fs.mkdir(dir, { recursive: true });
  }

  console.log(`✓ Coordination repository structure created: ${toDisplayPath(coordPath)}`);

  // .gitkeep ファイルを各ディレクトリに作成（Git管理用）
  for (const dir of directories) {
    await fs.writeFile(path.join(dir, '.gitkeep'), '', 'utf-8');
  }
}

/**
 * グローバル設定の初期化
 *
 * WHY: ユーザーごとのデフォルト設定を~/.agent/config.jsonに作成
 */
async function initializeGlobalConfig(params: { force: boolean }): Promise<void> {
  const { force } = params;
  const homeDir = os.homedir();
  const globalConfigPath = path.join(homeDir, '.agent', 'config.json');

  // 既存設定ファイルチェック
  if (!force) {
    try {
      await fs.access(globalConfigPath);
      console.error(
        `Global configuration file already exists: ${toDisplayPath(globalConfigPath)}\nUse --force to overwrite`,
      );
      process.exit(1);
    } catch {
      // ファイルが存在しない場合は続行
    }
  }

  // グローバル設定のテンプレート
  // WHY: appRepoPathとagentCoordPathは必須フィールドだが、グローバル設定では
  //      各プロジェクトで上書きされることを想定し、プレースホルダーを設定
  const globalConfig = {
    $schema: '../../.agent/config-schema.json',
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
  };

  // ディレクトリ作成
  await fs.mkdir(path.dirname(globalConfigPath), { recursive: true });

  // 設定ファイル書き込み
  await fs.writeFile(globalConfigPath, JSON.stringify(globalConfig, null, 2) + '\n', 'utf-8');

  console.log(`✓ Global configuration file created: ${toDisplayPath(globalConfigPath)}`);
  console.log(`\nYou can now customize global defaults like:`);
  console.log(`  - maxWorkers`);
  console.log(`  - agents.*.model`);
  console.log(`  - checks.commands`);
  console.log(`\nProject-specific settings will override these values.`);
}
