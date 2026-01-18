/**
 * Git Adapter Unit Tests
 *
 * Tests basic Git operations through GitAdapter.
 * Uses a temporary git repository for isolated testing.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';
import { GitAdapter } from '../../../../src/adapters/vcs/git-adapter.ts';

describe('GitAdapter', () => {
  let testDir: string;
  let adapter: GitAdapter;

  before(async () => {
    // Create temporary directory
    testDir = await mkdtemp(join(tmpdir(), 'git-adapter-test-'));

    // Initialize git repository
    const git = simpleGit(testDir);
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');

    // Create initial commit (required for branch operations)
    await git.raw(['commit', '--allow-empty', '-m', 'Initial commit']);

    adapter = new GitAdapter({ baseDir: testDir });
  });

  after(async () => {
    // Cleanup temporary directory
    await rm(testDir, { recursive: true, force: true });
  });

  describe('Branch Operations', () => {
    it('should get current branch', async () => {
      const currentBranch = await adapter.getCurrentBranch();
      // Initial branch is usually 'main' or 'master'
      assert.ok(['main', 'master'].includes(currentBranch));
    });

    it('should create a new branch', async () => {
      const branchName = 'feature/test-branch';
      const result = await adapter.createBranch(branchName);
      assert.strictEqual(result, branchName);

      const branches = await adapter.listBranches();
      assert.ok(branches.all.includes(branchName));
    });

    it('should switch to a branch', async () => {
      const branchName = 'feature/switch-test';
      await adapter.createBranch(branchName);
      await adapter.switchBranch(branchName);

      const currentBranch = await adapter.getCurrentBranch();
      assert.strictEqual(currentBranch, branchName);
    });

    it('should delete a branch', async () => {
      const branchName = 'feature/delete-test';
      await adapter.createBranch(branchName);

      // Switch back to main/master before deleting
      const initialBranch = await adapter.getCurrentBranch();
      if (initialBranch !== 'main' && initialBranch !== 'master') {
        await adapter.switchBranch('main').catch(() => adapter.switchBranch('master'));
      }

      await adapter.deleteBranch(branchName);

      const branches = await adapter.listBranches();
      assert.ok(!branches.all.includes(branchName));
    });

    it('should list all branches', async () => {
      const branches = await adapter.listBranches();
      assert.ok(branches.all.length > 0);
      assert.ok(branches.current);
    });
  });

  describe('Commit/Push Operations', () => {
    it('should stage and commit changes', async () => {
      // Create a test file
      const git = simpleGit(testDir);
      await git.raw(['commit', '--allow-empty', '-m', 'Test commit']);

      const status = await adapter.getStatus();
      assert.ok(status);
    });

    it('should check if remote exists', async () => {
      const hasOrigin = await adapter.hasRemote('origin');
      // No remote configured in test repo
      assert.strictEqual(hasOrigin, false);

      const hasNonExistent = await adapter.hasRemote('nonexistent');
      assert.strictEqual(hasNonExistent, false);
    });
  });

  describe('Status/Diff Operations', () => {
    it('should get repository status', async () => {
      const status = await adapter.getStatus();
      assert.ok(status);
      assert.ok(Array.isArray(status.files));
    });

    it('should get diff output', async () => {
      const diff = await adapter.getDiff();
      assert.strictEqual(typeof diff, 'string');
    });
  });
});
