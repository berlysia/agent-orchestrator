/**
 * GitHub Pull Request API Adapter
 *
 * GitHub APIを使用してPull Requestを作成する機能を提供する。
 * Octokitを利用し、エラーハンドリングを適切に行う。
 */

import type { Octokit } from '@octokit/rest';
import type { CreatePullRequestInput, PullRequest } from '../../types/github.ts';
import { createErr, createOk, type Result } from 'option-t/plain_result';
import type { GitHubError } from '../../types/errors.ts';
import { classifyGitHubError } from './error.ts';
import type { SourceIssue } from '../../types/github-issue.ts';

/**
 * Issue参照キーワード
 */
export type IssueCloseKeyword = 'Closes' | 'Fixes' | 'Resolves';

/**
 * PR本文にIssue参照を追加
 *
 * @param body 元のPR本文
 * @param sourceIssue ソースIssue情報
 * @param keyword クローズキーワード（デフォルト: Closes）
 * @returns Issue参照を追加したPR本文
 */
export function appendIssueReference(
  body: string,
  sourceIssue: SourceIssue,
  keyword: IssueCloseKeyword = 'Closes',
): string {
  const issueRef =
    sourceIssue.owner && sourceIssue.repo
      ? `${sourceIssue.owner}/${sourceIssue.repo}#${sourceIssue.number}`
      : `#${sourceIssue.number}`;

  const reference = `${keyword} ${issueRef}`;

  // 既にIssue参照が含まれている場合は追加しない
  if (body.includes(reference)) {
    return body;
  }

  // 本文の最後に参照を追加
  const separator = body.trim() ? '\n\n' : '';
  return `${body}${separator}${reference}`;
}

/**
 * 複数のIssue参照をPR本文に追加
 *
 * @param body 元のPR本文
 * @param sourceIssues ソースIssue情報の配列
 * @param keyword クローズキーワード（デフォルト: Closes）
 * @returns Issue参照を追加したPR本文
 */
export function appendMultipleIssueReferences(
  body: string,
  sourceIssues: SourceIssue[],
  keyword: IssueCloseKeyword = 'Closes',
): string {
  let result = body;
  for (const issue of sourceIssues) {
    result = appendIssueReference(result, issue, keyword);
  }
  return result;
}

/**
 * GitHub Pull Requestを作成する
 *
 * @param octokit - Octokitインスタンス
 * @param input - PR作成に必要な情報
 * @returns 成功時はPullRequest、失敗時はGitHubError
 */
export async function createPullRequest(
  octokit: Octokit,
  input: CreatePullRequestInput,
): Promise<Result<PullRequest, GitHubError>> {
  try {
    const response = await octokit.rest.pulls.create({
      owner: input.config.owner,
      repo: input.config.repo,
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      draft: input.draft ?? false,
    });

    const data = response.data;
    const pullRequest: PullRequest = {
      id: data.id,
      number: data.number,
      url: data.html_url,
      state: data.state as 'open' | 'closed',
      headRef: data.head.ref,
      baseRef: data.base.ref,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };

    return createOk(pullRequest);
  } catch (error) {
    return createErr(classifyGitHubError(error));
  }
}
