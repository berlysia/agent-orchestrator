import { Command } from 'commander';
import { createFileStore } from '../../core/task-store/file-store.ts';
import { createRunnerEffects } from '../../core/runner/runner-effects-impl.ts';
import { createGitEffects } from '../../adapters/vcs/index.ts';
import { createOrchestrator } from '../../core/orchestrator/orchestrate.ts';
import { PlannerSessionEffectsImpl } from '../../core/orchestrator/planner-session-effects-impl.ts';
import { isErr } from 'option-t/plain_result';
import { loadConfig } from '../utils/load-config.ts';
import { generateReportSafely } from '../utils/auto-report.ts';
import { createProgressEmitter } from '../../adapters/progress/progress-emitter-impl.ts';
import { createTTYRenderer } from '../progress/tty-renderer.ts';
import { parseIssueRef, isIssueRef } from '../../adapters/github/issue-parser.ts';
import { checkGhCli } from '../../adapters/github/cli-check.ts';
import { fetchIssue, getCurrentRepo } from '../../adapters/github/issue-fetcher.ts';
import { convertIssueToTaskContext, extractSourceIssue } from '../../adapters/github/issue-to-task.ts';
import type { SourceIssue } from '../../types/github-issue.ts';
import { NdjsonSessionLogger } from '../../core/session/ndjson-writer.ts';
import { FileSessionPointerManager } from '../../core/session/session-pointer.ts';

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
    .option('--no-report', 'Disable automatic report generation')
    .action(async (instruction: string, options) => {
      try {
        await executeRun({
          instruction,
          configPath: options.config,
          noReport: options.noReport,
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
async function executeRun(params: {
  instruction: string;
  configPath?: string;
  noReport?: boolean;
}): Promise<void> {
  const { instruction: rawInstruction, configPath, noReport } = params;

  // 設定ファイルを読み込み
  const config = await loadConfig(configPath);

  // GitHub Issue参照の処理（#123 や owner/repo#123 形式）
  let instruction = rawInstruction;
  let sourceIssue: SourceIssue | undefined;

  if (isIssueRef(rawInstruction)) {
    console.log(`🔗 Detected GitHub Issue reference: ${rawInstruction}`);

    // gh CLI の存在確認
    const cliCheckResult = await checkGhCli();
    if (isErr(cliCheckResult)) {
      console.error(`❌ ${cliCheckResult.err.message}`);
      process.exit(1);
    }

    // Issue参照をパース
    const refResult = parseIssueRef(rawInstruction);
    if (isErr(refResult)) {
      console.error(`❌ Invalid Issue reference: ${refResult.err.message}`);
      process.exit(1);
    }

    let issueRef = refResult.val;

    // owner/repoを取得（ローカルリポジトリから）
    if (issueRef.type === 'number') {
      // ローカルリポジトリから取得
      const repoResult = await getCurrentRepo();
      if (isErr(repoResult)) {
        console.error(`❌ Failed to get current repository: ${repoResult.err.message}`);
        console.error('   Tip: Use full URL or owner/repo#123 format');
        process.exit(1);
      }
      // IssueRefをURL形式に変換（owner/repo情報を含める）
      issueRef = {
        type: 'url',
        owner: repoResult.val.owner,
        repo: repoResult.val.repo,
        number: issueRef.number,
      };
    }

    const owner = issueRef.owner;
    const repo = issueRef.repo;

    // Issueを取得
    console.log(`📥 Fetching Issue #${issueRef.number} from ${owner}/${repo}...`);
    const issueResult = await fetchIssue(issueRef);
    if (isErr(issueResult)) {
      console.error(`❌ Failed to fetch Issue: ${issueResult.err.message}`);
      process.exit(1);
    }

    const parsedIssue = issueResult.val;
    console.log(`   Title: ${parsedIssue.title}`);
    console.log(`   State: ${parsedIssue.state}`);
    if (parsedIssue.labels.length > 0) {
      console.log(`   Labels: ${parsedIssue.labels.join(', ')}`);
    }
    console.log('');

    // Issue→タスクコンテキスト変換
    instruction = convertIssueToTaskContext(parsedIssue);
    sourceIssue = extractSourceIssue(parsedIssue, issueRef);
  }

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

  // SessionLogger を初期化（ADR-027）
  const sessionPointerManager = new FileSessionPointerManager(config.agentCoordPath);
  const sessionLogger = new NdjsonSessionLogger(config.agentCoordPath, sessionPointerManager);

  // ProgressEmitterとTTYRendererを初期化
  const progressEmitter = createProgressEmitter();
  const renderer = createTTYRenderer(progressEmitter);

  // Orchestratorを初期化（新しい関数型実装）
  const orchestrator = createOrchestrator({
    taskStore,
    runnerEffects,
    gitEffects,
    sessionEffects,
    config,
    maxWorkers: config.maxWorkers,
    progressEmitter,
    sessionLogger,
  });

  // レンダラーを開始
  renderer.start();

  // タスクを実行
  console.log(`🚀 Starting orchestration...\n`);

  try {
    const resultOrError = await orchestrator.executeInstruction(instruction);

    // レンダラーを停止
    renderer.stop();

    // Result型をunwrap
    if (isErr(resultOrError)) {
      // エラー時もレポート生成を試みる（デバッグ用）
      if (!noReport) {
        // エラー時はsessionIdが取得できないので、レポート生成をスキップ
        console.warn('\n⚠️  Orchestration failed, skipping report generation');
      }
      console.error(`\n❌ Orchestration error: ${resultOrError.err.message}`);
      process.exit(1);
    }

    const result = resultOrError.val;

    // 結果を表示
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Orchestration Summary:`);
    if (sourceIssue) {
      console.log(`  Source Issue: #${sourceIssue.number} (${sourceIssue.owner}/${sourceIssue.repo})`);
    }
    console.log(`  Total tasks: ${result.taskIds.length}`);
    console.log(`  Completed: ${result.completedTaskIds.length}`);
    console.log(`  Failed: ${result.failedTaskIds.length}`);
    if (result.blockedTaskIds && result.blockedTaskIds.length > 0) {
      console.log(`  Blocked: ${result.blockedTaskIds.length}`);
    }
    console.log(`  Status: ${result.success ? '✅ SUCCESS' : '❌ FAILED'}`);
    console.log(`${'='.repeat(60)}\n`);

    // レポート自動生成（成功・失敗どちらでも）
    if (!noReport) {
      await generateReportSafely(result.sessionId, config.agentCoordPath);
    }

    if (!result.success) {
      process.exit(1);
    }
  } catch (error) {
    // レンダラーを停止
    renderer.stop();
    // 予期しないエラー時もレポート生成を試みる（可能なら）
    console.error('Unexpected error during orchestration:', error);
    process.exit(1);
  }
}
