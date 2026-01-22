import { Octokit } from '@octokit/rest';
import type { GitHubConfig } from '../../types/config.ts';
import { createErr, createOk, type Result } from 'option-t/plain_result';
import { githubAuthFailed, type GitHubError } from '../../types/errors.ts';

export function createGitHubClient(config: GitHubConfig): Result<Octokit, GitHubError> {
  const token = process.env[config.auth.tokenEnvName];
  if (!token) {
    return createErr(
      githubAuthFailed(
        `環境変数 ${config.auth.tokenEnvName} が設定されていません`,
        config.auth.tokenEnvName,
      ),
    );
  }

  const octokit = new Octokit({
    auth: token,
    baseUrl: config.apiBaseUrl,
  });

  return createOk(octokit);
}
