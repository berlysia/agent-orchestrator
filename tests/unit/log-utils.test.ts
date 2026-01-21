import { describe, it } from 'node:test';
import assert from 'node:assert';
import { truncateSummary } from '../../src/core/orchestrator/utils/log-utils.ts';

describe('Log Utils', () => {
  describe('truncateSummary', () => {
    it('should return empty string for null', () => {
      const result = truncateSummary(null);
      assert.strictEqual(result, '');
    });

    it('should return empty string for undefined', () => {
      const result = truncateSummary(undefined);
      assert.strictEqual(result, '');
    });

    it('should return original string if length <= 30', () => {
      const summary = 'JWT認証の実装';
      const result = truncateSummary(summary);
      assert.strictEqual(result, 'JWT認証の実装');
    });

    it('should return original string for exactly 30 characters', () => {
      const summary = '1234567890123456789012345678901'; // 31 chars
      const result = truncateSummary(summary.slice(0, 30)); // 30 chars
      assert.strictEqual(result.length, 30);
      assert.strictEqual(result, summary.slice(0, 30));
    });

    it('should truncate and add "..." for strings longer than 30 characters', () => {
      const summary = 'This is a very long summary that exceeds 30 characters';
      const result = truncateSummary(summary);
      assert.strictEqual(result, 'This is a very long summary th...');
      assert.strictEqual(result.length, 33); // 30 + 3 ("...")
    });

    it('should handle Japanese characters correctly', () => {
      const summary = 'これは30文字を超える非常に長いサマリのテストで、切り詰められるべき文字列です';
      const result = truncateSummary(summary);
      assert.strictEqual(result.length, 33); // 30 + 3 ("...")
      assert(result.endsWith('...'));
    });

    it('should handle mixed ASCII and Japanese characters', () => {
      const summary = 'JWT認証の実装とテスト、ドキュメント作成を含む完全な実装とAPI連携機能';
      const result = truncateSummary(summary);
      assert.strictEqual(result.length, 33);
      assert(result.endsWith('...'));
    });
  });
});
