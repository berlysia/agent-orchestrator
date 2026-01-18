/**
 * Git Adapter - Wraps simple-git for basic Git operations
 *
 * Provides a clean interface for branch, commit, push, status, and diff operations.
 * For worktree operations, use worktree-adapter.ts which executes git commands directly.
 */

import { simpleGit, type SimpleGit, type BranchSummary, type StatusResult } from 'simple-git';

export interface GitAdapterOptions {
  /** Working directory for git operations */
  baseDir: string;
}

export class GitAdapter {
  private git: SimpleGit;

  constructor(options: GitAdapterOptions) {
    this.git = simpleGit(options.baseDir);
  }

  // ============================================
  // Branch Operations
  // ============================================

  /**
   * Create a new branch
   * @param branchName - Name of the branch to create
   * @param startPoint - Optional starting point (commit hash, branch name, etc.)
   */
  async createBranch(branchName: string, startPoint?: string): Promise<string> {
    const args = startPoint ? [branchName, startPoint] : [branchName];
    await this.git.branch(args);
    return branchName;
  }

  /**
   * Switch to a different branch
   * @param branchName - Name of the branch to switch to
   */
  async switchBranch(branchName: string): Promise<void> {
    await this.git.checkout(branchName);
  }

  /**
   * Delete a branch
   * @param branchName - Name of the branch to delete
   * @param force - Force deletion even if not fully merged
   */
  async deleteBranch(branchName: string, force = false): Promise<void> {
    const flag = force ? '-D' : '-d';
    await this.git.branch([flag, branchName]);
  }

  /**
   * Get current branch name
   * @returns Current branch name
   */
  async getCurrentBranch(): Promise<string> {
    const branchSummary: BranchSummary = await this.git.branch();
    return branchSummary.current;
  }

  /**
   * List all branches
   * @returns Branch summary including local and remote branches
   */
  async listBranches(): Promise<BranchSummary> {
    return await this.git.branch();
  }

  // ============================================
  // Commit/Push Operations
  // ============================================

  /**
   * Stage all changes
   */
  async addAll(): Promise<void> {
    await this.git.add('.');
  }

  /**
   * Create a commit
   * @param message - Commit message
   */
  async commit(message: string): Promise<void> {
    await this.git.commit(message);
  }

  /**
   * Push commits to remote
   * @param remote - Remote name (default: 'origin')
   * @param branch - Branch name to push (if not specified, pushes current branch)
   */
  async push(remote = 'origin', branch?: string): Promise<void> {
    if (branch) {
      await this.git.push(remote, branch);
    } else {
      await this.git.push();
    }
  }

  /**
   * Pull changes from remote
   * @param remote - Remote name (default: 'origin')
   * @param branch - Branch name to pull (if not specified, pulls current branch)
   */
  async pull(remote = 'origin', branch?: string): Promise<void> {
    if (branch) {
      await this.git.pull(remote, branch);
    } else {
      await this.git.pull();
    }
  }

  /**
   * Check if remote exists
   * @param remoteName - Name of the remote to check (default: 'origin')
   * @returns true if remote exists
   */
  async hasRemote(remoteName = 'origin'): Promise<boolean> {
    const remotes = await this.git.getRemotes();
    return remotes.some((remote) => remote.name === remoteName);
  }

  // ============================================
  // Status/Diff Operations
  // ============================================

  /**
   * Get repository status
   * @returns Status summary including staged, modified, and untracked files
   */
  async getStatus(): Promise<StatusResult> {
    return await this.git.status();
  }

  /**
   * Get diff output
   * @param options - Optional diff options (e.g., ['--cached'] for staged changes)
   * @returns Diff output as string
   */
  async getDiff(options?: string[]): Promise<string> {
    return await this.git.diff(options);
  }
}
