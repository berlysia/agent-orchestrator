/**
 * `agent explore` コマンドの実装
 *
 * ADR-025: 自律探索モード
 *
 * コードベースを自律的に探索し、改善点を発見・提案する。
 */

import { Command } from 'commander';
import { loadConfig } from '../utils/load-config.ts';
import { createFileStore } from '../../core/task-store/file-store.ts';
import { createRunnerEffects } from '../../core/runner/runner-effects-impl.ts';
import { createExplorationSessionEffects } from '../../core/orchestrator/exploration-session-effects.ts';
import {
  initializeExplorationSession,
  runExploration,
  approveCandidates,
  executeApprovedTasks,
  type ExplorationDeps,
} from '../../core/orchestrator/exploration-operations.ts';
import {
  ExplorationFocus,
  type ExplorationFocus as ExplorationFocusType,
  type ExplorationSession,
  getFindingsSummary,
  filterFindings,
} from '../../types/exploration-session.ts';
import { isErr } from 'option-t/plain_result';

/**
 * `agent explore` コマンドを作成
 */
export function createExploreCommand(): Command {
  const exploreCommand = new Command('explore')
    .description('Autonomously explore codebase and suggest improvements');

  // メインの探索コマンド
  exploreCommand
    .argument('[scope...]', 'Directories to explore (default: entire repo)')
    .option(
      '--focus <areas>',
      'Focus areas (comma-separated: security,code-quality,performance,maintainability,architecture,documentation,test-coverage)',
    )
    .option('--config <path>', 'Path to configuration file')
    .action(async (scope: string[], options) => {
      await executeExplore(scope, options);
    });

  // ステータス表示
  exploreCommand
    .command('status [sessionId]')
    .description('Show exploration session status')
    .option('--config <path>', 'Path to configuration file')
    .action(async (sessionId: string | undefined, options) => {
      await showStatus(sessionId, options);
    });

  // 発見事項一覧
  exploreCommand
    .command('findings [sessionId]')
    .description('List findings from exploration')
    .option('--severity <levels>', 'Filter by severity (comma-separated: low,medium,high,critical)')
    .option('--category <areas>', 'Filter by category')
    .option('--config <path>', 'Path to configuration file')
    .action(async (sessionId: string | undefined, options) => {
      await showFindings(sessionId, options);
    });

  // タスク候補承認
  exploreCommand
    .command('approve <candidateIds...>')
    .description('Approve task candidates for execution')
    .option('--session <sessionId>', 'Session ID')
    .option('--all', 'Approve all candidates', false)
    .option('--config <path>', 'Path to configuration file')
    .action(async (candidateIds: string[], options) => {
      await approveCommand(candidateIds, options);
    });

  // 承認済みタスク実行
  exploreCommand
    .command('execute [sessionId]')
    .description('Execute approved task candidates')
    .option('--config <path>', 'Path to configuration file')
    .action(async (sessionId: string | undefined, options) => {
      await executeCommand(sessionId, options);
    });

  // セッション一覧
  exploreCommand
    .command('list')
    .description('List exploration sessions')
    .option('--config <path>', 'Path to configuration file')
    .action(async (options) => {
      await listSessions(options);
    });

  return exploreCommand;
}

/**
 * 依存関係を構築
 */
async function buildDeps(configPath?: string): Promise<ExplorationDeps> {
  const config = await loadConfig(configPath);

  const taskStore = createFileStore({ basePath: config.agentCoordPath });
  const runnerEffects = createRunnerEffects({
    coordRepoPath: config.agentCoordPath,
    timeout: 600000,
  });
  const sessionEffects = createExplorationSessionEffects(config.agentCoordPath);

  return {
    taskStore,
    runnerEffects,
    sessionEffects,
    appRepoPath: config.appRepoPath,
    coordRepoPath: config.agentCoordPath,
    agentType: config.agents.planner.type,
    model: config.agents.planner.model,
  };
}

/**
 * 探索を実行
 */
async function executeExplore(
  scope: string[],
  options: { focus?: string; config?: string },
): Promise<void> {
  const deps = await buildDeps(options.config);

  // フォーカスエリアをパース
  const focus: ExplorationFocusType[] = options.focus
    ? (options.focus.split(',').filter((f) =>
        Object.values(ExplorationFocus).includes(f as ExplorationFocusType)
      ) as ExplorationFocusType[])
    : Object.values(ExplorationFocus);

  // スコープが空の場合はリポジトリ全体
  const targetScope = scope.length > 0 ? scope : ['.'];

  console.log('\nStarting code exploration...');
  console.log(`  Focus: ${focus.join(', ')}`);
  console.log(`  Scope: ${targetScope.join(', ')}\n`);

  // セッションを初期化
  const initResult = await initializeExplorationSession(deps, focus, targetScope);
  if (isErr(initResult)) {
    console.error(`Failed to initialize session: ${initResult.err.message}`);
    process.exit(1);
  }

  const session = initResult.val;
  console.log(`Session created: ${session.sessionId}\n`);

  // 探索を実行
  console.log('Exploring codebase...\n');
  const exploreResult = await runExploration(deps, session);
  if (isErr(exploreResult)) {
    console.error(`Exploration failed: ${exploreResult.err.message}`);
    process.exit(1);
  }

  const updatedSession = exploreResult.val;

  // 結果を表示
  displaySessionSummary(updatedSession);
}

