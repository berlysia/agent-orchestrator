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
