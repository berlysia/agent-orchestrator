import { Command } from 'commander';
import { createFileStore } from '../../core/task-store/file-store.ts';
import { createRunnerEffects } from '../../core/runner/runner-effects-impl.ts';
import { createGitEffects } from '../../adapters/vcs/index.ts';
import { createOrchestrator } from '../../core/orchestrator/orchestrate.ts';
import { PlannerSessionEffectsImpl } from '../../core/orchestrator/planner-session-effects-impl.ts';
import { isErr } from 'option-t/plain_result';
import { loadConfig } from '../utils/load-config.ts';
import type { TaskStoreError } from '../../types/errors.ts';

/**
 * `agent continue` コマンドの実装
 *
 * 失敗/未完了のオーケストレーションから追加タスクを自動生成・実行する。
 */
export function createContinueCommand(): Command {
  const continueCommand = new Command('continue')
    .description('Continue from incomplete orchestration by generating additional tasks')
    .option('--session <id>', 'Session ID to continue from (default: most recent)')
    .option(
      '--max-iterations <n>',
      'Maximum iteration limit (overrides config.iterations.orchestrateMainLoop)',
    )
    .option('--auto', 'Skip confirmation prompts', false)
    .option('--dry-run', 'Show what would be done without executing', false)
    .option('--config <path>', 'Path to configuration file')
    .action(async (options) => {
      try {
        await executeContinue({
          sessionId: options.session,
          maxIterations: options.maxIterations ? parseInt(options.maxIterations, 10) : undefined,
          autoConfirm: options.auto,
          dryRun: options.dryRun,
          configPath: options.config,
        });
      } catch (error) {
        console.error('Continue execution failed:', error);
        process.exit(1);
      }
    });

  return continueCommand;
}

/**
 * agent continue の実行処理
 */
async function executeContinue(params: {
  sessionId?: string;
  maxIterations?: number;
  autoConfirm: boolean;
  dryRun: boolean;
  configPath?: string;
}): Promise<void> {
  const { sessionId, autoConfirm, dryRun, configPath } = params;

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

  // セッションIDが指定されていない場合、最新のセッションを取得
  let targetSessionId = sessionId;
  if (!targetSessionId) {
    console.log('🔍 Finding most recent session...');
    const sessionsResult = await sessionEffects.listSessions();

    if (isErr(sessionsResult)) {
      const error = sessionsResult.err as TaskStoreError;
      console.error(`❌ Failed to list sessions: ${error.message}`);
      process.exit(1);
    }

    const sessions = sessionsResult.val;
    if (sessions.length === 0) {
      console.error('❌ No sessions found. Run `agent run` first to create a session.');
      process.exit(1);
    }

    const latestSession = sessions[0];
    if (!latestSession) {
      console.error('❌ Failed to retrieve latest session');
      process.exit(1);
    }

    targetSessionId = latestSession.sessionId;
    console.log(`   Found session: ${targetSessionId}`);
    console.log(`   Instruction: ${latestSession.instruction}`);
    console.log(`   Created: ${latestSession.createdAt}\n`);
  }

  // Orchestratorを初期化
  const orchestrator = createOrchestrator({
    taskStore,
    runnerEffects,
    gitEffects,
    sessionEffects,
    config,
    maxWorkers: config.maxWorkers,
  });

  // セッションIDの最終確認
  if (!targetSessionId) {
    console.error('❌ No session ID available');
    process.exit(1);
  }

  // 継続実行
  console.log(`🚀 Starting continue from session...\n`);

  // maxIterationsはCLIオプション優先、なければconfigから取得
  const maxIterations = params.maxIterations ?? config.iterations.orchestrateMainLoop;

  const resultOrError = await orchestrator.continueFromSession(targetSessionId, {
    maxIterations,
    autoConfirm,
    dryRun,
  });

  // Result型をunwrap
  if (isErr(resultOrError)) {
    console.error(`\n❌ Continue error: ${resultOrError.err.message}`);
    process.exit(1);
  }

  const result = resultOrError.val;

  // 結果を表示
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Continue Summary:`);
  console.log(`  Iterations performed: ${result.iterationsPerformed}`);
  console.log(`  Total tasks: ${result.allTaskIds.length}`);
  console.log(`  Completed: ${result.completedTaskIds.length}`);
  console.log(`  Failed: ${result.failedTaskIds.length}`);
  console.log(`  Completion score: ${result.completionScore ?? 'N/A'}%`);
  console.log(`  Status: ${result.isComplete ? '✅ COMPLETE' : '⚠️  INCOMPLETE'}`);

  if (!result.isComplete && result.remainingMissingAspects.length > 0) {
    console.log(`\n  Remaining missing aspects:`);
    result.remainingMissingAspects.forEach((aspect, idx) => {
      console.log(`    ${idx + 1}. ${aspect}`);
    });
  }

  console.log(`${'='.repeat(60)}\n`);

  if (!result.isComplete) {
    console.log(
      '💡 Tip: Run `agent continue` again to generate more tasks, or manually review the missing aspects.',
    );
    process.exit(1);
  }
}
