import { Command } from 'commander';
import { unwrapOk, isErr } from 'option-t/plain_result';
import { loadConfig } from '../utils/load-config.ts';
import { LeaderSessionEffectsImpl } from '../../core/orchestrator/leader-session-effects-impl.ts';
import { createFileStore } from '../../core/task-store/file-store.ts';
import { initializeLeaderSession } from '../../core/orchestrator/leader-operations.ts';
import {
  getPendingEscalations,
  getEscalationHistory,
} from '../../core/orchestrator/leader-escalation.ts';
import path from 'node:path';
import * as readline from 'node:readline';

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

  // サブコマンド: escalations
  leadCommand
    .command('escalations')
    .description('Show escalation history for a session')
    .argument('[sessionId]', 'Session ID to show (defaults to latest)')
    .option('--config <path>', 'Path to configuration file')
    .option('--all', 'Show all escalations including resolved ones')
    .action(async (sessionId: string | undefined, options) => {
      try {
        await showEscalations({
          sessionId,
          configPath: options.config,
          showAll: options.all ?? false,
        });
      } catch (error) {
        console.error('Failed to show escalations:', error);
        process.exit(1);
      }
    });

  // サブコマンド: resolve
  leadCommand
    .command('resolve')
    .description('Resolve a pending escalation')
    .argument('<sessionId>', 'Session ID')
    .option('--config <path>', 'Path to configuration file')
    .option('--escalation-id <id>', 'Specific escalation ID to resolve')
    .option('--resolution <text>', 'Resolution text (prompts interactively if not provided)')
    .action(async (sessionId: string, options) => {
      try {
        await resolveEscalation({
          sessionId,
          configPath: options.config,
          escalationId: options.escalationId,
          resolution: options.resolution,
        });
      } catch (error) {
        console.error('Failed to resolve escalation:', error);
        process.exit(1);
      }
    });

  // サブコマンド: resume
  leadCommand
    .command('resume')
    .description('Resume a paused session after escalation resolution')
    .argument('<sessionId>', 'Session ID to resume')
    .option('--config <path>', 'Path to configuration file')
    .action(async (sessionId: string, options) => {
      try {
        await resumeSession({
          sessionId,
          configPath: options.config,
        });
      } catch (error) {
        console.error('Failed to resume session:', error);
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
  // NOTE: Phase 1 では initializeLeaderSession のみ使用するため、
  // workerOps/judgeOps/baseBranchResolver はプレースホルダー
  const result = await initializeLeaderSession(
    {
      taskStore,
      runnerEffects: {} as any, // TODO: Phase 2 Task 2+ で実装
      sessionEffects,
      coordRepoPath: config.agentCoordPath,
      agentType: 'claude', // TODO: 設定から取得
      model: 'claude-sonnet-4-5', // TODO: 設定から取得
      gitEffects: {} as any, // TODO: Phase 2 Task 2+ で実装
      config: {} as any, // TODO: Phase 2 Task 2+ で実装
      workerOps: {} as any, // TODO: Phase 2 Task 2+ で実装
      judgeOps: {} as any, // TODO: Phase 2 Task 2+ で実装
      baseBranchResolver: {} as any, // TODO: Phase 2 Task 2+ で実装
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
 * エスカレーション一覧を表示
 */
async function showEscalations(params: {
  sessionId?: string;
  configPath?: string;
  showAll: boolean;
}): Promise<void> {
  const { sessionId, configPath, showAll } = params;

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

  // エスカレーション一覧を取得
  const escalations = showAll
    ? getEscalationHistory(session)
    : getPendingEscalations(session);

  console.log(`\n${'='.repeat(80)}`);
  console.log(
    `Escalations for Session ${session.sessionId} (${showAll ? 'all' : 'pending only'})`,
  );
  console.log(`${'='.repeat(80)}\n`);

  if (escalations.length === 0) {
    console.log('  No escalations found.');
    console.log(`\n${'='.repeat(80)}\n`);
    return;
  }

  for (const escalation of escalations) {
    const resolvedIcon = escalation.resolved ? '✅' : '⏳';
    console.log(`${resolvedIcon} Escalation ID: ${escalation.id}`);
    console.log(`   Target:     ${escalation.target}`);
    console.log(`   Reason:     ${escalation.reason}`);
    if (escalation.relatedTaskId) {
      console.log(`   Task:       ${escalation.relatedTaskId}`);
    }
    console.log(`   Created:    ${new Date(escalation.escalatedAt).toLocaleString()}`);
    if (escalation.resolved && escalation.resolvedAt) {
      console.log(`   Resolved:   ${new Date(escalation.resolvedAt).toLocaleString()}`);
      if (escalation.resolution) {
        console.log(`   Resolution: ${escalation.resolution}`);
      }
    }
    console.log();
  }

  const pendingCount = getPendingEscalations(session).length;
  if (pendingCount > 0) {
    console.log(`💡 ${pendingCount} pending escalation(s) require resolution.`);
    console.log(`   Run 'agent lead resolve ${session.sessionId}' to resolve.`);
  }

  console.log(`${'='.repeat(80)}\n`);
}

/**
 * エスカレーションを解決
 */
async function resolveEscalation(params: {
  sessionId: string;
  configPath?: string;
  escalationId?: string;
  resolution?: string;
}): Promise<void> {
  const { sessionId, configPath, escalationId, resolution } = params;

  // 設定ファイルを読み込み
  const config = await loadConfig(configPath);

  // Effects を初期化
  const sessionEffects = new LeaderSessionEffectsImpl(config.agentCoordPath);

  // セッションを読み込み
  const loadResult = await sessionEffects.loadSession(sessionId);
  if (isErr(loadResult)) {
    throw new Error(`Failed to load session: ${loadResult.err.message}`);
  }

  let session = unwrapOk(loadResult);
  const pendingEscalations = getPendingEscalations(session);

  if (pendingEscalations.length === 0) {
    console.log('\n✅ No pending escalations to resolve.\n');
    return;
  }

  // 解決するエスカレーションを特定
  let targetEscalation = pendingEscalations[0]!;
  if (escalationId) {
    const found = pendingEscalations.find((e) => e.id === escalationId);
    if (!found) {
      throw new Error(`Escalation ${escalationId} not found or already resolved`);
    }
    targetEscalation = found;
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log('Resolve Escalation');
  console.log(`${'='.repeat(80)}\n`);

  console.log(`⏳ Escalation ID: ${targetEscalation.id}`);
  console.log(`   Target:     ${targetEscalation.target}`);
  console.log(`   Reason:     ${targetEscalation.reason}`);
  if (targetEscalation.relatedTaskId) {
    console.log(`   Task:       ${targetEscalation.relatedTaskId}`);
  }
  console.log();

  // 解決内容を取得（引数で指定されていなければインタラクティブに入力）
  let resolutionText = resolution;
  if (!resolutionText) {
    resolutionText = await promptForResolution();
  }

  if (!resolutionText || resolutionText.trim() === '') {
    console.log('\n❌ Resolution cannot be empty. Aborting.\n');
    return;
  }

  // エスカレーションを解決済みに更新
  const now = new Date().toISOString();
  const updatedEscalations = session.escalationRecords.map((e) =>
    e.id === targetEscalation.id
      ? {
          ...e,
          resolved: true,
          resolvedAt: now,
          resolution: resolutionText,
        }
      : e,
  );

  // 未解決エスカレーションがなくなった場合、状態を REVIEWING に変更
  const remainingPending = updatedEscalations.filter((e) => !e.resolved);
  const newStatus =
    remainingPending.length === 0 && session.status === 'escalating'
      ? ('reviewing' as const)
      : session.status;

  session = {
    ...session,
    escalationRecords: updatedEscalations,
    status: newStatus,
    updatedAt: now,
  };

  // セッションを保存
  const saveResult = await sessionEffects.saveSession(session);
  if (isErr(saveResult)) {
    throw new Error(`Failed to save session: ${saveResult.err.message}`);
  }

  console.log(`✅ Escalation resolved successfully.`);
  console.log(`   Resolution: ${resolutionText}`);
  console.log();

  if (remainingPending.length > 0) {
    console.log(`⚠️  ${remainingPending.length} escalation(s) still pending.`);
    console.log(`   Run 'agent lead escalations ${sessionId}' to see them.`);
  } else {
    console.log(`✅ All escalations resolved.`);
    console.log(`   Run 'agent lead resume ${sessionId}' to continue execution.`);
  }

  console.log(`\n${'='.repeat(80)}\n`);
}

/**
 * インタラクティブに解決内容を入力
 */
async function promptForResolution(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    console.log('Enter your resolution (press Enter when done):');
    rl.question('> ', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * セッションを再開
 */
async function resumeSession(params: {
  sessionId: string;
  configPath?: string;
}): Promise<void> {
  const { sessionId, configPath } = params;

  // 設定ファイルを読み込み
  const config = await loadConfig(configPath);

  // Effects を初期化
  const sessionEffects = new LeaderSessionEffectsImpl(config.agentCoordPath);

  // セッションを読み込み
  const loadResult = await sessionEffects.loadSession(sessionId);
  if (isErr(loadResult)) {
    throw new Error(`Failed to load session: ${loadResult.err.message}`);
  }

  let session = unwrapOk(loadResult);

  // 未解決エスカレーションがあるかチェック
  const pendingEscalations = getPendingEscalations(session);
  if (pendingEscalations.length > 0) {
    console.log('\n⚠️  Cannot resume: there are pending escalations.');
    console.log(`   Run 'agent lead resolve ${sessionId}' to resolve them first.`);
    console.log();
    for (const escalation of pendingEscalations) {
      console.log(`   - ${escalation.id}: ${escalation.reason.substring(0, 50)}...`);
    }
    console.log();
    return;
  }

  // セッション状態をチェック
  if (session.status === 'completed') {
    console.log('\n✅ Session is already completed. Nothing to resume.\n');
    return;
  }

  if (session.status === 'failed') {
    console.log('\n❌ Session has failed. Cannot resume.\n');
    return;
  }

  if (session.status === 'executing') {
    console.log('\n⚙️  Session is already executing.\n');
    return;
  }

  // セッション状態を EXECUTING に更新
  const now = new Date().toISOString();
  session = {
    ...session,
    status: 'executing' as const,
    updatedAt: now,
  };

  const saveResult = await sessionEffects.saveSession(session);
  if (isErr(saveResult)) {
    throw new Error(`Failed to save session: ${saveResult.err.message}`);
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log('Session Resumed');
  console.log(`${'='.repeat(80)}\n`);
  console.log(`Session ID: ${session.sessionId}`);
  console.log(`Status:     ⚙️  executing`);
  console.log(`Progress:   ${session.completedTaskCount}/${session.totalTaskCount} tasks`);
  console.log();
  console.log('💡 The session is now ready for execution.');
  console.log('   Run `agent run --leader-session <sessionId>` to continue task execution.');
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
