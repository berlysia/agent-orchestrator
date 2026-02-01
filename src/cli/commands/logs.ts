import { Command } from 'commander';
import { isErr } from 'option-t/plain_result';
import { loadConfig } from '../utils/load-config.ts';
import { FileSessionPointerManager } from '../../core/session/session-pointer.ts';
import { readSessionLog } from '../../core/report/ndjson-extractor.ts';
import { SessionLogType, type SessionLogRecord } from '../../types/session-log.ts';

/**
 * `agent logs` コマンドの実装
 *
 * セッションログをNDJSON形式で表示する。
 */
export function createLogsCommand(): Command {
  const logsCommand = new Command('logs')
    .description('Display session logs')
    .argument('[sessionId]', 'Session ID to display (default: latest)')
    .option('--config <path>', 'Path to configuration file')
    .option('--json', 'Output in raw JSON format')
    .option('-n, --lines <count>', 'Number of lines to show (default: all)', parseInt)
    .option('--type <type>', 'Filter by log type (e.g., phase_start, task_created)')
    .action(async (sessionId: string | undefined, options) => {
      try {
        await executeLogs({
          sessionId,
          configPath: options.config,
          json: options.json,
          lines: options.lines,
          type: options.type,
        });
      } catch (error) {
        console.error('Failed to display logs:', error);
        process.exit(1);
      }
    });

  return logsCommand;
}

/**
 * agent logs の実行処理
 */
async function executeLogs(params: {
  sessionId?: string;
  configPath?: string;
  json?: boolean;
  lines?: number;
  type?: string;
}): Promise<void> {
  const { sessionId, configPath, json, lines, type } = params;

  // 設定ファイルを読み込み
  const config = await loadConfig(configPath);

  // セッションIDが指定されていない場合、最新のセッションを取得
  let targetSessionId = sessionId;
  if (!targetSessionId) {
    const pointerManager = new FileSessionPointerManager(config.agentCoordPath);
    const latestResult = await pointerManager.getLatest();

    if (isErr(latestResult)) {
      console.error('❌ No sessions found. Run `agent run` first to create a session.');
      process.exit(1);
    }

    targetSessionId = latestResult.val.sessionId;
    console.log(`📋 Showing logs for session: ${targetSessionId}\n`);
  }

  // ログを読み取り
  const records: SessionLogRecord[] = [];
  for await (const record of readSessionLog(config.agentCoordPath, targetSessionId)) {
    // タイプフィルタ
    if (type && record.type !== type) {
      continue;
    }
    records.push(record);
  }

  if (records.length === 0) {
    console.log('No log records found.');
    return;
  }

  // 行数制限
  const displayRecords = lines ? records.slice(-lines) : records;

  // 出力
  if (json) {
    // JSON形式で出力
    for (const record of displayRecords) {
      console.log(JSON.stringify(record));
    }
  } else {
    // 人間が読みやすい形式で出力
    for (const record of displayRecords) {
      console.log(formatLogRecord(record));
    }
  }

  console.log(`\nTotal: ${displayRecords.length} records`);
}

/**
 * ログレコードを人間が読みやすい形式にフォーマット
 */
function formatLogRecord(record: SessionLogRecord): string {
  const timestamp = formatTimestamp(record.timestamp);
  const typeIcon = getTypeIcon(record.type);
  const typeLabel = record.type.padEnd(16);

  let details = '';
  switch (record.type) {
    case SessionLogType.SESSION_START:
      details = `Task: ${truncate(record.task, 60)}`;
      break;
    case SessionLogType.SESSION_COMPLETE:
      details = `Summary: ${truncate(record.summary, 60)}`;
      break;
    case SessionLogType.SESSION_ABORT:
      details = `Reason: ${truncate(record.reason, 60)}`;
      break;
    case SessionLogType.PHASE_START:
    case SessionLogType.PHASE_COMPLETE:
      details = `Phase: ${record.phase}`;
      break;
    case SessionLogType.TASK_CREATED:
      details = `Task: ${record.taskId} - ${truncate(record.title, 40)}`;
      break;
    case SessionLogType.TASK_UPDATED:
      details = `Task: ${record.taskId} → ${record.newState}`;
      break;
    case SessionLogType.WORKER_START:
      details = `Task: ${record.taskId}, Worker: ${record.workerId}`;
      break;
    case SessionLogType.WORKER_COMPLETE:
      details = `Task: ${record.taskId}, Status: ${record.status}`;
      break;
    case SessionLogType.JUDGE_START:
      details = `Task: ${record.taskId}`;
      break;
    case SessionLogType.JUDGE_COMPLETE:
      details = `Task: ${record.taskId}, Verdict: ${record.verdict}`;
      break;
    case SessionLogType.LEADER_DECISION:
      details = `Decision: ${record.decision}`;
      break;
    case SessionLogType.ERROR:
      details = `Error: ${truncate(record.message, 60)}`;
      break;
    default:
      details = JSON.stringify(record).substring(0, 60);
  }

  return `${timestamp} ${typeIcon} ${typeLabel} ${details}`;
}

/**
 * タイムスタンプをフォーマット
 */
function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('ja-JP', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * ログタイプに対応するアイコンを取得
 */
function getTypeIcon(type: string): string {
  switch (type) {
    case SessionLogType.SESSION_START:
      return '🚀';
    case SessionLogType.SESSION_COMPLETE:
      return '✅';
    case SessionLogType.SESSION_ABORT:
      return '❌';
    case SessionLogType.PHASE_START:
      return '▶️';
    case SessionLogType.PHASE_COMPLETE:
      return '⏹️';
    case SessionLogType.TASK_CREATED:
      return '📋';
    case SessionLogType.TASK_UPDATED:
      return '🔄';
    case SessionLogType.WORKER_START:
      return '👷';
    case SessionLogType.WORKER_COMPLETE:
      return '🏁';
    case SessionLogType.JUDGE_START:
      return '⚖️';
    case SessionLogType.JUDGE_COMPLETE:
      return '🎯';
    case SessionLogType.LEADER_DECISION:
      return '👑';
    case SessionLogType.ERROR:
      return '💥';
    default:
      return '📝';
  }
}

/**
 * 文字列を指定長さに切り詰め
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}
