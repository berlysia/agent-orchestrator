import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ConfigSchema } from '../../types/config.ts';
import { createFileStore } from '../../core/task-store/file-store.ts';
import { Runner } from '../../core/runner/index.ts';
import { Orchestrator } from '../../core/orchestrator/index.ts';

/**
 * `agent run` コマンドの実装
 *
 * ユーザーの指示を受け取り、Orchestratorを起動してタスクを実行する。
 */
export function createRunCommand(): Command {
  const runCommand = new Command('run')
    .description('Execute a task using agent orchestration')
    .argument('<instruction>', 'Task instruction for the agent')
    .option('--config <path>', 'Path to configuration file')
    .action(async (instruction: string, options) => {
      try {
        await executeRun({
          instruction,
          configPath: options.config,
        });
      } catch (error) {
        console.error('Execution failed:', error);
        process.exit(1);
      }
    });

  return runCommand;
}

/**
 * agent run の実行処理
 */
async function executeRun(params: { instruction: string; configPath?: string }): Promise<void> {
  const { instruction, configPath } = params;

  // 設定ファイルのパスを決定
  const resolvedConfigPath = configPath ?? path.join(process.cwd(), '.agent', 'config.json');

  // 設定ファイルを読み込み
  const config = await loadConfig(resolvedConfigPath);

  console.log(`📋 Configuration loaded from: ${resolvedConfigPath}`);
  console.log(`   App Repo: ${config.appRepoPath}`);
  console.log(`   Coord Repo: ${config.agentCoordPath}`);
  console.log(`   Max Workers: ${config.maxWorkers}\n`);

  // TaskStoreを初期化
  const taskStore = createFileStore({
    basePath: config.agentCoordPath,
  });

  // Runnerを初期化
  const runner = new Runner({
    coordRepoPath: config.agentCoordPath,
    timeout: 0, // タイムアウトなし
  });

  // Orchestratorを初期化
  const orchestrator = new Orchestrator({
    taskStore,
    runner,
    agentType: config.defaultAgentType,
    appRepoPath: config.appRepoPath,
    maxWorkers: config.maxWorkers,
  });

  // タスクを実行
  console.log(`🚀 Starting orchestration...\n`);
  console.log(`📝 Instruction: "${instruction}"\n`);

  const result = await orchestrator.executeInstruction(instruction);

  // 結果を表示
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Orchestration Summary:`);
  console.log(`  Total tasks: ${result.taskIds.length}`);
  console.log(`  Completed: ${result.completedTaskIds.length}`);
  console.log(`  Failed: ${result.failedTaskIds.length}`);
  console.log(`  Status: ${result.success ? '✅ SUCCESS' : '❌ FAILED'}`);
  console.log(`${'='.repeat(60)}\n`);

  if (!result.success) {
    process.exit(1);
  }
}

/**
 * 設定ファイルを読み込む
 */
async function loadConfig(configPath: string) {
  try {
    const configContent = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configContent);
    return ConfigSchema.parse(config);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Configuration file not found: ${configPath}\nRun 'agent init' to create it.`,
      );
    }
    throw error;
  }
}
