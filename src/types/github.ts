import type { Result } from 'option-t/plain_result';
import type { GitHubConfig } from './config.ts';
import type { GitHubError } from './errors.ts';

export type CreatePullRequestInput = {
  config: GitHubConfig;
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
};

export type PullRequest = {
  readonly id: number;
  readonly number: number;
  readonly url: string;
  readonly state: 'open' | 'closed';
  readonly headRef: string;
  readonly baseRef: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export interface GitHubEffects {
  createPullRequest(input: CreatePullRequestInput): Promise<Result<PullRequest, GitHubError>>;
}
