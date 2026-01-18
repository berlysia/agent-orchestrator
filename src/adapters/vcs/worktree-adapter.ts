/**
 * Worktree Adapter - Manages git worktree operations
 *
 * Git worktrees are not well-supported by most Git libraries,
 * so this adapter executes git worktree commands directly via child_process.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

export interface WorktreeAdapterOptions {
  /** Base directory of the main git repository */
  baseDir: string;
}

export interface WorktreeInfo {
  /** Path to the worktree */
  path: string;
  /** Current HEAD commit */
  head: string;
  /** Branch name (or "detached HEAD") */
  branch: string;
  /** Whether this is a bare repository */
  bare?: boolean;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class WorktreeAdapter {
  private baseDir: string;

  constructor(options: WorktreeAdapterOptions) {
    this.baseDir = options.baseDir;
  }

  // ============================================
  // Git Command Execution Infrastructure
  // ============================================

  /**
   * Execute a git command and capture stdout/stderr
   * @param args - Git command arguments (e.g., ['worktree', 'list'])
   * @returns Promise with stdout, stderr, and exit code
   */
  private async executeGitCommand(args: string[]): Promise<GitCommandResult> {
    return new Promise((resolve, reject) => {
      const gitProcess = spawn('git', args, {
        cwd: this.baseDir,
        shell: false,
      });

      let stdout = '';
      let stderr = '';

      gitProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      gitProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      gitProcess.on('error', (error) => {
        reject(new Error(`Failed to execute git command: ${error.message}`));
      });

      gitProcess.on('close', (exitCode) => {
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: exitCode ?? -1,
        });
      });
    });
  }

  // ============================================
  // Worktree Operations
  // ============================================

  /**
   * List all worktrees
   * @returns Array of worktree information
   */
  async listWorktrees(): Promise<WorktreeInfo[]> {
    const result = await this.executeGitCommand(['worktree', 'list', '--porcelain']);

    if (result.exitCode !== 0) {
      throw new Error(`git worktree list failed: ${result.stderr}`);
    }

    return this.parseWorktreeList(result.stdout);
  }

  /**
   * Parse the output of `git worktree list --porcelain`
   *
   * Example output:
   * ```
   * worktree /path/to/main
   * HEAD abc123
   * branch refs/heads/main
   *
   * worktree /path/to/feature
   * HEAD def456
   * branch refs/heads/feature
   * ```
   */
  private parseWorktreeList(output: string): WorktreeInfo[] {
    if (!output) {
      return [];
    }

    const worktrees: WorktreeInfo[] = [];
    const entries = output.split('\n\n');

    for (const entry of entries) {
      const lines = entry.split('\n').filter((line) => line.trim());
      if (lines.length === 0) continue;

      const worktreeInfo: Partial<WorktreeInfo> = {};

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          worktreeInfo.path = line.substring('worktree '.length);
        } else if (line.startsWith('HEAD ')) {
          worktreeInfo.head = line.substring('HEAD '.length);
        } else if (line.startsWith('branch ')) {
          const branchRef = line.substring('branch '.length);
          // Extract branch name from refs/heads/branch-name
          worktreeInfo.branch = branchRef.replace('refs/heads/', '');
        } else if (line.startsWith('detached')) {
          worktreeInfo.branch = 'detached HEAD';
        } else if (line.startsWith('bare')) {
          worktreeInfo.bare = true;
        }
      }

      if (worktreeInfo.path && worktreeInfo.head && worktreeInfo.branch) {
        worktrees.push(worktreeInfo as WorktreeInfo);
      }
    }

    return worktrees;
  }

  /**
   * Create a new worktree
   * @param name - Name for the worktree directory (will be placed in .git/worktree/<name>)
   * @param branch - Branch name to checkout in the new worktree
   * @param createBranch - Whether to create a new branch (default: false)
   * @returns Path to the created worktree
   */
  async createWorktree(name: string, branch: string, createBranch = false): Promise<string> {
    const worktreePath = join(this.baseDir, '.git', 'worktree', name);
    const args = ['worktree', 'add'];

    if (createBranch) {
      args.push('-b', branch);
    }

    args.push(worktreePath);

    if (!createBranch) {
      args.push(branch);
    }

    const result = await this.executeGitCommand(args);

    if (result.exitCode !== 0) {
      throw new Error(`git worktree add failed: ${result.stderr}`);
    }

    return worktreePath;
  }

  /**
   * Remove a worktree
   * @param name - Name of the worktree to remove (as used in createWorktree)
   * @param force - Force removal even if worktree has uncommitted changes
   */
  async removeWorktree(name: string, force = false): Promise<void> {
    const worktreePath = join(this.baseDir, '.git', 'worktree', name);
    const args = ['worktree', 'remove'];

    if (force) {
      args.push('--force');
    }

    args.push(worktreePath);

    const result = await this.executeGitCommand(args);

    if (result.exitCode !== 0) {
      throw new Error(`git worktree remove failed: ${result.stderr}`);
    }
  }

  /**
   * Prune stale worktree administrative files
   */
  async pruneWorktrees(): Promise<void> {
    const result = await this.executeGitCommand(['worktree', 'prune']);

    if (result.exitCode !== 0) {
      throw new Error(`git worktree prune failed: ${result.stderr}`);
    }
  }

  // ============================================
  // Worktree Naming Conventions (Project-specific)
  // ============================================

  /**
   * Generate worktree name for a worker task
   * Convention: impl/<taskId>
   * @param taskId - Task identifier
   * @returns Worktree name
   */
  static getWorkerWorktreeName(taskId: string): string {
    return `impl/${taskId}`;
  }

  /**
   * Generate worktree name for the planner
   * Convention: planner
   * @returns Worktree name
   */
  static getPlannerWorktreeName(): string {
    return 'planner';
  }

  /**
   * Generate worktree name for the judge
   * Convention: judge
   * @returns Worktree name
   */
  static getJudgeWorktreeName(): string {
    return 'judge';
  }

  /**
   * Create a worktree for a worker task
   * Follows the convention: 1 task = 1 branch = 1 worktree
   *
   * @param taskId - Task identifier
   * @param branchName - Branch name for the task
   * @param createBranch - Whether to create a new branch (default: true)
   * @returns Path to the created worktree
   */
  async createWorkerWorktree(
    taskId: string,
    branchName: string,
    createBranch = true,
  ): Promise<string> {
    const worktreeName = WorktreeAdapter.getWorkerWorktreeName(taskId);
    return await this.createWorktree(worktreeName, branchName, createBranch);
  }

  /**
   * Create a worktree for the planner
   *
   * @param branchName - Branch name for the planner (typically main/master)
   * @returns Path to the created worktree
   */
  async createPlannerWorktree(branchName: string): Promise<string> {
    const worktreeName = WorktreeAdapter.getPlannerWorktreeName();
    return await this.createWorktree(worktreeName, branchName, false);
  }

  /**
   * Create a worktree for the judge
   *
   * @param branchName - Branch name to review
   * @returns Path to the created worktree
   */
  async createJudgeWorktree(branchName: string): Promise<string> {
    const worktreeName = WorktreeAdapter.getJudgeWorktreeName();
    return await this.createWorktree(worktreeName, branchName, false);
  }

  /**
   * Remove a worker worktree
   * @param taskId - Task identifier
   * @param force - Force removal even if worktree has uncommitted changes
   */
  async removeWorkerWorktree(taskId: string, force = false): Promise<void> {
    const worktreeName = WorktreeAdapter.getWorkerWorktreeName(taskId);
    await this.removeWorktree(worktreeName, force);
  }

  /**
   * Remove the planner worktree
   * @param force - Force removal even if worktree has uncommitted changes
   */
  async removePlannerWorktree(force = false): Promise<void> {
    const worktreeName = WorktreeAdapter.getPlannerWorktreeName();
    await this.removeWorktree(worktreeName, force);
  }

  /**
   * Remove the judge worktree
   * @param force - Force removal even if worktree has uncommitted changes
   */
  async removeJudgeWorktree(force = false): Promise<void> {
    const worktreeName = WorktreeAdapter.getJudgeWorktreeName();
    await this.removeWorktree(worktreeName, force);
  }
}
