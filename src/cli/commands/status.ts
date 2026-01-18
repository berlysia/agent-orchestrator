import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ConfigSchema } from '../../types/config.ts';
import { createFileStore } from '../../core/task-store/file-store.ts';
import { unwrapOk } from 'option-t/plain_result';

/**
 * `agent status` コマンドの実装
 *
 * タスクの状態を表示する。
 */
export function createStatusCommand(): Command {
  const statusCommand = new Command('status')
    .description('Show task status and progress')
    .option('--config <path>', 'Path to configuration file')
    .action(async (options) => {
      try {
        await showStatus({
          configPath: options.config,
        });
      } catch (error) {
        console.error('Status check failed:', error);
        process.exit(1);
      }
    });

  return statusCommand;
}

/**
 * status表示の実装
 */
async function showStatus(params: { configPath?: string }): Promise<void> {
  const { configPath } = params;

  // 設定ファイルのパスを決定
  const resolvedConfigPath = configPath ?? path.join(process.cwd(), '.agent', 'config.json');

  // 設定ファイルを読み込み
  const config = await loadConfig(resolvedConfigPath);

  // TaskStoreを初期化
  const taskStore = createFileStore({
    basePath: config.agentCoordPath,
  });

  // 全タスクを取得
  const tasksResult = await taskStore.listTasks();
  const tasks = unwrapOk(tasksResult);

  // タスク一覧を表示
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Task Status (${tasks.length} tasks)`);
  console.log(`${'='.repeat(80)}\n`);

  if (tasks.length === 0) {
    console.log('  No tasks found.');
    console.log(`\nRun 'agent run "<instruction>"' to create tasks.\n`);
    return;
  }

  // ヘッダー
  console.log(
    `${'ID'.padEnd(20)} ${'State'.padEnd(12)} ${'Owner'.padEnd(15)} ${'Branch'.padEnd(25)}`,
  );
  console.log('-'.repeat(80));

  // タスク一覧
  for (const task of tasks) {
    const stateIcon = getStateIcon(task.state);
    const stateText = `${stateIcon} ${task.state}`;
    const owner = task.owner ?? '-';
    const branch = task.branch ?? '-';

    console.log(
      `${task.id.padEnd(20)} ${stateText.padEnd(12)} ${owner.padEnd(15)} ${branch.padEnd(25)}`,
    );
  }

  console.log(`\n${'='.repeat(80)}\n`);

  // サマリー
  const summary = tasks.reduce(
    (acc, task) => {
      acc[task.state] = (acc[task.state] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  console.log('Summary:');
  for (const [state, count] of Object.entries(summary)) {
    const icon = getStateIcon(state);
    console.log(`  ${icon} ${state}: ${count}`);
  }
  console.log();
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

/**
 * タスク状態に対応するアイコンを取得
 */
function getStateIcon(state: string): string {
  switch (state) {
    case 'READY':
      return '⏳';
    case 'RUNNING':
      return '🚀';
    case 'DONE':
      return '✅';
    case 'BLOCKED':
      return '🚫';
    case 'CANCELLED':
      return '❌';
    default:
      return '❓';
  }
}
