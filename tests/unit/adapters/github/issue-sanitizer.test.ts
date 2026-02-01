/**
 * Issue Sanitizer Unit Tests (ADR-029)
 */

import { test } from 'node:test';
import assert from 'node:assert';
import {
  sanitizeIssueContent,
  sanitizeIssueTitle,
  sanitizeAndFormatComments,
} from '../../../../src/adapters/github/issue-sanitizer.ts';

test('sanitizeIssueContent: basic sanitization', async (t) => {
  await t.test('should preserve normal markdown content', () => {
    const content = '## Feature Request\n\nPlease add feature X.';
    const result = sanitizeIssueContent(content);
    assert.ok(result.includes('Feature Request'));
    assert.ok(result.includes('Please add feature X'));
  });

  await t.test('should add content markers when enabled', () => {
    const content = 'Some content';
    const result = sanitizeIssueContent(content, { addContentMarkers: true });
    assert.ok(result.includes('ISSUE CONTENT START'));
    assert.ok(result.includes('ISSUE CONTENT END'));
  });

  await t.test('should not add markers when disabled', () => {
    const content = 'Some content';
    const result = sanitizeIssueContent(content, { addContentMarkers: false });
    assert.ok(!result.includes('ISSUE CONTENT START'));
  });

  await t.test('should wrap dangerous commands with warnings', () => {
    const contentWithDanger = 'Please run: sudo rm -rf /';
    const result = sanitizeIssueContent(contentWithDanger);
    // Should add warning markers to dangerous patterns
    assert.ok(result.includes('[WARNING: potentially dangerous]'));
  });

  await t.test('should limit content length', () => {
    const longContent = 'A'.repeat(100000);
    const result = sanitizeIssueContent(longContent, { maxLength: 1000 });
    // Allow overhead for markers and truncation message
    assert.ok(result.length <= 1200);
    assert.ok(result.includes('[Content truncated'));
  });
});

test('sanitizeIssueTitle: title sanitization', async (t) => {
  await t.test('should preserve normal title', () => {
    const result = sanitizeIssueTitle('Add new feature');
    assert.strictEqual(result, 'Add new feature');
  });

  await t.test('should truncate long titles', () => {
    const longTitle = 'A'.repeat(200);
    const result = sanitizeIssueTitle(longTitle, 50);
    assert.ok(result.length <= 53); // 50 + "..."
  });

  await t.test('should remove newlines', () => {
    const titleWithNewline = 'Title\nwith\nnewlines';
    const result = sanitizeIssueTitle(titleWithNewline);
    assert.ok(!result.includes('\n'));
  });

  await t.test('should handle empty title', () => {
    const result = sanitizeIssueTitle('');
    assert.strictEqual(result, '');
  });
});

test('sanitizeAndFormatComments: comment formatting', async (t) => {
  await t.test('should format single comment', () => {
    const comments = [
      { author: 'user1', body: 'Great idea!', createdAt: '2024-01-01T00:00:00Z' },
    ];
    const result = sanitizeAndFormatComments(comments);
    assert.ok(result.includes('user1'));
    assert.ok(result.includes('Great idea!'));
  });

  await t.test('should format multiple comments', () => {
    const comments = [
      { author: 'user1', body: 'Comment 1', createdAt: '2024-01-01T00:00:00Z' },
      { author: 'user2', body: 'Comment 2', createdAt: '2024-01-02T00:00:00Z' },
    ];
    const result = sanitizeAndFormatComments(comments);
    assert.ok(result.includes('user1'));
    assert.ok(result.includes('user2'));
    assert.ok(result.includes('Comment 1'));
    assert.ok(result.includes('Comment 2'));
  });

  await t.test('should limit number of comments', () => {
    const comments = Array.from({ length: 20 }, (_, i) => ({
      author: `user${i}`,
      body: `Comment ${i}`,
      createdAt: '2024-01-01T00:00:00Z',
    }));
    const result = sanitizeAndFormatComments(comments, 5);
    // Should only include 5 comments (latest ones)
    assert.ok(result.includes('user15')); // Later comments
    assert.ok(!result.includes('user0')); // Earlier comments should be excluded
  });

  await t.test('should handle empty comments array', () => {
    const result = sanitizeAndFormatComments([]);
    assert.ok(result === '' || result.includes('No comments'));
  });
});
