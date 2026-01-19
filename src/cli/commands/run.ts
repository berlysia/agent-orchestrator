import { Command } from 'commander';
import { createFileStore } from '../../core/task-store/file-store.ts';
import { createRunnerEffects } from '../../core/runner/runner-effects-impl.ts';
import { createGitEffects } from '../../adapters/vcs/index.ts';
import { createOrchestrator } from '../../core/orchestrator/orchestrate.ts';
import { PlannerSessionEffectsImpl } from '../../core/orchestrator/planner-session-effects-impl.ts';
import { isErr } from 'option-t/plain_result';
import { loadConfig } from '../utils/load-config.ts';

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

  // 設定ファイルを読み込み
  const config = await loadConfig(configPath);

  console.log(`📋 Configuration loaded`);
  console.log(`   App Repo: ${config.appRepoPath}`);
  console.log(`   Coord Repo: ${config.agentCoordPath}`);
  console.log(`   Max Workers: ${config.maxWorkers}\n`);

  // TaskStoreを初期化
  const taskStore = createFileStore({
    basePath: config.agentCoordPath,
  });

  // RunnerEffectsを初期化
  const runnerEffects = createRunnerEffects({
    coordRepoPath: config.agentCoordPath,
    timeout: 0, // タイムアウトなし
  });

  // GitEffectsを初期化
  const gitEffects = createGitEffects();

  // SessionEffectsを初期化
  const sessionEffects = new PlannerSessionEffectsImpl(config.agentCoordPath);

  // Orchestratorを初期化（新しい関数型実装）
  const orchestrator = createOrchestrator({
    taskStore,
    runnerEffects,
    gitEffects,
    sessionEffects,
    config,
    maxWorkers: config.maxWorkers,
  });

  // タスクを実行
  console.log(`🚀 Starting orchestration...\n`);

  const resultOrError = await orchestrator.executeInstruction(instruction);

  // Result型をunwrap
  if (isErr(resultOrError)) {
    console.error(`\n❌ Orchestration error: ${resultOrError.err.message}`);
    process.exit(1);
  }

  const result = resultOrError.val;

  // 結果を表示
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Orchestration Summary:`);
  console.log(`  Total tasks: ${result.taskIds.length}`);
  console.log(`  Completed: ${result.completedTaskIds.length}`);
  console.log(`  Failed: ${result.failedTaskIds.length}`);
  if (result.blockedTaskIds && result.blockedTaskIds.length > 0) {
    console.log(`  Blocked: ${result.blockedTaskIds.length}`);
  }
  console.log(`  Status: ${result.success ? '✅ SUCCESS' : '❌ FAILED'}`);
  console.log(`${'='.repeat(60)}\n`);

  if (!result.success) {
    process.exit(1);
  }
}
