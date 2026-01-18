/**
 * Worktree Adapter Unit Tests
 *
 * Tests git worktree operations through WorktreeAdapter.
 * Uses a temporary git repository for isolated testing.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { WorktreeAdapter } from '../../../../src/adapters/vcs/worktree-adapter.ts';

describe('WorktreeAdapter', () => {
  let testDir: string;
  let adapter: WorktreeAdapter;
  let defaultBranch: string;

  before(async () => {
    // Create temporary directory
    testDir = await mkdtemp(join(tmpdir(), 'worktree-adapter-test-'));

    // Initialize git repository
    const git = simpleGit(testDir);
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');

    // Create initial commit (required for worktree operations)
    await git.raw(['commit', '--allow-empty', '-m', 'Initial commit']);

    // Get default branch name (could be 'main' or 'master')
    const branchSummary = await git.branch();
    defaultBranch = branchSummary.current;

    // Create .git/worktree directory
    await mkdir(join(testDir, '.git', 'worktree'), { recursive: true });

    adapter = new WorktreeAdapter({ baseDir: testDir });
  });

  after(async () => {
    // Cleanup temporary directory
    await rm(testDir, { recursive: true, force: true });
  });

  describe('Git Command Execution Infrastructure', () => {
    it('should list worktrees successfully', async () => {
      const worktrees = await adapter.listWorktrees();

      // Should have at least the main worktree
      assert.ok(worktrees.length >= 1);
      const mainWorktree = worktrees[0];
      assert.ok(mainWorktree.path);
      assert.ok(mainWorktree.head);
      assert.ok(mainWorktree.branch);
    });
  });

  describe('Worktree CRUD Operations', () => {
    it('should create a new worktree', async () => {
      const git = simpleGit(testDir);

      // Create a new branch first
      await git.branch(['feature-test']);

      // Create worktree
      const worktreePath = await adapter.createWorktree('test-worktree', 'feature-test');

      assert.ok(worktreePath.includes('.git/worktree/test-worktree'));

      // Verify worktree was created
      const worktrees = await adapter.listWorktrees();
      const createdWorktree = worktrees.find((wt) => wt.path.includes('test-worktree'));
      assert.ok(createdWorktree);
      assert.strictEqual(createdWorktree.branch, 'feature-test');
    });

    it('should create a new worktree with a new branch', async () => {
      const worktreePath = await adapter.createWorktree(
        'new-branch-worktree',
        'brand-new-branch',
        true,
      );

      assert.ok(worktreePath.includes('.git/worktree/new-branch-worktree'));

      // Verify worktree was created
      const worktrees = await adapter.listWorktrees();
      const createdWorktree = worktrees.find((wt) => wt.path.includes('new-branch-worktree'));
      assert.ok(createdWorktree);
      assert.strictEqual(createdWorktree.branch, 'brand-new-branch');
    });

    it('should remove a worktree', async () => {
      // Create a worktree with a new branch
      await adapter.createWorktree('to-be-removed', 'remove-test-branch', true);

      // Verify it exists
      let worktrees = await adapter.listWorktrees();
      let targetWorktree = worktrees.find((wt) => wt.path.includes('to-be-removed'));
      assert.ok(targetWorktree);

      // Remove it
      await adapter.removeWorktree('to-be-removed');

      // Verify it's gone
      worktrees = await adapter.listWorktrees();
      targetWorktree = worktrees.find((wt) => wt.path.includes('to-be-removed'));
      assert.strictEqual(targetWorktree, undefined);
    });

    it('should prune stale worktrees', async () => {
      // Prune should not throw an error
      await adapter.pruneWorktrees();

      // Verify worktrees are still accessible
      const worktrees = await adapter.listWorktrees();
      assert.ok(worktrees.length >= 1);
    });
  });

  describe('Worktree Naming Conventions', () => {
    it('should generate correct worker worktree name', () => {
      const taskId = 'task-123';
      const name = WorktreeAdapter.getWorkerWorktreeName(taskId);
      assert.strictEqual(name, 'impl/task-123');
    });

    it('should generate correct planner worktree name', () => {
      const name = WorktreeAdapter.getPlannerWorktreeName();
      assert.strictEqual(name, 'planner');
    });

    it('should generate correct judge worktree name', () => {
      const name = WorktreeAdapter.getJudgeWorktreeName();
      assert.strictEqual(name, 'judge');
    });

    it('should create and remove worker worktree', async () => {
      const taskId = 'task-worker-test';

      // Create worker worktree
      const worktreePath = await adapter.createWorkerWorktree(taskId, 'feature/worker-test');

      assert.ok(worktreePath.includes('impl/task-worker-test'));

      // Verify it exists
      const worktrees = await adapter.listWorktrees();
      const workerWorktree = worktrees.find((wt) => wt.path.includes('impl/task-worker-test'));
      assert.ok(workerWorktree);
      assert.strictEqual(workerWorktree.branch, 'feature/worker-test');

      // Remove it
      await adapter.removeWorkerWorktree(taskId);

      // Verify it's gone
      const worktreesAfter = await adapter.listWorktrees();
      const removedWorktree = worktreesAfter.find((wt) =>
        wt.path.includes('impl/task-worker-test'),
      );
      assert.strictEqual(removedWorktree, undefined);
    });

    it('should create and remove planner worktree', async () => {
      const git = simpleGit(testDir);

      // Create a new branch for planner
      await git.branch(['planner-branch']);

      // Create planner worktree
      const worktreePath = await adapter.createPlannerWorktree('planner-branch');

      assert.ok(worktreePath.includes('planner'));

      // Verify it exists
      const worktrees = await adapter.listWorktrees();
      const plannerWorktree = worktrees.find((wt) => wt.path.includes('planner'));
      assert.ok(plannerWorktree);
      assert.strictEqual(plannerWorktree.branch, 'planner-branch');

      // Remove it
      await adapter.removePlannerWorktree();

      // Verify it's gone
      const worktreesAfter = await adapter.listWorktrees();
      const removedWorktree = worktreesAfter.find((wt) => wt.path.includes('planner'));
      assert.strictEqual(removedWorktree, undefined);
    });

    it('should create and remove judge worktree', async () => {
      const git = simpleGit(testDir);

      // Create a new branch for judge
      await git.branch(['judge-branch']);

      // Create judge worktree
      const worktreePath = await adapter.createJudgeWorktree('judge-branch');

      assert.ok(worktreePath.includes('judge'));

      // Verify it exists
      const worktrees = await adapter.listWorktrees();
      const judgeWorktree = worktrees.find((wt) => wt.path.includes('judge'));
      assert.ok(judgeWorktree);
      assert.strictEqual(judgeWorktree.branch, 'judge-branch');

      // Remove it
      await adapter.removeJudgeWorktree();

      // Verify it's gone
      const worktreesAfter = await adapter.listWorktrees();
      const removedWorktree = worktreesAfter.find((wt) => wt.path.includes('judge'));
      assert.strictEqual(removedWorktree, undefined);
    });
  });
});