/**
 * ステータスを表示
 */
async function showStatus(
  sessionId: string | undefined,
  options: { config?: string },
): Promise<void> {
  const deps = await buildDeps(options.config);

  let session: ExplorationSession | null;

  if (sessionId) {
    const loadResult = await deps.sessionEffects.load(sessionId);
    if (isErr(loadResult)) {
      console.error(`Session not found: ${sessionId}`);
      process.exit(1);
    }
    session = loadResult.val;
  } else {
    const latestResult = await deps.sessionEffects.getLatest();
    if (isErr(latestResult)) {
      console.error(`Failed to get latest session: ${latestResult.err.message}`);
      process.exit(1);
    }
    session = latestResult.val;
  }

  if (!session) {
    console.log('No exploration sessions found.');
    console.log('Run `agent explore` to start a new exploration.');
    return;
  }

  displaySessionSummary(session);
}

/**
 * 発見事項を表示
 */
async function showFindings(
  sessionId: string | undefined,
  options: { severity?: string; category?: string; config?: string },
): Promise<void> {
  const deps = await buildDeps(options.config);

  let session: ExplorationSession | null;

  if (sessionId) {
    const loadResult = await deps.sessionEffects.load(sessionId);
    if (isErr(loadResult)) {
      console.error(`Session not found: ${sessionId}`);
      process.exit(1);
    }
    session = loadResult.val;
  } else {
    const latestResult = await deps.sessionEffects.getLatest();
    if (isErr(latestResult)) {
      console.error(`Failed to get latest session: ${latestResult.err.message}`);
      process.exit(1);
    }
    session = latestResult.val;
  }

  if (!session) {
    console.log('No exploration sessions found.');
    return;
  }

  // フィルタリング
  const severityFilter = options.severity?.split(',');
  const categoryFilter = options.category?.split(',');

  const findings = filterFindings(session.findings, {
    severity: severityFilter as ('low' | 'medium' | 'high' | 'critical')[] | undefined,
    category: categoryFilter as ExplorationFocusType[] | undefined,
  });

  console.log(`\nFindings (${findings.length}):\n`);

  for (const finding of findings) {
    const severityIcon = getSeverityIcon(finding.severity);
    console.log(`${severityIcon} [${finding.category}] ${finding.title}`);
    console.log(`   Location: ${finding.location.file}:${finding.location.line ?? '?'}`);
    console.log(`   ${finding.description}`);
    console.log(`   Recommendation: ${finding.recommendation}`);
    console.log(`   Actionable: ${finding.actionable ? 'yes' : 'no'}`);
    console.log('');
  }
}

/**
 * 候補を承認
 */
async function approveCommand(
  candidateIds: string[],
  options: { session?: string; all?: boolean; config?: string },
): Promise<void> {
  const deps = await buildDeps(options.config);

  let session: ExplorationSession | null;

  if (options.session) {
    const loadResult = await deps.sessionEffects.load(options.session);
    if (isErr(loadResult)) {
      console.error(`Session not found: ${options.session}`);
      process.exit(1);
    }
    session = loadResult.val;
  } else {
    const latestResult = await deps.sessionEffects.getLatest();
    if (isErr(latestResult)) {
      console.error(`Failed to get latest session: ${latestResult.err.message}`);
      process.exit(1);
    }
    session = latestResult.val;
  }

  if (!session) {
    console.log('No exploration sessions found.');
    return;
  }

  // 全承認
  const idsToApprove = options.all
    ? session.taskCandidates.map((c) => c.id)
    : candidateIds;

  const result = await approveCandidates(deps, session, idsToApprove);
  if (isErr(result)) {
    console.error(`Failed to approve candidates: ${result.err.message}`);
    process.exit(1);
  }

  console.log(`Approved ${idsToApprove.length} candidate(s).`);
  console.log('Run `agent explore execute` to execute approved tasks.');
}

/**
 * 承認済みタスクを実行
 */
