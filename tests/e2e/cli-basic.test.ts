import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

// プロジェクトルートを取得（このファイルから2階層上）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const TEST_BASE_PATH = path.join(PROJECT_ROOT, '.tmp', 'test-e2e');
// CLIのパスは絶対パスで指定（cwdが変わっても正しく解決されるように）
const CLI_PATH = path.resolve(PROJECT_ROOT, 'src', 'cli', 'index.ts');

/**
 * CLIコマンドを実行するヘルパー関数
 *
 * Node.js 24+のTypeScript直接実行機能を使用
 */
async function runCLI(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn('node', [CLI_PATH, ...args], {
      cwd,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

test('E2E: CLI basic commands', async (t) => {
  await t.test('setup - clean test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
    await fs.mkdir(TEST_BASE_PATH, { recursive: true });
  });

  const testProjectPath = path.join(TEST_BASE_PATH, 'test-project');
  const agentCoordPath = path.join(TEST_BASE_PATH, 'agent-coord');

  await t.test('setup - create test project directory', async () => {
    await fs.mkdir(testProjectPath, { recursive: true });
    await fs.mkdir(agentCoordPath, { recursive: true });
  });

  await t.test('agent init - should create config file', async () => {
    const result = await runCLI(
      [
        'init',
        '--app-repo',
        testProjectPath,
        '--agent-coord',
        agentCoordPath,
      ],
      TEST_BASE_PATH
    );

    assert.strictEqual(result.exitCode, 0, 'init command should succeed');

    // 設定ファイルが生成されることを確認
    const configPath = path.join(testProjectPath, '.agent', 'config.json');
    const configExists = await fs.stat(configPath).then(
      () => true,
      () => false
    );
    assert.strictEqual(configExists, true, 'config.json should be created');

    // agent-coordの構造が作成されることを確認
    const tasksDir = path.join(agentCoordPath, 'tasks');
    const tasksDirExists = await fs.stat(tasksDir).then(
      () => true,
      () => false
    );
    assert.strictEqual(tasksDirExists, true, 'tasks/ directory should be created');

    const runsDir = path.join(agentCoordPath, 'runs');
    const runsDirExists = await fs.stat(runsDir).then(
      () => true,
      () => false
    );
    assert.strictEqual(runsDirExists, true, 'runs/ directory should be created');

    const checksDir = path.join(agentCoordPath, 'checks');
    const checksDirExists = await fs.stat(checksDir).then(
      () => true,
      () => false
    );
    assert.strictEqual(checksDirExists, true, 'checks/ directory should be created');
  });

  await t.test('agent status - should display task list', async () => {
    const result = await runCLI(['status'], testProjectPath);

    // statusコマンドが正常に実行されることを確認
    // （タスクがない場合でもエラーにならないこと）
    assert.strictEqual(result.exitCode, 0, 'status command should succeed');
  });

  await t.test('cleanup - remove test directory', async () => {
    await fs.rm(TEST_BASE_PATH, { recursive: true, force: true });
  });
});
