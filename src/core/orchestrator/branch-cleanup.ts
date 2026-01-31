/**
 * Branch Cleanup Operations
 *
 * ADR-019: ブランチクリーンアップ機能
 *
 * オーケストレーションで作成されたブランチのクリーンアップ機能を提供。
 * - 統合ブランチ（integration/*）
 * - タスクブランチ
 */

import type { GitEffects } from '../../adapters/vcs/git-effects.ts';
import type { RepoPath } from '../../types/branded.ts';
import { branchName } from '../../types/branded.ts';
import { isErr, isOk } from 'option-t/plain_result';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr } from 'option-t/plain_result';

/**
 * 保護ブランチのリスト
 *
 * これらのブランチは削除対象から除外される
 */
export const PROTECTED_BRANCHES = [
  'main',
  'master',
  'develop',
  'development',
  'production',
  'staging',
] as const;

/**
 * 保護ブランチパターン（正規表現）
 */
export const PROTECTED_BRANCH_PATTERNS = [
  /^release\/.*/,
  /^hotfix\/.*/,
] as const;

/**
 * デフォルトの削除対象パターン
 */
export const DEFAULT_CLEANUP_PATTERNS = {
  /** 統合ブランチ */
  integration: /^integration\//,
  /** タスクブランチ（タスクID形式） */
  task: /^[a-z]+-[a-zA-Z0-9]{8,}$/,
} as const;

/**
 * ブランチ情報（クリーンアップ用）
 */
export interface CleanupBranchInfo {
  name: string;
  isMerged: boolean;
  category: 'integration' | 'task' | 'unknown';
}

/**
 * クリーンアップ結果
 */
export interface CleanupResult {
  /** 削除されたローカルブランチ */
  deletedLocal: string[];
  /** 削除されたリモートブランチ */
  deletedRemote: string[];
  /** スキップされたブランチ */
  skipped: Array<{ name: string; reason: string }>;
  /** エラー */
  errors: Array<{ name: string; error: string }>;
}

/**
 * クリーンアップオプション
 */
export interface CleanupOptions {
  /** 実際に削除を実行するか（falseの場合はdry-run） */
  execute: boolean;
  /** 統合ブランチのみ対象 */
  integrationOnly?: boolean;
  /** タスクブランチのみ対象 */
  taskOnly?: boolean;
  /** リモートブランチも削除 */
  deleteRemote?: boolean;
  /** 追加のパターン（glob形式） */
  additionalPatterns?: string[];
  /** 対象ブランチ名を指定（パターンマッチングをスキップ） */
  targetBranches?: string[];
}

/**
 * ブランチが保護されているかチェック
 */
export function isProtectedBranch(name: string): boolean {
  // 完全一致チェック
  if (PROTECTED_BRANCHES.includes(name as (typeof PROTECTED_BRANCHES)[number])) {
    return true;
  }

  // パターンマッチ
  for (const pattern of PROTECTED_BRANCH_PATTERNS) {
    if (pattern.test(name)) {
      return true;
    }
  }

  return false;
}

/**
 * ブランチのカテゴリを判定
 */
export function getBranchCategory(name: string): 'integration' | 'task' | 'unknown' {
  if (DEFAULT_CLEANUP_PATTERNS.integration.test(name)) {
    return 'integration';
  }
  if (DEFAULT_CLEANUP_PATTERNS.task.test(name)) {
    return 'task';
  }
  return 'unknown';
}

/**
 * ブランチがマージ済みかチェック（rawコマンド使用）
 */
async function isBranchMerged(
  gitEffects: GitEffects,
  repo: RepoPath,
  branchToCheck: string,
  baseBranch: string,
): Promise<boolean> {
  if (!gitEffects.raw) {
    // rawメソッドがない場合はfalseを返す（削除時に強制オプションを使う）
    return false;
  }

  const result = await gitEffects.raw(repo, [
    'branch',
    '--merged',
    baseBranch,
  ]);

  if (isErr(result)) {
    return false;
  }

  // ブランチ名が含まれているかチェック
  const mergedBranches = result.val.split('\n').map((line) =>
    line.replace(/^\*?\s*/, '').trim()
  );

  return mergedBranches.includes(branchToCheck);
}

/**
 * リモートブランチを削除（rawコマンド使用）
 */
async function deleteRemoteBranch(
  gitEffects: GitEffects,
  repo: RepoPath,
  branchToDelete: string,
  remote = 'origin',
): Promise<Result<void, { message: string }>> {
  if (!gitEffects.raw) {
    return createErr({ message: 'raw git command not available' });
  }

  const result = await gitEffects.raw(repo, [
    'push',
    remote,
    '--delete',
    branchToDelete,
  ]);

  if (isErr(result)) {
    return createErr({ message: String(result.err) });
  }

  return createOk(undefined);
}

/**
 * クリーンアップ対象のブランチを検出
 */
