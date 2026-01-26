import { Command } from 'commander';
import { unwrapOk, isErr } from 'option-t/plain_result';
import { loadConfig } from '../utils/load-config.ts';
import { LeaderSessionEffectsImpl } from '../../core/orchestrator/leader-session-effects-impl.ts';
import { createFileStore } from '../../core/task-store/file-store.ts';
import { initializeLeaderSession } from '../../core/orchestrator/leader-operations.ts';
import path from 'node:path';

/**
 * `agent lead` コマンドの実装
 *
 * Leader セッションを管理する。
 */
export function createLeadCommand(): Command {
  const leadCommand = new Command('lead').description('Manage leader sessions');

  // サブコマンド: start
  leadCommand
    .command('start')
    .description('Start a new leader session from a plan file')
    .argument('<planFile>', 'Path to the plan file')
    .option('--config <path>', 'Path to configuration file')
    .option('--planner-session <id>', 'Associated planner session ID')
    .action(async (planFile: string, options) => {
      try {
        await startLeaderSession({
          planFile,
          configPath: options.config,
          plannerSessionId: options.plannerSession,
        });
      } catch (error) {
        console.error('Failed to start leader session:', error);
        process.exit(1);
      }
    });

  // サブコマンド: status
  leadCommand
    .command('status')
    .description('Show leader session status')
    .argument('[sessionId]', 'Session ID to show (defaults to latest)')
    .option('--config <path>', 'Path to configuration file')
    .action(async (sessionId: string | undefined, options) => {
      try {
        await showLeaderStatus({
          sessionId,
          configPath: options.config,
        });
      } catch (error) {
        console.error('Failed to show leader status:', error);
        process.exit(1);
      }
    });

  // サブコマンド: list
  leadCommand
    .command('list')
    .description('List all leader sessions')
    .option('--config <path>', 'Path to configuration file')
    .action(async (options) => {
      try {
        await listLeaderSessions({
          configPath: options.config,
        });
      } catch (error) {
        console.error('Failed to list leader sessions:', error);
        process.exit(1);
      }
    });

  return leadCommand;
}

/**
 * Leader セッションを開始
 */
async function startLeaderSession(params: {
  planFile: string;
  configPath?: string;
  plannerSessionId?: string;
}): Promise<void> {
  const { planFile, configPath, plannerSessionId } = params;

  // 設定ファイルを読み込み
  const config = await loadConfig(configPath);

  // 計画ファイルの絶対パスを解決
  const absolutePlanFile = path.isAbsolute(planFile) ? planFile : path.resolve(process.cwd(), planFile);

  // Effects を初期化
  const sessionEffects = new LeaderSessionEffectsImpl(config.agentCoordPath);
  const taskStore = createFileStore({ basePath: config.agentCoordPath });

  // Leader セッションを初期化
  const result = await initializeLeaderSession(
    {
      taskStore,
      runnerEffects: {} as any, // TODO: 実装時に適切な値を設定
      sessionEffects,
      coordRepoPath: config.agentCoordPath,
      agentType: 'claude', // TODO: 設定から取得
      model: 'claude-sonnet-4-5', // TODO: 設定から取得
    },
    absolutePlanFile,
    plannerSessionId,
  );

  if (isErr(result)) {
    throw new Error(`Failed to initialize leader session: ${result.err.message}`);
  }

  const session = unwrapOk(result);

  console.log(`\n${'='.repeat(80)}`);
  console.log('Leader Session Started');
  console.log(`${'='.repeat(80)}\n`);
  console.log(`Session ID: ${session.sessionId}`);
  console.log(`Plan File:  ${session.planFilePath}`);
  console.log(`Status:     ${session.status}`);
  console.log(`Created:    ${session.createdAt}`);
  console.log();
  console.log('Use `agent lead status <sessionId>` to check progress.');
  console.log(`\n${'='.repeat(80)}\n`);
}

/**
 * Leader セッション状態を表示
 */
