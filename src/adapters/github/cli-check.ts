/**
 * GitHub CLI Check (ADR-029)
 *
 * gh CLIのインストール状態と認証状態を確認する。
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr } from 'option-t/plain_result';
import type { GitHubCliError } from '../../types/errors.ts';
import { ghCliNotInstalled, ghCliNotAuthenticated } from '../../types/errors.ts';

const execAsync = promisify(exec);

/**
 * gh CLIがインストールされているか確認
 *
 * @returns インストール済みならtrue
 */
async function isGhInstalled(): Promise<boolean> {
  try {
    await execAsync('which gh');
    return true;
  } catch {
    // whichが失敗 = ghが見つからない
    return false;
  }
}

/**
 * gh CLIが認証済みか確認
 *
 * @returns 認証済みならtrue
 */
async function isGhAuthenticated(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('gh auth status 2>&1');
    // "Logged in to github.com" が含まれていれば認証済み
    return stdout.includes('Logged in to');
  } catch {
    // auth statusが失敗 = 認証されていない
    return false;
  }
}

/**
 * gh CLIの状態を確認
 *
 * インストールされており、認証済みであることを確認する。
 *
 * @returns 成功時はvoid、失敗時はGitHubCliError
 */
export async function checkGhCli(): Promise<Result<void, GitHubCliError>> {
  // インストール確認
  const installed = await isGhInstalled();
  if (!installed) {
    return createErr(ghCliNotInstalled());
  }

  // 認証確認
  const authenticated = await isGhAuthenticated();
  if (!authenticated) {
    return createErr(ghCliNotAuthenticated());
  }

  return createOk(undefined);
}

/**
 * gh CLIの詳細な状態情報を取得
 *
 * @returns インストール・認証の状態情報
 */
export async function getGhCliStatus(): Promise<{
  installed: boolean;
  authenticated: boolean;
  version?: string;
  user?: string;
}> {
  const installed = await isGhInstalled();
  if (!installed) {
    return { installed: false, authenticated: false };
  }

  let version: string | undefined;
  try {
    const { stdout } = await execAsync('gh version');
    const match = stdout.match(/gh version ([\d.]+)/);
    if (match) {
      version = match[1];
    }
  } catch {
    // バージョン取得失敗は無視
  }

  const authenticated = await isGhAuthenticated();
  if (!authenticated) {
    return { installed: true, authenticated: false, version };
  }

  let user: string | undefined;
  try {
    const { stdout } = await execAsync('gh api user -q .login');
    user = stdout.trim();
  } catch {
    // ユーザー取得失敗は無視
  }

  return { installed: true, authenticated: true, version, user };
}
