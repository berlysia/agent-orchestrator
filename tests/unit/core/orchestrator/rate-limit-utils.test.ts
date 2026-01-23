import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  getErrorCause,
  isRateLimited,
  getRetryAfterSeconds,
} from '../../../../src/core/orchestrator/utils/rate-limit-utils.ts';

describe('Rate Limit Utils', () => {
  describe('getErrorCause', () => {
    it('should return cause if present', () => {
      const cause = new Error('original error');
      const err = { cause, message: 'wrapped error' };

      const result = getErrorCause(err);

      assert.strictEqual(result, cause);
    });

    it('should return original error if no cause', () => {
      const err = new Error('no cause');

      const result = getErrorCause(err);

      assert.strictEqual(result, err);
    });

    it('should return original error if cause is undefined', () => {
      const err = { cause: undefined, message: 'error' };

      const result = getErrorCause(err);

      assert.strictEqual(result, err);
    });

    it('should handle null input', () => {
      const result = getErrorCause(null);

      assert.strictEqual(result, null);
    });

    it('should handle primitive input', () => {
      const result = getErrorCause('string error');

      assert.strictEqual(result, 'string error');
    });
  });

  describe('isRateLimited', () => {
    it('should detect RateLimitError by constructor name', () => {
      // RateLimitErrorのようなオブジェクトを作成
      class RateLimitError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'RateLimitError';
        }
      }
      const err = new RateLimitError('Rate limit exceeded');

      const result = isRateLimited(err);

      assert.strictEqual(result, true);
    });

    it('should detect rate limit by status 429', () => {
      const err = { status: 429, message: 'Too Many Requests' };

      const result = isRateLimited(err);

      assert.strictEqual(result, true);
    });

    it('should detect rate limit by statusCode 429', () => {
      const err = { statusCode: 429, message: 'Too Many Requests' };

      const result = isRateLimited(err);

      assert.strictEqual(result, true);
    });

    it('should detect rate limit by response.status 429', () => {
      const err = { response: { status: 429 }, message: 'Too Many Requests' };

      const result = isRateLimited(err);

      assert.strictEqual(result, true);
    });

    it('should detect rate limit by error.type === rate_limit_error', () => {
      const err = { error: { type: 'rate_limit_error' }, message: 'Rate limited' };

      const result = isRateLimited(err);

      assert.strictEqual(result, true);
    });

    it('should detect rate limit by type === rate_limit_error', () => {
      const err = { type: 'rate_limit_error', message: 'Rate limited' };

      const result = isRateLimited(err);

      assert.strictEqual(result, true);
    });

    it('should return false for non-rate-limit errors', () => {
      const err = { status: 500, message: 'Internal Server Error' };

      const result = isRateLimited(err);

      assert.strictEqual(result, false);
    });

    it('should check cause for rate limit', () => {
      const cause = { status: 429, message: 'Too Many Requests' };
      const err = { cause, message: 'Agent execution failed' };

      const result = isRateLimited(err);

      assert.strictEqual(result, true);
    });

    it('should return false for null', () => {
      const result = isRateLimited(null);

      assert.strictEqual(result, false);
    });

    it('should return false for undefined', () => {
      const result = isRateLimited(undefined);

      assert.strictEqual(result, false);
    });
  });

  describe('getRetryAfterSeconds', () => {
    it('should extract retry-after from headers object', () => {
      const err = {
        headers: { 'retry-after': '60' },
      };

      const result = getRetryAfterSeconds(err);

      assert.strictEqual(result, 60);
    });

    it('should extract Retry-After (capitalized) from headers', () => {
      const err = {
        headers: { 'Retry-After': '30' },
      };

      const result = getRetryAfterSeconds(err);

      assert.strictEqual(result, 30);
    });

    it('should extract retry-after from response.headers', () => {
      const err = {
        response: {
          headers: { 'retry-after': '45' },
        },
      };

      const result = getRetryAfterSeconds(err);

      assert.strictEqual(result, 45);
    });

    it('should extract retry-after from headers.get function', () => {
      const err = {
        headers: {
          get: (name: string) => (name === 'retry-after' ? '120' : null),
        },
      };

      const result = getRetryAfterSeconds(err);

      assert.strictEqual(result, 120);
    });

    it('should return undefined if no retry-after header', () => {
      const err = {
        headers: {},
      };

      const result = getRetryAfterSeconds(err);

      assert.strictEqual(result, undefined);
    });

    it('should return undefined for non-numeric retry-after', () => {
      const err = {
        headers: { 'retry-after': 'invalid' },
      };

      const result = getRetryAfterSeconds(err);

      assert.strictEqual(result, undefined);
    });

    it('should check cause for retry-after', () => {
      const cause = {
        headers: { 'retry-after': '90' },
      };
      const err = { cause, message: 'wrapped' };

      const result = getRetryAfterSeconds(err);

      assert.strictEqual(result, 90);
    });

    it('should return undefined for null', () => {
      const result = getRetryAfterSeconds(null);

      assert.strictEqual(result, undefined);
    });
  });
});