async function showLeaderStatus(params: {
  sessionId?: string;
  configPath?: string;
}): Promise<void> {
  const { sessionId, configPath } = params;

  // 設定ファイルを読み込み
  const config = await loadConfig(configPath);

  // Effects を初期化
  const sessionEffects = new LeaderSessionEffectsImpl(config.agentCoordPath);

  // セッション ID が指定されていない場合は最新のセッションを取得
  let targetSessionId = sessionId;
  if (!targetSessionId) {
    const listResult = await sessionEffects.listSessions();
    if (isErr(listResult)) {
      throw new Error(`Failed to list sessions: ${listResult.err.message}`);
    }
    const sessions = unwrapOk(listResult);
    if (sessions.length === 0) {
      console.log('\nNo leader sessions found.\n');
      console.log('Use `agent lead start <planFile>` to create a new session.\n');
      return;
    }
    targetSessionId = sessions[0]!.sessionId;
  }

  // セッションを読み込み
  const loadResult = await sessionEffects.loadSession(targetSessionId);
  if (isErr(loadResult)) {
    throw new Error(`Failed to load session: ${loadResult.err.message}`);
  }

  const session = unwrapOk(loadResult);

  // セッション情報を表示
  console.log(`\n${'='.repeat(80)}`);
  console.log('Leader Session Status');
  console.log(`${'='.repeat(80)}\n`);
  console.log(`Session ID:  ${session.sessionId}`);
  console.log(`Plan File:   ${session.planFilePath}`);
  console.log(`Status:      ${getStatusIcon(session.status)} ${session.status}`);
  console.log(`Created:     ${session.createdAt}`);
  console.log(`Updated:     ${session.updatedAt}`);
  console.log();

  // 進捗情報
  console.log('Progress:');
  const percentage =
    session.totalTaskCount > 0
      ? Math.round((session.completedTaskCount / session.totalTaskCount) * 100)
      : 0;
  console.log(
    `  Tasks: ${session.completedTaskCount}/${session.totalTaskCount} (${percentage}%)`,
  );
  console.log(`  Active: ${session.activeTaskIds.length} tasks`);
  console.log();

  // エスカレーション情報
  if (session.escalationRecords.length > 0) {
    console.log('Escalations:');
    const unresolvedCount = session.escalationRecords.filter((r) => !r.resolved).length;
    console.log(`  Total: ${session.escalationRecords.length}`);
    console.log(`  Unresolved: ${unresolvedCount}`);
    console.log();
  }

  // エスカレーション試行回数
  console.log('Escalation Attempts:');
  console.log(`  User:            ${session.escalationAttempts.user}`);
  console.log(`  Planner:         ${session.escalationAttempts.planner}`);
  console.log(`  Logic Validator: ${session.escalationAttempts.logicValidator}`);
  console.log(`  External Advisor:${session.escalationAttempts.externalAdvisor}`);
  console.log();

  // メンバータスク履歴
  if (session.memberTaskHistory.length > 0) {
    console.log('Recent Member Task History:');
    const recentTasks = session.memberTaskHistory.slice(-5);
    for (const history of recentTasks) {
      const statusText = history.completedAt ? '✓ Completed' : '⏳ In Progress';
      console.log(`  - Task ${history.taskId}: ${statusText}`);
      if (history.leaderDecision) {
        console.log(`    Leader Decision: ${history.leaderDecision.decision}`);
      }
    }
    console.log();
  }

  console.log(`${'='.repeat(80)}\n`);
}

/**
 * Leader セッション一覧を表示
 */
async function listLeaderSessions(params: { configPath?: string }): Promise<void> {
  const { configPath } = params;

  // 設定ファイルを読み込み
  const config = await loadConfig(configPath);

  // Effects を初期化
  const sessionEffects = new LeaderSessionEffectsImpl(config.agentCoordPath);

  // セッション一覧を取得
  const listResult = await sessionEffects.listSessions();
  if (isErr(listResult)) {
    throw new Error(`Failed to list sessions: ${listResult.err.message}`);
  }

  const sessions = unwrapOk(listResult);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`Leader Sessions (${sessions.length} sessions)`);
  console.log(`${'='.repeat(80)}\n`);

  if (sessions.length === 0) {
    console.log('  No leader sessions found.');
    console.log();
    console.log('  Use `agent lead start <planFile>` to create a new session.');
    console.log(`\n${'='.repeat(80)}\n`);
    return;
  }

  // ヘッダー
  console.log(
    `${'Session ID'.padEnd(38)} ${'Status'.padEnd(15)} ${'Progress'.padEnd(12)} ${'Created'.padEnd(20)}`,
  );
  console.log('-'.repeat(80));

  // セッション一覧
  for (const session of sessions) {
    const statusIcon = getStatusIcon(session.status);
    const statusText = `${statusIcon} ${session.status}`;
    const percentage =
      session.totalTaskCount > 0
        ? Math.round((session.completedTaskCount / session.totalTaskCount) * 100)
        : 0;
    const progressText = `${session.completedTaskCount}/${session.totalTaskCount} (${percentage}%)`;
    const createdDate = new Date(session.createdAt).toLocaleString();

    console.log(
      `${session.sessionId.padEnd(38)} ${statusText.padEnd(15)} ${progressText.padEnd(12)} ${createdDate}`,
    );
  }

  console.log(`\n${'='.repeat(80)}\n`);
}

/**
 * セッション状態に対応するアイコンを取得
 */
function getStatusIcon(status: string): string {
  switch (status) {
    case 'planning':
      return '📋';
    case 'executing':
      return '⚙️';
    case 'reviewing':
      return '🔍';
    case 'escalating':
      return '⚠️';
    case 'completed':
      return '✅';
    case 'failed':
      return '❌';
    default:
      return '❓';
  }
}
