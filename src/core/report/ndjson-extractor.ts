/**
 * NDJSON Log Extractor (ADR-032)
 *
 * NDJSONログからレポートに必要な情報を抽出するヘルパー関数群。
 */

import * as fs from 'node:fs/promises';
import * as readline from 'node:readline';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import type { SessionLogRecord } from '../../types/session-log.ts';
import {
  SessionLogRecordSchema,
  SessionLogType,
  type SessionPhase,
} from '../../types/session-log.ts';

/**
 * セッションログファイルのパスを取得
 */
function getLogFilePath(basePath: string, sessionId: string): string {
  return path.join(basePath, 'sessions', `${sessionId}.jsonl`);
}

/**
 * セッションログを行単位で読み取る（非同期イテレータ）
 *
 * メモリ効率を考慮し、ストリーム処理を使用
 */
export async function* readSessionLog(
  basePath: string,
  sessionId: string,
): AsyncIterable<SessionLogRecord> {
  const filePath = getLogFilePath(basePath, sessionId);

  try {
    await fs.access(filePath);
  } catch {
    // ファイルが存在しない場合は空のイテレータを返す
    return;
  }

  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line);
      const record = SessionLogRecordSchema.parse(parsed);
      yield record;
    } catch {
      // パースエラーは無視（壊れた行をスキップ）
      console.warn(`Failed to parse log line: ${line.substring(0, 50)}...`);
    }
  }
}

/**
 * セッションログから全レコードを配列として取得
 */
export async function extractAllRecords(
  basePath: string,
  sessionId: string,
): Promise<SessionLogRecord[]> {
  const records: SessionLogRecord[] = [];
  for await (const record of readSessionLog(basePath, sessionId)) {
    records.push(record);
  }
  return records;
}

/**
 * 特定フェーズのイベントを抽出
 */
export async function extractPhaseEvents(
  basePath: string,
  sessionId: string,
  phase: SessionPhase,
): Promise<SessionLogRecord[]> {
  const events: SessionLogRecord[] = [];
  let inPhase = false;

  for await (const record of readSessionLog(basePath, sessionId)) {
    if (
      record.type === SessionLogType.PHASE_START &&
      record.phase === phase
    ) {
      inPhase = true;
      events.push(record);
    } else if (
      record.type === SessionLogType.PHASE_COMPLETE &&
      record.phase === phase
    ) {
      events.push(record);
      inPhase = false;
    } else if (inPhase) {
      events.push(record);
    }
  }

  return events;
}

/**
 * 特定タスクのイベントを抽出
 */
export async function extractTaskEvents(
  basePath: string,
  sessionId: string,
  taskId: string,
): Promise<SessionLogRecord[]> {
  const events: SessionLogRecord[] = [];

  for await (const record of readSessionLog(basePath, sessionId)) {
    // タスク関連のレコードを判定
    if ('taskId' in record && String(record.taskId) === taskId) {
      events.push(record);
    }
  }

  return events;
}

/**
 * セッションの開始・終了レコードを取得
 */
export async function getSessionBoundaries(
  basePath: string,
  sessionId: string,
): Promise<{
  start?: SessionLogRecord;
  end?: SessionLogRecord;
}> {
  let start: SessionLogRecord | undefined;
  let end: SessionLogRecord | undefined;

  for await (const record of readSessionLog(basePath, sessionId)) {
    if (record.type === SessionLogType.SESSION_START) {
      start = record;
    } else if (
      record.type === SessionLogType.SESSION_COMPLETE ||
      record.type === SessionLogType.SESSION_ABORT
    ) {
      end = record;
    }
  }

  return { start, end };
}

/**
 * フェーズの所要時間を計算（ミリ秒）
 */
export function calculatePhaseDuration(events: SessionLogRecord[]): number {
  const startEvent = events.find((e) => e.type === SessionLogType.PHASE_START);
  const endEvent = events.find((e) => e.type === SessionLogType.PHASE_COMPLETE);

  if (!startEvent || !endEvent) {
    return 0;
  }

  const startTime = new Date(startEvent.timestamp).getTime();
  const endTime = new Date(endEvent.timestamp).getTime();

  return endTime - startTime;
}

/**
 * タスクのWorkerイテレーション回数を取得
 */
export async function getWorkerIterationCount(
  basePath: string,
  sessionId: string,
  taskId: string,
): Promise<number> {
  let count = 0;

  for await (const record of readSessionLog(basePath, sessionId)) {
    if (
      record.type === SessionLogType.WORKER_START &&
      String(record.taskId) === taskId
    ) {
      count++;
    }
  }

  return count;
}

/**
 * 作成されたタスク一覧を取得
 */
export async function getCreatedTasks(
  basePath: string,
  sessionId: string,
): Promise<Array<{ taskId: string; title: string }>> {
  const tasks: Array<{ taskId: string; title: string }> = [];

  for await (const record of readSessionLog(basePath, sessionId)) {
    if (record.type === SessionLogType.TASK_CREATED) {
      tasks.push({
        taskId: String(record.taskId),
        title: record.title,
      });
    }
  }

  return tasks;
}

/**
 * エラーレコードを取得
 */
export async function getErrorRecords(
  basePath: string,
  sessionId: string,
): Promise<SessionLogRecord[]> {
  const errors: SessionLogRecord[] = [];

  for await (const record of readSessionLog(basePath, sessionId)) {
    if (record.type === SessionLogType.ERROR) {
      errors.push(record);
    }
  }

  return errors;
}

/**
 * セッション全体の所要時間を計算（ミリ秒）
 */
export async function calculateSessionDuration(
  basePath: string,
  sessionId: string,
): Promise<number> {
  const { start, end } = await getSessionBoundaries(basePath, sessionId);

  if (!start || !end) {
    return 0;
  }

  const startTime = new Date(start.timestamp).getTime();
  const endTime = new Date(end.timestamp).getTime();

  return endTime - startTime;
}

/**
 * タスク完了ステータスを集計
 */
export async function aggregateTaskStatuses(
  basePath: string,
  sessionId: string,
): Promise<{
  done: number;
  needsContinuation: number;
  blocked: number;
  skipped: number;
}> {
  const statuses = {
    done: 0,
    needsContinuation: 0,
    blocked: 0,
    skipped: 0,
  };

  // 各タスクの最終ステータスをマップで追跡
  const taskStatuses = new Map<string, string>();

  for await (const record of readSessionLog(basePath, sessionId)) {
    if (record.type === SessionLogType.JUDGE_COMPLETE) {
      taskStatuses.set(String(record.taskId), record.verdict);
    }
  }

  for (const verdict of taskStatuses.values()) {
    switch (verdict) {
      case 'done':
        statuses.done++;
        break;
      case 'needs_continuation':
        statuses.needsContinuation++;
        break;
      case 'blocked':
        statuses.blocked++;
        break;
      case 'skipped':
        statuses.skipped++;
        break;
    }
  }

  return statuses;
}