export async function detectCleanupTargets(
  gitEffects: GitEffects,
  repo: RepoPath,
  options: CleanupOptions,
): Promise<Result<CleanupBranchInfo[], { message: string }>> {
  // ブランチ一覧を取得
  const branchesResult = await gitEffects.listBranches(repo);
  if (isErr(branchesResult)) {
    return createErr({ message: `Failed to list branches: ${branchesResult.err.message}` });
  }

  const branches = branchesResult.val;
  const targets: CleanupBranchInfo[] = [];

  // ベースブランチを取得（マージ済み判定用）
  const baseBranchResult = await gitEffects.getCurrentBranch(repo);
  const baseBranch = isOk(baseBranchResult) ? String(baseBranchResult.val) : 'main';

  for (const branch of branches) {
    const name = String(branch.name);

    // 保護ブランチはスキップ
    if (isProtectedBranch(name)) {
      continue;
    }

    // 特定のブランチが指定されている場合
    if (options.targetBranches && options.targetBranches.length > 0) {
      if (!options.targetBranches.includes(name)) {
        continue;
      }
    } else {
      // パターンマッチング
      const category = getBranchCategory(name);

      // カテゴリフィルタ
      if (options.integrationOnly && category !== 'integration') {
        continue;
      }
      if (options.taskOnly && category !== 'task') {
        continue;
      }

      // unknownカテゴリはデフォルトでスキップ
      if (category === 'unknown' && !options.additionalPatterns) {
        continue;
      }

      // 追加パターンのチェック
      if (category === 'unknown' && options.additionalPatterns) {
        const matched = options.additionalPatterns.some((pattern) => {
          const regex = globToRegex(pattern);
          return regex.test(name);
        });
        if (!matched) {
          continue;
        }
      }
    }

    // マージ済みかチェック
    const merged = await isBranchMerged(gitEffects, repo, name, baseBranch);

    targets.push({
      name,
      isMerged: merged,
      category: getBranchCategory(name),
    });
  }

  return createOk(targets);
}

/**
 * ブランチをクリーンアップ
 */
export async function cleanupBranches(
  gitEffects: GitEffects,
  repo: RepoPath,
  targets: CleanupBranchInfo[],
  options: CleanupOptions,
): Promise<CleanupResult> {
  const result: CleanupResult = {
    deletedLocal: [],
    deletedRemote: [],
    skipped: [],
    errors: [],
  };

  for (const target of targets) {
    // dry-runモードの場合はスキップ
    if (!options.execute) {
      result.skipped.push({ name: target.name, reason: 'dry-run mode' });
      continue;
    }

    // 現在のブランチは削除できない
    const currentResult = await gitEffects.getCurrentBranch(repo);
    if (isOk(currentResult) && String(currentResult.val) === target.name) {
      result.skipped.push({ name: target.name, reason: 'current branch' });
      continue;
    }

    // ローカルブランチを削除
    const force = !target.isMerged;
    const deleteResult = await gitEffects.deleteBranch(repo, branchName(target.name), force);
    if (isErr(deleteResult)) {
      result.errors.push({ name: target.name, error: deleteResult.err.message });
    } else {
      result.deletedLocal.push(target.name);
    }

    // リモートブランチを削除
    if (options.deleteRemote) {
      const deleteRemoteResult = await deleteRemoteBranch(gitEffects, repo, target.name);
      if (isErr(deleteRemoteResult)) {
        result.errors.push({ name: `origin/${target.name}`, error: deleteRemoteResult.err.message });
      } else {
        result.deletedRemote.push(target.name);
      }
    }
  }

  return result;
}

/**
 * glob パターンを正規表現に変換
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/**
 * クリーンアップ結果を表示用にフォーマット
 */
export function formatCleanupResult(result: CleanupResult, execute: boolean): string {
  const lines: string[] = [];

  if (execute) {
    if (result.deletedLocal.length > 0) {
      lines.push(`\nDeleted ${result.deletedLocal.length} local branch(es):`);
      for (const name of result.deletedLocal) {
        lines.push(`  - ${name}`);
      }
    }

    if (result.deletedRemote.length > 0) {
      lines.push(`\nDeleted ${result.deletedRemote.length} remote branch(es):`);
      for (const name of result.deletedRemote) {
        lines.push(`  - origin/${name}`);
      }
    }
  }

  if (result.skipped.length > 0) {
    lines.push(`\nSkipped ${result.skipped.length} branch(es):`);
    for (const { name, reason } of result.skipped) {
      lines.push(`  - ${name} (${reason})`);
    }
  }

  if (result.errors.length > 0) {
    lines.push(`\nErrors (${result.errors.length}):`);
    for (const { name, error } of result.errors) {
      lines.push(`  - ${name}: ${error}`);
    }
  }

  if (!execute && result.skipped.length > 0) {
    lines.push('\nRun with --execute to actually delete these branches.');
  }

  return lines.join('\n');
}

/**
 * 対象ブランチを表示用にフォーマット
 */
export function formatTargets(targets: CleanupBranchInfo[]): string {
  if (targets.length === 0) {
    return 'No branches found matching the criteria.';
  }

  const lines: string[] = [];
  lines.push(`Found ${targets.length} branch(es) to clean up:`);

  // カテゴリ別にグループ化
  const integrationBranches = targets.filter((t) => t.category === 'integration');
  const taskBranches = targets.filter((t) => t.category === 'task');
  const otherBranches = targets.filter((t) => t.category === 'unknown');

  if (integrationBranches.length > 0) {
    lines.push(`\nIntegration branches (${integrationBranches.length}):`);
    for (const branch of integrationBranches) {
      const status = branch.isMerged ? '[merged]' : '[not merged]';
      lines.push(`  - ${branch.name} ${status}`);
    }
  }

  if (taskBranches.length > 0) {
    lines.push(`\nTask branches (${taskBranches.length}):`);
    for (const branch of taskBranches) {
      const status = branch.isMerged ? '[merged]' : '[not merged]';
      lines.push(`  - ${branch.name} ${status}`);
    }
  }

  if (otherBranches.length > 0) {
    lines.push(`\nOther branches (${otherBranches.length}):`);
    for (const branch of otherBranches) {
      const status = branch.isMerged ? '[merged]' : '[not merged]';
      lines.push(`  - ${branch.name} ${status}`);
    }
  }

  return lines.join('\n');
}
