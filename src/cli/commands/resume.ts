import { Command } from 'commander';
import { loadConfig } from '../utils/load-config.ts';
import { createFileStore } from '../../core/task-store/file-store.ts';
import { createOrchestrator } from '../../core/orchestrator/orchestrate.ts';
import { createGitEffects } from '../../adapters/vcs/index.ts';
import { createRunnerEffects } from '../../core/runner/runner-effects-impl.ts';
import { PlannerSessionEffectsImpl } from '../../core/orchestrator/planner-session-effects-impl.ts';
import { taskId } from '../../types/branded.ts';
import { TaskState } from '../../types/task.ts';
import { promptFailedTaskHandling } from '../utils/prompt.ts';

/**
 * resume コマンドを作成
 */
export const createResumeCommand = (): Command => {
  const command = new Command('resume');

  command
    .description('Resume from a previous planner session')
    .option('--list', 'List all available sessions')
    .option('--session <id>', 'Session ID to resume from')
    .option('--retry-all', 'Retry all failed tasks')
    .option('--continue-all', 'Continue all failed tasks from existing state')
    .option('--skip-failed', 'Skip all failed tasks')
    .option('--config <path>', 'Path to configuration file')
    .action(async (options: {
      list?: boolean;
      session?: string;
      retryAll?: boolean;
      continueAll?: boolean;
      skipFailed?: boolean;
      config?: string;
    }) => {
      try {
        // 1. 設定ファイルを読み込み
        const config = await loadConfig(options.config);

        // 2. 依存関係を初期化
        const sessionEffects = new PlannerSessionEffectsImpl(config.agentCoordPath);

        // 3. --listオプション: セッション一覧を表示
        if (options.list) {
          const sessionsResult = await sessionEffects.listSessions();
          if (!sessionsResult.ok) {
            console.error(`❌ Failed to list sessions: ${sessionsResult.err.message}`);
            process.exit(1);
          }

          const sessions = sessionsResult.val;
          if (sessions.length === 0) {
            console.log('No sessions found.');
            return;
          }

          console.log('\n📋 Available Sessions:\n');
          for (const session of sessions) {
            console.log(`  ID: ${session.sessionId}`);
            console.log(`  Instruction: ${session.instruction}`);
            console.log(`  Created: ${new Date(session.createdAt).toLocaleString()}`);
            console.log(`  Tasks: ${session.taskCount}`);
            console.log('');
          }
          return;
        }

        // 4. --sessionオプション: セッションから再開
        if (!options.session) {
          console.error('❌ Please specify --session <id> or use --list to see available sessions');
          process.exit(1);
        }

        const sessionId = options.session;

        // 5. セッションを読み込み
        console.log(`📂 Loading session: ${sessionId}`);
        const sessionResult = await sessionEffects.loadSession(sessionId);
        if (!sessionResult.ok) {
          console.error(`❌ Failed to load session: ${sessionResult.err.message}`);
          process.exit(1);
        }

        const session = sessionResult.val;
        console.log(`📋 Session instruction: ${session.instruction}`);
        console.log(`📋 Tasks in session: ${session.generatedTasks.length}\n`);

        // 6. タスクストアを初期化
        const taskStore = createFileStore({
          basePath: config.agentCoordPath,
        });

        // 7. タスクの状態を確認
        console.log('🔍 Checking task states...\n');
        const taskIds: string[] = session.generatedTasks.map((t: { id: string }) => t.id);
        const failedTasks: Array<{ id: string; description: string }> = [];

        for (const rawTaskId of taskIds) {
          const taskResult = await taskStore.readTask(taskId(rawTaskId));
          if (!taskResult.ok) {
            console.warn(`⚠️  Failed to load task ${rawTaskId}`);
            continue;
          }

          const task = taskResult.val;
          if (task.state === TaskState.BLOCKED || task.state === TaskState.CANCELLED) {
            failedTasks.push({
              id: String(task.id),
              description: task.acceptance || task.branch,
            });
          } else if (task.state === TaskState.DONE) {
            console.log(`  ✅ ${task.id}: Completed`);
          } else if (task.state === TaskState.READY) {
            console.log(`  📋 ${task.id}: Ready`);
          } else if (task.state === TaskState.RUNNING) {
            console.log(`  🔄 ${task.id}: Running`);
          }
        }

        // 8. 失敗タスクの処理方法を決定
        const failedTaskHandling = new Map<string, 'retry' | 'continue' | 'skip'>();

        if (failedTasks.length > 0) {
          console.log(`\n⚠️  Found ${failedTasks.length} failed/cancelled tasks\n`);

          // 全タスクに対する一括処理オプション
          if (options.retryAll) {
            for (const task of failedTasks) {
              failedTaskHandling.set(task.id, 'retry');
              console.log(`  🔄 ${task.id}: Will retry`);
            }
          } else if (options.continueAll) {
            for (const task of failedTasks) {
              failedTaskHandling.set(task.id, 'continue');
              console.log(`  ➡️  ${task.id}: Will continue`);
            }
          } else if (options.skipFailed) {
            for (const task of failedTasks) {
              failedTaskHandling.set(task.id, 'skip');
              console.log(`  ⏭️  ${task.id}: Will skip`);
            }
          } else {
            // インタラクティブに確認
            for (const task of failedTasks) {
              const handling = await promptFailedTaskHandling(task.id, task.description);
              failedTaskHandling.set(task.id, handling);
            }
          }
        }

        // 9. Orchestratorを初期化
        const gitEffects = createGitEffects();
        const runnerEffects = createRunnerEffects({
          coordRepoPath: config.agentCoordPath,
        });

        const orchestrator = createOrchestrator({
          taskStore,
          gitEffects,
          runnerEffects,
          sessionEffects,
          config,
        });

        // 10. セッションから再開
        console.log('\n🚀 Resuming session...\n');
        const result = await orchestrator.resumeFromSession(sessionId, failedTaskHandling);

        if (!result.ok) {
          console.error(`\n❌ Session resumption failed: ${result.err.message}`);
          process.exit(1);
        }

        if (!result.val.success) {
          console.log('\n⚠️  Session resumption completed with errors');
          process.exit(1);
        }

        console.log('\n✅ Session resumption completed successfully');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`❌ Unexpected error: ${errorMessage}`);
        if (error instanceof Error && error.stack) {
          console.error(error.stack);
        }
        process.exit(1);
      }
    });

  return command;
};
