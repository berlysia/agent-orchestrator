/**
 * GitHub Issue Actions (ADR-029)
 *
 * Issueへのアクション（コメント投稿、ラベル更新）を実行する。
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr, isErr } from 'option-t/plain_result';
import type { GitHubError, GitHubCliError } from '../../types/errors.ts';
import { githubUnknownError } from '../../types/errors.ts';
import type { IssueRef } from '../../types/github-issue.ts';
import { checkGhCli } from './cli-check.ts';

const execAsync = promisify(exec);

/**
 * Issue参照からリポジトリ引数を生成
 */
function getRepoArg(ref: IssueRef): string {
  return ref.type === 'url' ? `-R ${ref.owner}/${ref.repo}` : '';
}

/**
 * Issueにコメントを投稿
 *
 * @param ref Issue参照
 * @param body コメント本文
 * @returns 成功時はコメントURL、失敗時はエラー
 */
export async function postIssueComment(
  ref: IssueRef,
  body: string,
): Promise<Result<string, GitHubError | GitHubCliError>> {
  // gh CLIの確認
  const cliCheck = await checkGhCli();
  if (isErr(cliCheck)) {
    return cliCheck;
  }

  const repoArg = getRepoArg(ref);
  const command = `gh issue comment ${ref.number} ${repoArg} --body ${JSON.stringify(body)}`;

  try {
    const { stdout } = await execAsync(command, {
      timeout: 30000,
    });

    // gh issue comment はコメントURLを出力する
    const commentUrl = stdout.trim() || `Issue #${ref.number} comment posted`;
    return createOk(commentUrl);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return createErr(githubUnknownError(`Failed to post comment: ${errorMessage}`));
  }
}

/**
 * Issueのラベルを追加
 *
 * @param ref Issue参照
 * @param labels 追加するラベル
 */
export async function addIssueLabels(
  ref: IssueRef,
  labels: string[],
): Promise<Result<void, GitHubError | GitHubCliError>> {
  if (labels.length === 0) {
    return createOk(undefined);
  }

  const cliCheck = await checkGhCli();
  if (isErr(cliCheck)) {
    return cliCheck;
  }

  const repoArg = getRepoArg(ref);
  const labelsArg = labels.map((l) => `--add-label ${JSON.stringify(l)}`).join(' ');
  const command = `gh issue edit ${ref.number} ${repoArg} ${labelsArg}`;

  try {
    await execAsync(command, { timeout: 30000 });
    return createOk(undefined);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return createErr(githubUnknownError(`Failed to add labels: ${errorMessage}`));
  }
}

/**
 * Issueのラベルを削除
 *
 * @param ref Issue参照
 * @param labels 削除するラベル
 */
export async function removeIssueLabels(
  ref: IssueRef,
  labels: string[],
): Promise<Result<void, GitHubError | GitHubCliError>> {
  if (labels.length === 0) {
    return createOk(undefined);
  }

  const cliCheck = await checkGhCli();
  if (isErr(cliCheck)) {
    return cliCheck;
  }

  const repoArg = getRepoArg(ref);
  const labelsArg = labels.map((l) => `--remove-label ${JSON.stringify(l)}`).join(' ');
  const command = `gh issue edit ${ref.number} ${repoArg} ${labelsArg}`;

  try {
    await execAsync(command, { timeout: 30000 });
    return createOk(undefined);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return createErr(githubUnknownError(`Failed to remove labels: ${errorMessage}`));
  }
}

/**
 * Issueのラベルを更新（追加と削除を同時に実行）
 *
 * @param ref Issue参照
 * @param add 追加するラベル
 * @param remove 削除するラベル
 */
export async function updateIssueLabels(
  ref: IssueRef,
  add: string[],
  remove: string[],
): Promise<Result<void, GitHubError | GitHubCliError>> {
  if (add.length === 0 && remove.length === 0) {
    return createOk(undefined);
  }

  const cliCheck = await checkGhCli();
  if (isErr(cliCheck)) {
    return cliCheck;
  }

  const repoArg = getRepoArg(ref);
  const addArgs = add.map((l) => `--add-label ${JSON.stringify(l)}`).join(' ');
  const removeArgs = remove.map((l) => `--remove-label ${JSON.stringify(l)}`).join(' ');
  const command = `gh issue edit ${ref.number} ${repoArg} ${addArgs} ${removeArgs}`.trim();

  try {
    await execAsync(command, { timeout: 30000 });
    return createOk(undefined);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return createErr(githubUnknownError(`Failed to update labels: ${errorMessage}`));
  }
}

/**
 * タスク完了時のIssueアクションを実行
 *
 * @param ref Issue参照
 * @param summary 完了サマリー
 * @param options オプション設定
 */
export async function executeCompletionActions(
  ref: IssueRef,
  summary: string,
  options: {
    commentOnIssue?: boolean;
    updateLabels?: {
      add?: string[];
      remove?: string[];
    };
  } = {},
): Promise<Result<void, GitHubError | GitHubCliError>> {
  const errors: string[] = [];

  // コメント投稿
  if (options.commentOnIssue) {
    const commentResult = await postIssueComment(ref, summary);
    if (isErr(commentResult)) {
      errors.push(`Comment: ${commentResult.err.message}`);
    }
  }

  // ラベル更新
  if (options.updateLabels) {
    const labelResult = await updateIssueLabels(
      ref,
      options.updateLabels.add ?? [],
      options.updateLabels.remove ?? [],
    );
    if (isErr(labelResult)) {
      errors.push(`Labels: ${labelResult.err.message}`);
    }
  }

  if (errors.length > 0) {
    return createErr(githubUnknownError(`Completion actions failed: ${errors.join('; ')}`));
  }

  return createOk(undefined);
}
