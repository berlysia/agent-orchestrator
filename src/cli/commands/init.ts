import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline/promises';
import { toDisplayPath } from '../utils/display-path.ts';

/**
 * スキーマファイルのパスを取得
 *
 * WHY: dist/config.schema.json をコピーするため、実行時のパスから相対的に取得
 */
function getSchemaSourcePath(): string {
  // ESM環境で__dirnameの代替
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);

  // src/cli/commands/init.ts から dist/config.schema.json への相対パス
  // ビルド後: dist/cli/commands/init.js から dist/config.schema.json
  return path.join(currentDir, '..', '..', 'config.schema.json');
}

/**
 * スキーマファイルをコピー
 *
 * WHY: IDE補完のため、config.jsonと同じディレクトリにスキーマファイルを配置
 */
async function copySchemaFile(targetDir: string): Promise<void> {
  const sourceSchemaPath = getSchemaSourcePath();
  const targetSchemaPath = path.join(targetDir, 'config-schema.json');

  try {
    const schemaContent = await fs.readFile(sourceSchemaPath, 'utf-8');
    await fs.writeFile(targetSchemaPath, schemaContent, 'utf-8');
    console.log(`✓ Schema file created: ${toDisplayPath(targetSchemaPath)}`);
  } catch (error) {
    console.warn(`⚠️  Could not copy schema file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * `agent init` コマンドの実装
 *
 * プロジェクトの初期化を行う：
 * - .agent/config.json の生成
 * - .agent/config-schema.json のコピー
 * - agent-coord リポジトリのディレクトリ構造作成
 */
export function createInitCommand(): Command {
  const initCommand = new Command('init')
    .description('Initialize agent orchestrator configuration')
    .option('--global', 'Initialize global configuration (~/.config/agent-orchestrator/config.json)', false)
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
 * グローバル設定の存在確認
 */
async function checkGlobalConfigExists(): Promise<boolean> {
  const homeDir = os.homedir();
  const configHome = process.env['XDG_CONFIG_HOME'] || path.join(homeDir, '.config');
  const globalConfigPath = path.join(configHome, 'agent-orchestrator', 'config.json');

  try {
    await fs.access(globalConfigPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * ユーザーに確認を求める
 */
async function askUser(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(`${question} (y/n): `);
    return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
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

  // グローバル設定の確認
  const hasGlobalConfig = await checkGlobalConfigExists();
  if (!hasGlobalConfig) {
    console.log('⚠️  Global configuration not found.');
    const shouldCreateGlobal = await askUser('Would you like to create global configuration now?');

    if (shouldCreateGlobal) {
      await initializeGlobalConfig({ force: false });
      console.log('');
    } else {
      console.log('⚠️  Continuing without global configuration.');
      console.log('   You can create it later with: agent init --global\n');
    }
  }

  // プロジェクト設定ファイル生成（最小限）
  // WHY: グローバル設定から継承するため、プロジェクト固有の値のみ記載
  const projectConfig = {
    $schema: './config-schema.json',
    appRepoPath,
    agentCoordPath,
  };

  // .agent ディレクトリ作成
  await fs.mkdir(path.dirname(configPath), { recursive: true });

  // config.json 書き込み
  await fs.writeFile(configPath, JSON.stringify(projectConfig, null, 2) + '\n', 'utf-8');

  console.log(`✓ Configuration file created: ${toDisplayPath(configPath)}`);

  // .agent/.gitignore 作成
  const gitignorePath = path.join(path.dirname(configPath), '.gitignore');
  const gitignoreContent = [
    '# Agent coordination data',
    'coord/',
    '',
    '# Local configuration overrides',
    'config.local.json',
    '',
  ].join('\n');
  await fs.writeFile(gitignorePath, gitignoreContent, 'utf-8');

  console.log(`✓ Gitignore file created: ${toDisplayPath(gitignorePath)}`);

  // スキーマファイルをコピー
  await copySchemaFile(path.dirname(configPath));

  // WHY: coord/ディレクトリは実行時に自動作成されるため、ここでは作成しない

  console.log(`\n✓ Initialization complete!`);
  console.log(`\nNext steps:`);
  console.log(`  1. Run: agent run "your task description"`);
  console.log(`  2. Check progress: agent status`);
}

/**
 * グローバル設定の初期化
 *
 * WHY: XDG Base Directory仕様に従い、ユーザーごとのデフォルト設定を
 *      ~/.config/agent-orchestrator/config.json に作成
 */
async function initializeGlobalConfig(params: { force: boolean }): Promise<void> {
  const { force } = params;
  const homeDir = os.homedir();
  const configHome = process.env['XDG_CONFIG_HOME'] || path.join(homeDir, '.config');
  const globalConfigDir = path.join(configHome, 'agent-orchestrator');
  const globalConfigPath = path.join(globalConfigDir, 'config.json');

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
    $schema: './config-schema.json',
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
  await fs.mkdir(globalConfigDir, { recursive: true });

  // 設定ファイル書き込み
  await fs.writeFile(globalConfigPath, JSON.stringify(globalConfig, null, 2) + '\n', 'utf-8');

  console.log(`✓ Global configuration file created: ${toDisplayPath(globalConfigPath)}`);

  // スキーマファイルをコピー
  await copySchemaFile(globalConfigDir);

  // .gitignore 作成
  const gitignorePath = path.join(globalConfigDir, '.gitignore');
  const gitignoreContent = ['# Local configuration overrides', 'config.local.json', ''].join('\n');
  await fs.writeFile(gitignorePath, gitignoreContent, 'utf-8');

  console.log(`✓ Gitignore file created: ${toDisplayPath(gitignorePath)}`);

  console.log(`\nYou can now customize global defaults like:`);
  console.log(`  - maxWorkers`);
  console.log(`  - agents.*.model`);
  console.log(`  - checks.commands`);
  console.log(`\nProject-specific settings will override these values.`);
}
