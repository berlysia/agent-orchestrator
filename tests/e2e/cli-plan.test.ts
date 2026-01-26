import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

describe('CLI: agent plan (E2E)', () => {
  const testDir = path.join(process.cwd(), '.tmp', 'test-cli-plan');
  const agentCoordPath = path.join(testDir, '.agent');
  const configPath = path.join(agentCoordPath, 'config.json');

  beforeEach(async () => {
    // テスト用ディレクトリをクリーンアップ
    await fs.rm(testDir, { recursive: true, force: true });
    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(agentCoordPath, { recursive: true });

    // 最小限の設定ファイルを作成
    const minimalConfig = {
      appRepoPath: testDir,
      agentCoordPath: agentCoordPath,
      maxWorkers: 1,
      agents: {
        planner: {
          type: 'claude',
          model: 'claude-sonnet-4',
        },
        worker: {
          type: 'claude',
          model: 'claude-sonnet-4',
        },
        judge: {
          type: 'claude',
          model: 'claude-sonnet-4',
        },
      },
    };

    await fs.writeFile(configPath, JSON.stringify(minimalConfig, null, 2), 'utf-8');
  });

  afterEach(async () => {
    // クリーンアップ
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('agent plan --resume (no sessions)', () => {
    it('should show empty session list', async () => {
      const output = execSync(
        `node dist/cli/index.js plan --resume --config ${configPath}`,
        {
          cwd: process.cwd(),
          encoding: 'utf-8',
        },
      );

      assert.ok(output.includes('No planning sessions found'));
    });
  });

  describe('agent plan (without instruction)', () => {
    it('should show error for missing instruction', async () => {
      try {
        execSync(`node dist/cli/index.js plan --config ${configPath}`, {
          cwd: process.cwd(),
          encoding: 'utf-8',
        });
        assert.fail('Should have thrown an error');
      } catch (error: unknown) {
        const err = error as { stdout?: string; stderr?: string; message?: string };
        const errorMessage = err.stderr || err.stdout || err.message || '';
        assert.ok(
          errorMessage.includes('instruction is required') ||
            errorMessage.includes('error'),
        );
      }
    });
  });
});
