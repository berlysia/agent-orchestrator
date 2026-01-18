import { test } from 'node:test';
import assert from 'node:assert';
import { ProcessRunner } from '../../../../src/core/runner/process-runner.ts';

test('ProcessRunner - 基本的なコマンド実行', async () => {
  const runner = new ProcessRunner();
  const result = await runner.run('echo', ['Hello, World!']);

  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout.trim(), 'Hello, World!');
  assert.strictEqual(result.timedOut, false);
});

test('ProcessRunner - コマンド失敗時のexitCode', async () => {
  const runner = new ProcessRunner();
  const result = await runner.run('ls', ['/nonexistent-directory-12345']);

  assert.notStrictEqual(result.exitCode, 0);
  assert.strictEqual(result.timedOut, false);
});

test('ProcessRunner - タイムアウト制御', async () => {
  const runner = new ProcessRunner();
  const result = await runner.run('sleep', ['10'], { timeout: 100 });

  assert.strictEqual(result.timedOut, true);
  assert.strictEqual(result.signal, 'SIGTERM');
});

test('ProcessRunner - stdout/stderrストリーミング', async (t) => {
  const runner = new ProcessRunner();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const result = await runner.run('sh', ['-c', 'echo "out" && echo "err" >&2'], {
    streaming: true,
    onStdout: (data) => {
      stdoutChunks.push(data);
    },
    onStderr: (data) => {
      stderrChunks.push(data);
    },
  });

  assert.strictEqual(result.exitCode, 0);
  assert.ok(stdoutChunks.length > 0, 'stdout chunks should be captured');
  assert.ok(stderrChunks.length > 0, 'stderr chunks should be captured');
});

test('ProcessRunner - 作業ディレクトリ指定', async () => {
  const runner = new ProcessRunner();
  const result = await runner.run('pwd', [], { cwd: '/tmp' });

  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout.trim(), '/tmp');
});

test('ProcessRunner - 環境変数', async () => {
  const runner = new ProcessRunner();
  const result = await runner.run('sh', ['-c', 'echo $TEST_VAR'], {
    env: { TEST_VAR: 'test-value' },
  });

  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stdout.trim(), 'test-value');
});