async function executeCommand(
  sessionId: string | undefined,
  options: { config?: string },
): Promise<void> {
  const deps = await buildDeps(options.config);

  let session: ExplorationSession | null;

  if (sessionId) {
    const loadResult = await deps.sessionEffects.load(sessionId);
    if (isErr(loadResult)) {
      console.error(`Session not found: ${sessionId}`);
      process.exit(1);
    }
    session = loadResult.val;
  } else {
    const latestResult = await deps.sessionEffects.getLatest();
    if (isErr(latestResult)) {
      console.error(`Failed to get latest session: ${latestResult.err.message}`);
      process.exit(1);
    }
    session = latestResult.val;
  }

  if (!session) {
    console.log('No exploration sessions found.');
    return;
  }

  const approvedCount = session.taskCandidates.filter((c) => c.approved).length;
  if (approvedCount === 0) {
    console.log('No approved candidates to execute.');
    console.log('Run `agent explore approve --all` to approve candidates first.');
    return;
  }

  console.log(`Executing ${approvedCount} approved task(s)...\n`);

  const result = await executeApprovedTasks(deps, session);
  if (isErr(result)) {
    console.error(`Failed to execute tasks: ${result.err.message}`);
    process.exit(1);
  }

  console.log(`Created ${result.val.executedTaskIds.length} task(s).`);
  console.log('Run `agent status` to check task progress.');
}

/**
 * セッション一覧を表示
 */
async function listSessions(options: { config?: string }): Promise<void> {
  const deps = await buildDeps(options.config);

  const listResult = await deps.sessionEffects.list();
  if (isErr(listResult)) {
    console.error(`Failed to list sessions: ${listResult.err.message}`);
    process.exit(1);
  }

  const sessions = listResult.val;

  if (sessions.length === 0) {
    console.log('No exploration sessions found.');
    console.log('Run `agent explore` to start a new exploration.');
    return;
  }

  console.log(`\nExploration Sessions (${sessions.length}):\n`);

  for (const session of sessions) {
    const statusIcon = getStatusIcon(session.status);
    const summary = getFindingsSummary(session.findings);

    console.log(`${statusIcon} ${session.sessionId}`);
    console.log(`   Status: ${session.status}`);
    console.log(`   Focus: ${session.focus.join(', ')}`);
    console.log(`   Findings: ${summary.total} (${summary.bySeverity.critical} critical, ${summary.bySeverity.high} high)`);
    console.log(`   Created: ${new Date(session.createdAt).toLocaleString()}`);
    console.log('');
  }
}

/**
 * セッションサマリーを表示
 */
function displaySessionSummary(session: ExplorationSession): void {
  const summary = getFindingsSummary(session.findings);

  console.log(`\nExploration Session: ${session.sessionId}`);
  console.log(`   Focus: ${session.focus.join(', ')}`);
  console.log(`   Scope: ${session.scope.join(', ')}`);
  console.log(`   Status: ${session.status}`);
  console.log('');

  console.log('Findings Summary:');
  console.log(`   Total: ${summary.total}`);
  console.log(`   Critical: ${summary.bySeverity.critical}`);
  console.log(`   High: ${summary.bySeverity.high}`);
  console.log(`   Medium: ${summary.bySeverity.medium}`);
  console.log(`   Low: ${summary.bySeverity.low}`);
  console.log('');

  // Critical/Highの発見事項を表示
  const criticalHigh = filterFindings(session.findings, {
    severity: ['critical', 'high'],
  });

  if (criticalHigh.length > 0) {
    console.log('Critical/High Findings:');
    for (const finding of criticalHigh.slice(0, 5)) {
      const icon = getSeverityIcon(finding.severity);
      console.log(`   ${icon} [${finding.category}] ${finding.title}`);
      console.log(`      Location: ${finding.location.file}:${finding.location.line ?? '?'}`);
    }
    if (criticalHigh.length > 5) {
      console.log(`   ... and ${criticalHigh.length - 5} more`);
    }
    console.log('');
  }

  // タスク候補
  if (session.taskCandidates.length > 0) {
    const approved = session.taskCandidates.filter((c) => c.approved).length;
    console.log(`Task Candidates: ${session.taskCandidates.length} (${approved} approved)`);
    console.log('   Use `agent explore approve --all` to approve all candidates');
    console.log('   Use `agent explore findings` to see all findings');
  }
}

/**
 * 重要度アイコンを取得
 */
function getSeverityIcon(severity: string): string {
  switch (severity) {
    case 'critical':
      return '\u{1F534}'; // red circle
    case 'high':
      return '\u{1F7E0}'; // orange circle
    case 'medium':
      return '\u{1F7E1}'; // yellow circle
    case 'low':
      return '\u{1F7E2}'; // green circle
    default:
      return '\u{26AA}'; // white circle
  }
}

/**
 * ステータスアイコンを取得
 */
function getStatusIcon(status: string): string {
  switch (status) {
    case 'exploring':
      return '\u{1F50D}'; // magnifying glass
    case 'awaiting-approval':
      return '\u{23F3}'; // hourglass
    case 'executing':
      return '\u{1F504}'; // arrows rotating
    case 'completed':
      return '\u{2705}'; // check mark
    case 'failed':
      return '\u{274C}'; // cross mark
    default:
      return '\u{2753}'; // question mark
  }
}
