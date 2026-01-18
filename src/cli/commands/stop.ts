import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ConfigSchema } from '../../types/config.ts';
import { createFileStore } from '../../core/task-store/file-store.ts';
import { taskId } from '../../types/branded.ts';
import { unwrapOk, isOk } from 'option-t/plain_result';
import type { Task } from '../../types/task.ts';

/**
 * `agent stop` コマンドの実装
 *
 * 実行中のタスクを中断する。
 */
export function createStopCommand(): Command {
  const stopCommand = new Command('stop')
    .description('Stop a running task')
    .argument('[taskId]', 'Task ID to stop')
    .option('--config <path>', 'Path to configuration file')
    .option('--all', 'Stop all running tasks', false)
    .action(async (taskIdArg: string | undefined, options) => {
      try {
        await stopTask({
          taskId: taskIdArg,
          configPath: options.config,
          stopAll: options.all,
        });
      } catch (error) {
        console.error('Stop failed:', error);
        process.exit(1);
      }
    });

  return stopCommand;
}

/**
 * タスク中断の実装
 */
async function stopTask(params: {
  taskId?: string;
  configPath?: string;
  stopAll: boolean;
}): Promise<void> {
  const { taskId: taskIdArg, configPath, stopAll } = params;

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
  const allTasks = unwrapOk(tasksResult) as Task[];

  // RUNNING状態のタスクをフィルタ
  const runningTasks = allTasks.filter((task) => task.state === 'RUNNING');

  if (runningTasks.length === 0) {
    console.log('No running tasks found.');
    return;
  }

  // タスクID指定がない場合、実行中タスクを表示
  if (!taskIdArg && !stopAll) {
    console.log(`\nRunning tasks (${runningTasks.length}):\n`);
    for (const task of runningTasks) {
      console.log(`  - ${task.id} (owner: ${task.owner ?? 'none'})`);
    }
    console.log(`\nUse 'agent stop <taskId>' to stop a specific task`);
    console.log(`Use 'agent stop --all' to stop all running tasks\n`);
    return;
  }

  // 中断対象のタスクを決定
  const tasksToStop = stopAll ? runningTasks : runningTasks.filter((task) => task.id === taskIdArg);

  if (tasksToStop.length === 0) {
    console.error(`Task not found or not running: ${taskIdArg}\n\nRunning tasks:`);
    for (const task of runningTasks) {
      console.log(`  - ${task.id}`);
    }
    process.exit(1);
  }

  // タスクを中断
  for (const task of tasksToStop) {
    console.log(`Stopping task: ${task.id}...`);

    const tid = taskId(task.id);
    const updateResult = await taskStore.updateTaskCAS(tid, task.version, (current) => ({
      ...current,
      state: 'BLOCKED' as const,
    }));

    if (isOk(updateResult)) {
      console.log(`✅ Task stopped: ${task.id}`);
    } else {
      console.error(`❌ Failed to stop task: ${task.id}`);
    }
  }

  console.log(`\n${stopAll ? 'All running tasks' : 'Task'} stopped successfully.\n`);
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
