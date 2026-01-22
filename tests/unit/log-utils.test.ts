import { describe, it } from 'node:test';
import assert from 'node:assert';
import { truncateSummary, truncateLogForJudge } from '../../src/core/orchestrator/utils/log-utils.ts';

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

  describe('truncateLogForJudge', () => {
    it('should return original log if under maxBytes', () => {
      const shortLog = 'Short log content';
      const result = truncateLogForJudge(shortLog);
      assert.strictEqual(result, shortLog);
    });

    it('should truncate log that exceeds maxBytes', () => {
      // Create a log that exceeds default 150KB
      const largeLog = 'A'.repeat(200 * 1024); // 200KB
      const result = truncateLogForJudge(largeLog);

      // Result should be smaller than original
      assert(Buffer.byteLength(result, 'utf-8') < Buffer.byteLength(largeLog, 'utf-8'));

      // Result should contain truncation marker
      assert(result.includes('truncated for Judge evaluation'));
    });

    it('should preserve header and tail sections', () => {
      const header = 'HEADER CONTENT START\n';
      const middle = 'M'.repeat(200 * 1024); // 200KB
      const tail = '\nTAIL CONTENT END';
      const largeLog = header + middle + tail;

      const result = truncateLogForJudge(largeLog);

      // Header should be preserved
      assert(result.startsWith('HEADER CONTENT'));

      // Tail should be preserved
      assert(result.endsWith('TAIL CONTENT END'));
    });

    it('should respect custom maxBytes parameter', () => {
      const log = 'X'.repeat(50 * 1024); // 50KB
      const maxBytes = 20 * 1024; // 20KB

      const result = truncateLogForJudge(log, maxBytes);

      // Result should be around maxBytes (with some overhead for truncation marker)
      const resultBytes = Buffer.byteLength(result, 'utf-8');
      assert(resultBytes < 30 * 1024, `Result ${resultBytes} should be close to maxBytes ${maxBytes}`);
    });

    it('should handle Japanese characters correctly', () => {
      // Japanese characters take 3 bytes each in UTF-8
      const japaneseLog = 'あ'.repeat(100 * 1024); // About 300KB in UTF-8
      const result = truncateLogForJudge(japaneseLog);

      // Should not corrupt multi-byte characters
      // No assertion error means no encoding issues
      assert(typeof result === 'string');
      assert(result.includes('truncated for Judge evaluation'));
    });
  });
});
