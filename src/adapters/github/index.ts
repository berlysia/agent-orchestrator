import type { GitHubEffects } from '../../types/github.ts';
import { createGitHubClient } from './client.ts';
import { createPullRequest as createPR } from './pull-request.ts';
import { isErr } from 'option-t/plain_result';

export function createGitHubEffects(): GitHubEffects {
  return {
    async createPullRequest(input) {
      const clientResult = createGitHubClient(input.config);
      if (isErr(clientResult)) {
        return clientResult;
      }
      return createPR(clientResult.val, input);
    },
  };
}

export type { GitHubEffects } from '../../types/github.ts';
