import { Command } from 'commander';
import { createFileStore } from '../../core/task-store/file-store.ts';
import { PlannerSessionEffectsImpl } from '../../core/orchestrator/planner-session-effects-impl.ts';
import { ReportGenerator } from '../../core/report/index.ts';
import { isErr } from 'option-t/plain_result';
import { loadConfig } from '../utils/load-config.ts';
import type { TaskStoreError } from '../../types/errors.ts';

/**
 * `agent report [rootSessionId]` コマンドの実装
 *
 * 監視レポートを生成し、ファイルに保存または標準出力に表示する。
 */
export function createReportCommand(): Command {
  const reportCommand = new Command('report')
    .description('Generate monitoring report')
    .argument('[rootSessionId]', 'Root session ID (default: most recent)')
    .option('--stdout', 'Output to stdout instead of file')
    .option('--config <path>', 'Path to configuration file')
    .action(async (rootSessionId: string | undefined, options) => {
      try {
        await executeReport({
          rootSessionId,
          stdout: options.stdout,
          configPath: options.config,
        });
      } catch (error) {
        console.error('Report generation failed:', error);
        process.exit(1);
      }
    });

  return reportCommand;
}

/**
 * agent report の実行処理
 */
async function executeReport(params: {
  rootSessionId?: string;
  stdout: boolean;
  configPath?: string;
}): Promise<void> {
  const { rootSessionId, stdout, configPath } = params;

  // 設定ファイルを読み込み
  const config = await loadConfig(configPath);

  // TaskStoreを初期化
  const taskStore = createFileStore({
    basePath: config.agentCoordPath,
  });

  // SessionEffectsを初期化
  const sessionEffects = new PlannerSessionEffectsImpl(config.agentCoordPath);

  // rootSessionIdが指定されていない場合、最新のルートセッションを取得
  let targetRootSessionId = rootSessionId;
  if (!targetRootSessionId) {
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

    // 最新のセッションを取得（listSessionsは降順でソート済み）
    const latestSession = sessions[0];
    if (!latestSession) {
      console.error('❌ Failed to retrieve latest session');
      process.exit(1);
    }

    targetRootSessionId = latestSession.sessionId;
  }

  // セッションが存在するか確認
  const existsResult = await sessionEffects.sessionExists(targetRootSessionId);
  if (isErr(existsResult)) {
    const error = existsResult.err as TaskStoreError;
    console.error(`❌ Failed to check session existence: ${error.message}`);
    process.exit(1);
  }

  if (!existsResult.val) {
    console.error(`❌ Session not found: ${targetRootSessionId}`);
    process.exit(1);
  }

  // ReportGeneratorをインスタンス化
  const reportGenerator = new ReportGenerator(sessionEffects, taskStore, config.agentCoordPath);

  try {
    if (stdout) {
      // 標準出力に出力
      const report = await reportGenerator.generate(targetRootSessionId);
      console.log(report);
    } else {
      // ファイルに保存
      const reportPath = await reportGenerator.saveReport(targetRootSessionId);
      if (!reportPath) {
        console.error('❌ Failed to save report');
        process.exit(1);
      }
      console.log(reportPath);
    }
  } catch (error) {
    console.error(`❌ Report generation error: ${error}`);
    process.exit(1);
  }
}
