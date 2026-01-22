/**
 * GitHub API Error Classification
 *
 * Octokit RequestErrorをドメインエラー型に変換するユーティリティ関数。
 * HTTPステータスコードに基づいてエラーを分類し、適切なGitHubError型を返す。
 */

import {
  githubAuthFailed,
  githubRateLimited,
  githubNotFound,
  githubValidationError,
  githubUnknownError,
  type GitHubError,
} from '../../types/errors.ts';

/**
 * Octokit RequestError型ガード
 */
interface RequestError {
  status: number;
  message: string;
  response?: {
    headers?: {
      'x-ratelimit-reset'?: string;
      'x-ratelimit-remaining'?: string;
    };
  };
}

function isRequestError(error: unknown): error is RequestError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
  );
}

/**
 * OctokitのエラーをGitHubErrorに分類する
 *
 * @param error - Octokitから投げられたエラー
 * @returns 分類されたGitHubError
 */
export function classifyGitHubError(error: unknown): GitHubError {
  if (!isRequestError(error)) {
    // 型不明のエラー
    return githubUnknownError(String(error));
  }

  const statusCode = error.status;
  const message = error.message || `HTTP ${statusCode} error`;

  switch (statusCode) {
    case 401:
    case 403:
      // 認証エラー
      return githubAuthFailed(message);

    case 429: {
      // レート制限エラー
      const resetAt = error.response?.headers?.['x-ratelimit-reset']
        ? parseInt(error.response.headers['x-ratelimit-reset'], 10)
        : undefined;
      const remaining = error.response?.headers?.['x-ratelimit-remaining']
        ? parseInt(error.response.headers['x-ratelimit-remaining'], 10)
        : undefined;
      return githubRateLimited(message, resetAt, remaining);
    }

    case 404:
      // リソース未発見エラー
      return githubNotFound('repository', message);

    case 422:
      // バリデーションエラー
      return githubValidationError(message);

    default:
      // その他のエラー
      return githubUnknownError(message, statusCode, JSON.stringify(error));
  }
}
