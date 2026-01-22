import { Command } from 'commander';
import { createFileStore } from '../../core/task-store/file-store.ts';
import { createRunnerEffects } from '../../core/runner/runner-effects-impl.ts';
import { PlannerSessionEffectsImpl } from '../../core/orchestrator/planner-session-effects-impl.ts';
import { isErr } from 'option-t/plain_result';
import { loadConfig } from '../utils/load-config.ts';
import { taskId } from '../../types/branded.ts';
import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * `agent info <id>` コマンドの実装
 *
 * IDを元にタスク、Run、PlannerSessionの情報を表示する。
 */
export function createInfoCommand(): Command {
  const infoCommand = new Command('info')
    .description('Show information about a task, run, or planner session by ID')
    .argument('<id>', 'Task ID, Run ID, or Planner Session ID')
    .option('--config <path>', 'Path to configuration file')
    .action(async (id: string, options) => {
      try {
        await showInfo({
          id,
          configPath: options.config,
        });
      } catch (error) {
        console.error('Info command failed:', error);
        process.exit(1);
      }
    });

  return infoCommand;
}

/**
 * info表示の実装
 */
async function showInfo(params: { id: string; configPath?: string }): Promise<void> {
  const { id, configPath } = params;

  // 設定ファイルを読み込み
  const config = await loadConfig(configPath);

  // 各種Effectsを初期化
  const taskStore = createFileStore({
    basePath: config.agentCoordPath,
  });
  const runnerEffects = createRunnerEffects({
    coordRepoPath: config.agentCoordPath,
  });
  const sessionEffects = new PlannerSessionEffectsImpl(config.agentCoordPath);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`Information for ID: ${id}`);
  console.log(`${'='.repeat(80)}\n`);

  // 1. Taskメタデータを試す
  const taskResult = await taskStore.readTask(taskId(id));
  if (!isErr(taskResult)) {
    const task = taskResult.val;
    console.log('📋 Task Information:');
    console.log(`  ID: ${task.id}`);
    console.log(`  State: ${task.state}`);
    console.log(`  Branch: ${task.branch}`);
    console.log(`  Acceptance: ${task.acceptance}`);
    console.log(`  Owner: ${task.owner ?? 'None'}`);
    console.log(`  Scope Paths: ${task.scopePaths.join(', ')}`);
    console.log(`  Created At: ${task.createdAt}`);
    console.log(`  Updated At: ${task.updatedAt}`);

    // メタデータファイルパス
    const taskMetadataPath = path.join(config.agentCoordPath, 'tasks', `${task.id}.json`);
    console.log(`\n📄 Metadata File:`);
    console.log(`  ${taskMetadataPath}`);

    // 関連するPlanner情報
    if (task.sessionId) {
      console.log(`\n🤖 Related Planner:`);
      console.log(`  Session ID: ${task.sessionId}`);
      if (task.plannerLogPath) {
        console.log(`  Planner Log: ${task.plannerLogPath}`);
      }
      if (task.plannerMetadataPath) {
        console.log(`  Planner Metadata: ${task.plannerMetadataPath}`);
      }
    }

    // 関連するCheck情報
    if (task.check) {
      console.log(`\n✅ Related Check:`);
      console.log(`  Check ID: ${task.check}`);
    }

    console.log(`\n${'='.repeat(80)}\n`);
    return;
  }

  // 2. Runメタデータを試す
  const runResult = await runnerEffects.loadRunMetadata(id);
  if (!isErr(runResult)) {
    const run = runResult.val;
    console.log('🚀 Run Information:');
    console.log(`  Run ID: ${run.id}`);
    console.log(`  Task ID: ${run.taskId}`);
    console.log(`  Status: ${run.status}`);
    console.log(`  Agent Type: ${run.agentType}`);
    console.log(`  Started At: ${run.startedAt}`);
    console.log(`  Finished At: ${run.finishedAt ?? 'In progress'}`);
    if (run.errorMessage) {
      console.log(`  Error: ${run.errorMessage}`);
    }

    // ログファイル
    console.log(`\n📝 Log File:`);
    console.log(`  ${run.logPath}`);
    const logExists = await fileExists(run.logPath);
    console.log(`  Exists: ${logExists ? 'Yes' : 'No'}`);

    // メタデータファイル
    const runMetadataPath = path.join(config.agentCoordPath, 'runs', `${run.id}.json`);
    console.log(`\n📄 Metadata File:`);
    console.log(`  ${runMetadataPath}`);

    // 関連するPlanner情報
    if (run.sessionId) {
      console.log(`\n🤖 Related Planner:`);
      console.log(`  Session ID: ${run.sessionId}`);
      if (run.plannerLogPath) {
        console.log(`  Planner Log: ${run.plannerLogPath}`);
      }
      if (run.plannerMetadataPath) {
        console.log(`  Planner Metadata: ${run.plannerMetadataPath}`);
      }
    }

    console.log(`\n${'='.repeat(80)}\n`);
    return;
  }

  // 3. PlannerSessionメタデータを試す
  const sessionResult = await sessionEffects.loadSession(id);
  if (!isErr(sessionResult)) {
    const session = sessionResult.val;
    console.log('🤖 Planner Session Information:');
    console.log(`  Session ID: ${session.sessionId}`);
    console.log(`  Instruction: ${session.instruction}`);
    console.log(`  Generated Tasks: ${session.generatedTasks.length}`);
    console.log(`  Conversation Messages: ${session.conversationHistory.length}`);
    console.log(`  Created At: ${session.createdAt}`);
    console.log(`  Updated At: ${session.updatedAt}`);

    // ログファイル
    if (session.plannerLogPath) {
      console.log(`\n📝 Log File:`);
      console.log(`  ${session.plannerLogPath}`);
      const logExists = await fileExists(session.plannerLogPath);
      console.log(`  Exists: ${logExists ? 'Yes' : 'No'}`);
    }

    // メタデータファイル
    const sessionMetadataPath = path.join(
      config.agentCoordPath,
      'planner-sessions',
      `${session.sessionId}.json`,
    );
    console.log(`\n📄 Metadata File:`);
    console.log(`  ${sessionMetadataPath}`);

    if (session.plannerMetadataPath) {
      console.log(`\n📊 Planner Run Metadata:`);
      console.log(`  ${session.plannerMetadataPath}`);
    }

    // 生成されたタスク一覧
    if (session.generatedTasks.length > 0) {
      console.log(`\n📋 Generated Tasks:`);
      for (const task of session.generatedTasks) {
        // TaskBreakdown型をanyで受け取っているので、動的にアクセス
        const taskData = task as any;
        console.log(`  - ${taskData.id}: ${taskData.acceptance}`);
      }
    }

    console.log(`\n${'='.repeat(80)}\n`);
    return;
  }

  // どのメタデータも見つからなかった
  console.log(`❌ No information found for ID: ${id}`);
  console.log(`\nPlease check:`);
  console.log(`  - Task IDs are stored in: ${config.agentCoordPath}/tasks/`);
  console.log(`  - Run IDs are stored in: ${config.agentCoordPath}/runs/`);
  console.log(`  - Planner Session IDs are stored in: ${config.agentCoordPath}/planner-sessions/`);
  console.log(`\n${'='.repeat(80)}\n`);
}

/**
 * ファイルが存在するか確認
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
