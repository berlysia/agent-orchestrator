import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LogWriter } from '../../../../src/core/runner/log-writer.ts';
import { createInitialRun } from '../../../../src/types/run.ts';

// テスト用の一時ディレクトリを作成
async function createTempDir(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'log-writer-test-'));
  return tmpDir;
}

// テスト用の一時ディレクトリを削除
async function removeTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

test('LogWriter - runs/ディレクトリ初期化', async () => {
  const tmpDir = await createTempDir();

  try {
    const writer = new LogWriter({ coordRepoPath: tmpDir });
    await writer.ensureRunsDir();

    const runsDir = path.join(tmpDir, 'runs');
    const stat = await fs.stat(runsDir);
    assert.ok(stat.isDirectory(), 'runs/ directory should be created');
  } finally {
    await removeTempDir(tmpDir);
  }
});

test('LogWriter - ログ追記', async () => {
  const tmpDir = await createTempDir();

  try {
    const writer = new LogWriter({ coordRepoPath: tmpDir });
    await writer.ensureRunsDir();

    const runId = 'test-run-123';
    await writer.appendLog(runId, 'Line 1\n');
    await writer.appendLog(runId, 'Line 2\n');

    const logContent = await writer.readLog(runId);
    assert.strictEqual(logContent, 'Line 1\nLine 2\n');
  } finally {
    await removeTempDir(tmpDir);
  }
});

test('LogWriter - Runメタデータ保存・読み込み', async () => {
  const tmpDir = await createTempDir();

  try {
    const writer = new LogWriter({ coordRepoPath: tmpDir });
    await writer.ensureRunsDir();

    const run = createInitialRun({
      id: 'run-456',
      taskId: 'task-123',
      agentType: 'claude',
      logPath: './runs/run-456.log',
    });

    await writer.saveRunMetadata(run);

    const loaded = await writer.loadRunMetadata('run-456');
    assert.ok(loaded, 'Run metadata should be loaded');
    assert.strictEqual(loaded.id, 'run-456');
    assert.strictEqual(loaded.taskId, 'task-123');
    assert.strictEqual(loaded.agentType, 'claude');
  } finally {
    await removeTempDir(tmpDir);
  }
});

test('LogWriter - 存在しないRunメタデータ読み込み', async () => {
  const tmpDir = await createTempDir();

  try {
    const writer = new LogWriter({ coordRepoPath: tmpDir });
    await writer.ensureRunsDir();

    const loaded = await writer.loadRunMetadata('nonexistent-run');
    assert.strictEqual(loaded, null, 'Non-existent run should return null');
  } finally {
    await removeTempDir(tmpDir);
  }
});

test('LogWriter - 存在しないログ読み込み', async () => {
  const tmpDir = await createTempDir();

  try {
    const writer = new LogWriter({ coordRepoPath: tmpDir });
    await writer.ensureRunsDir();

    const log = await writer.readLog('nonexistent-run');
    assert.strictEqual(log, null, 'Non-existent log should return null');
  } finally {
    await removeTempDir(tmpDir);
  }
});

test('LogWriter - ログファイルパス取得', async () => {
  const tmpDir = await createTempDir();
  const writer = new LogWriter({ coordRepoPath: tmpDir });

  const logPath = writer.getLogFilePath('run-123');
  assert.ok(logPath.endsWith('runs/run-123.log'), 'Log path should end with runs/run-123.log');

  await removeTempDir(tmpDir);
});

test('LogWriter - Runメタデータパス取得', async () => {
  const tmpDir = await createTempDir();
  const writer = new LogWriter({ coordRepoPath: tmpDir });

  const metadataPath = writer.getRunMetadataPath('run-123');
  assert.ok(
    metadataPath.endsWith('runs/run-123.json'),
    'Metadata path should end with runs/run-123.json',
  );

  await removeTempDir(tmpDir);
});
