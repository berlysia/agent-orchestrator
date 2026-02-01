/**
 * GitHub Issue Fetcher (ADR-029)
 *
 * gh CLIを使用してGitHub Issueの情報を取得する。
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr, isErr } from 'option-t/plain_result';
import type { GitHubError, GitHubCliError } from '../../types/errors.ts';
import {
  githubNotFound,
  githubRateLimited,
  githubUnknownError,
} from '../../types/errors.ts';
import type { IssueRef, ParsedIssue } from '../../types/github-issue.ts';
import { ParsedIssueSchema } from '../../types/github-issue.ts';
import { checkGhCli } from './cli-check.ts';

const execAsync = promisify(exec);

/**
 * gh CLIコマンドを実行してIssue情報を取得
 */
async function executeGhIssueView(
  issueNumber: number,
  repo?: { owner: string; repo: string },
): Promise<Result<string, GitHubError>> {
  const repoArg = repo ? `-R ${repo.owner}/${repo.repo}` : '';
  const fields = 'number,title,body,labels,assignees,milestone,state,url,comments,createdAt,updatedAt';
  const command = `gh issue view ${issueNumber} ${repoArg} --json ${fields}`;

  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: 30000, // 30秒タイムアウト
    });

    if (stderr && stderr.includes('rate limit')) {
      return createErr(githubRateLimited('GitHub API rate limit exceeded'));
    }

    return createOk(stdout);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (errorMessage.includes('Could not resolve') || errorMessage.includes('not found')) {
      return createErr(githubNotFound('pullRequest', `Issue #${issueNumber} not found`));
    }

    if (errorMessage.includes('rate limit')) {
      return createErr(githubRateLimited('GitHub API rate limit exceeded'));
    }

    return createErr(githubUnknownError(`Failed to fetch issue: ${errorMessage}`));
  }
}

/**
 * JSON出力をParsedIssueに変換
 */
function parseIssueJson(json: string): Result<ParsedIssue, GitHubError> {
  try {
    const raw = JSON.parse(json);
    const parsed = ParsedIssueSchema.parse(raw);
    return createOk(parsed);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return createErr(githubUnknownError(`Failed to parse issue response: ${errorMessage}`));
  }
}

/**
 * GitHub Issueを取得
 *
 * @param ref Issue参照（#123, owner/repo#123, URL形式）
 * @returns パース済みIssue情報またはエラー
 */
export async function fetchIssue(
  ref: IssueRef,
): Promise<Result<ParsedIssue, GitHubError | GitHubCliError>> {
  // gh CLIの確認
  const cliCheck = await checkGhCli();
  if (isErr(cliCheck)) {
    return cliCheck;
  }

  // Issue取得
  const repo = ref.type === 'url' ? { owner: ref.owner, repo: ref.repo } : undefined;
  const jsonResult = await executeGhIssueView(ref.number, repo);
  if (isErr(jsonResult)) {
    return jsonResult;
  }

  // パース
  return parseIssueJson(jsonResult.val);
}

/**
 * Issueのコメントのみを取得（詳細取得用）
 */
export async function fetchIssueComments(
  ref: IssueRef,
  limit: number = 50,
): Promise<Result<ParsedIssue['comments'], GitHubError | GitHubCliError>> {
  const issueResult = await fetchIssue(ref);
  if (isErr(issueResult)) {
    return issueResult;
  }

  // 最新のコメントをlimit件まで取得
  const comments = issueResult.val.comments.slice(-limit);
  return createOk(comments);
}

/**
 * 現在のリポジトリ情報を取得
 */
export async function getCurrentRepo(): Promise<
  Result<{ owner: string; repo: string }, GitHubError>
> {
  try {
    const { stdout } = await execAsync('gh repo view --json owner,name');
    const parsed = JSON.parse(stdout);
    return createOk({
      owner: parsed.owner.login,
      repo: parsed.name,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return createErr(githubUnknownError(`Failed to get current repo: ${errorMessage}`));
  }
}
