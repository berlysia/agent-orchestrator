/**
 * GitHub Error Classification Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { classifyGitHubError } from './error.ts';

describe('classifyGitHubError', () => {
  it('should classify 401 as GitHubAuthFailedError', () => {
    const error = {
      status: 401,
      message: 'Unauthorized',
    };

    const result = classifyGitHubError(error);

    assert.strictEqual(result.type, 'GitHubAuthFailedError');
    assert.strictEqual(result.message, 'Unauthorized');
  });

  it('should classify 403 as GitHubAuthFailedError', () => {
    const error = {
      status: 403,
      message: 'Forbidden',
    };

    const result = classifyGitHubError(error);

    assert.strictEqual(result.type, 'GitHubAuthFailedError');
    assert.strictEqual(result.message, 'Forbidden');
  });

  it('should classify 429 as GitHubRateLimitedError', () => {
    const error = {
      status: 429,
      message: 'Rate limit exceeded',
      response: {
        headers: {
          'x-ratelimit-reset': '1640000000',
          'x-ratelimit-remaining': '0',
        },
      },
    };

    const result = classifyGitHubError(error);

    assert.strictEqual(result.type, 'GitHubRateLimitedError');
    assert.strictEqual(result.message, 'Rate limit exceeded');
    if (result.type === 'GitHubRateLimitedError') {
      assert.strictEqual(result.resetAt, 1640000000);
      assert.strictEqual(result.remaining, 0);
    }
  });

  it('should classify 429 without headers as GitHubRateLimitedError', () => {
    const error = {
      status: 429,
      message: 'Rate limit exceeded',
    };

    const result = classifyGitHubError(error);

    assert.strictEqual(result.type, 'GitHubRateLimitedError');
    assert.strictEqual(result.message, 'Rate limit exceeded');
    if (result.type === 'GitHubRateLimitedError') {
      assert.strictEqual(result.resetAt, undefined);
      assert.strictEqual(result.remaining, undefined);
    }
  });

  it('should classify 404 as GitHubNotFoundError', () => {
    const error = {
      status: 404,
      message: 'Not Found',
    };

    const result = classifyGitHubError(error);

    assert.strictEqual(result.type, 'GitHubNotFoundError');
    assert.strictEqual(result.message, 'Not Found');
    if (result.type === 'GitHubNotFoundError') {
      assert.strictEqual(result.resourceType, 'repository');
    }
  });

  it('should classify 422 as GitHubValidationError', () => {
    const error = {
      status: 422,
      message: 'Validation failed',
    };

    const result = classifyGitHubError(error);

    assert.strictEqual(result.type, 'GitHubValidationError');
    assert.strictEqual(result.message, 'Validation failed');
  });

  it('should classify 500 as GitHubUnknownError', () => {
    const error = {
      status: 500,
      message: 'Internal Server Error',
    };

    const result = classifyGitHubError(error);

    assert.strictEqual(result.type, 'GitHubUnknownError');
    assert.strictEqual(result.message, 'Internal Server Error');
    if (result.type === 'GitHubUnknownError') {
      assert.strictEqual(result.statusCode, 500);
    }
  });

  it('should classify unknown error type as GitHubUnknownError', () => {
    const error = new Error('Something went wrong');

    const result = classifyGitHubError(error);

    assert.strictEqual(result.type, 'GitHubUnknownError');
    assert.match(result.message, /Error: Something went wrong/);
  });

  it('should handle string error as GitHubUnknownError', () => {
    const error = 'Simple error string';

    const result = classifyGitHubError(error);

    assert.strictEqual(result.type, 'GitHubUnknownError');
    assert.strictEqual(result.message, 'Simple error string');
  });

  it('should handle null as GitHubUnknownError', () => {
    const error = null;

    const result = classifyGitHubError(error);

    assert.strictEqual(result.type, 'GitHubUnknownError');
    assert.strictEqual(result.message, 'null');
  });

  it('should use default message when message is missing', () => {
    const error = {
      status: 500,
    };

    const result = classifyGitHubError(error);

    assert.strictEqual(result.type, 'GitHubUnknownError');
    assert.strictEqual(result.message, 'HTTP 500 error');
  });
});
