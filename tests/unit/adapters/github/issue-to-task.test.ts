/**
 * Issue to Task Conversion Unit Tests (ADR-029)
 */

import { test } from 'node:test';
import assert from 'node:assert';
import type { ParsedIssue } from '../../../../src/types/github-issue.ts';
import {
  convertIssueToTaskContext,
  extractSourceIssue,
  inferTaskType,
  extractAcceptanceCriteria,
  generateTaskSummary,
} from '../../../../src/adapters/github/issue-to-task.ts';

const createMockIssue = (overrides: Partial<ParsedIssue> = {}): ParsedIssue => ({
  number: 123,
  title: 'Test Issue Title',
  body: 'This is the issue body.',
  labels: [],
  assignees: [],
  milestone: undefined,
  state: 'OPEN',
  url: 'https://github.com/owner/repo/issues/123',
  comments: [],
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-02T00:00:00Z',
  ...overrides,
});

test('convertIssueToTaskContext: basic conversion', async (t) => {
  await t.test('should include title', () => {
    const issue = createMockIssue();
    const result = convertIssueToTaskContext(issue);
    assert.ok(result.includes('Test Issue Title'));
  });

  await t.test('should include issue number', () => {
    const issue = createMockIssue();
    const result = convertIssueToTaskContext(issue);
    assert.ok(result.includes('#123') || result.includes('Issue #123'));
  });

  await t.test('should include body content', () => {
    const issue = createMockIssue({ body: 'Detailed description here' });
    const result = convertIssueToTaskContext(issue);
    assert.ok(result.includes('Detailed description'));
  });

  await t.test('should include labels when present', () => {
    const issue = createMockIssue({ labels: ['bug', 'priority-high'] });
    const result = convertIssueToTaskContext(issue);
    assert.ok(result.includes('bug'));
    assert.ok(result.includes('priority-high'));
  });

  await t.test('should include assignees when present', () => {
    const issue = createMockIssue({ assignees: ['user1', 'user2'] });
    const result = convertIssueToTaskContext(issue);
    assert.ok(result.includes('user1'));
    assert.ok(result.includes('user2'));
  });

  await t.test('should include comments when enabled', () => {
    const issue = createMockIssue({
      comments: [{ id: 1, author: 'commenter', body: 'Important comment', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' }],
    });
    const result = convertIssueToTaskContext(issue, { includeComments: true });
    assert.ok(result.includes('commenter') || result.includes('Important comment'));
  });

  await t.test('should exclude comments when disabled', () => {
    const issue = createMockIssue({
      comments: [{ id: 2, author: 'commenter', body: 'Secret comment', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' }],
    });
    const result = convertIssueToTaskContext(issue, { includeComments: false });
    assert.ok(!result.includes('Secret comment'));
  });
});

test('extractSourceIssue: extract source info', async (t) => {
  await t.test('should extract basic info', () => {
    const issue = createMockIssue();
    const result = extractSourceIssue(issue);
    assert.strictEqual(result.number, 123);
    assert.ok(result.title.includes('Test Issue'));
    assert.strictEqual(result.url, 'https://github.com/owner/repo/issues/123');
  });

  await t.test('should extract owner/repo from URL', () => {
    const issue = createMockIssue({ url: 'https://github.com/myorg/myrepo/issues/456' });
    const result = extractSourceIssue(issue);
    assert.strictEqual(result.owner, 'myorg');
    assert.strictEqual(result.repo, 'myrepo');
  });

  await t.test('should use ref owner/repo when provided', () => {
    const issue = createMockIssue();
    const ref = { type: 'url' as const, owner: 'refowner', repo: 'refrepo', number: 123 };
    const result = extractSourceIssue(issue, ref);
    assert.strictEqual(result.owner, 'refowner');
    assert.strictEqual(result.repo, 'refrepo');
  });
});

test('inferTaskType: infer type from labels', async (t) => {
  await t.test('should infer documentation type', () => {
    const issue = createMockIssue({ labels: ['documentation'] });
    assert.strictEqual(inferTaskType(issue), 'documentation');
  });

  await t.test('should infer investigation type', () => {
    const issue = createMockIssue({ labels: ['research', 'spike'] });
    assert.strictEqual(inferTaskType(issue), 'investigation');
  });

  await t.test('should infer integration type', () => {
    const issue = createMockIssue({ labels: ['integration'] });
    assert.strictEqual(inferTaskType(issue), 'integration');
  });

  await t.test('should default to implementation', () => {
    const issue = createMockIssue({ labels: ['enhancement', 'feature'] });
    assert.strictEqual(inferTaskType(issue), 'implementation');
  });

  await t.test('should handle empty labels', () => {
    const issue = createMockIssue({ labels: [] });
    assert.strictEqual(inferTaskType(issue), 'implementation');
  });
});

test('extractAcceptanceCriteria: extract from body', async (t) => {
  await t.test('should extract acceptance criteria section (English)', () => {
    const issue = createMockIssue({
      body: '## Description\nSome desc\n\n## Acceptance Criteria\n- [ ] Feature works\n- [ ] Tests pass',
    });
    const result = extractAcceptanceCriteria(issue);
    assert.ok(result.includes('Feature works'));
    assert.ok(result.includes('Tests pass'));
  });

  await t.test('should extract acceptance criteria section (Japanese)', () => {
    const issue = createMockIssue({
      body: '## 概要\n説明\n\n## 受け入れ基準\n- 機能が動作する\n- テストが通る',
    });
    const result = extractAcceptanceCriteria(issue);
    assert.ok(result.includes('機能が動作する'));
  });

  await t.test('should generate fallback when no section found', () => {
    const issue = createMockIssue({
      title: 'Add login feature',
      body: 'Please add a login feature to the app.',
    });
    const result = extractAcceptanceCriteria(issue);
    assert.ok(result.includes('Issue #123'));
    assert.ok(result.includes('Add login feature'));
  });
});

test('generateTaskSummary: generate short summary', async (t) => {
  await t.test('should generate summary from title', () => {
    const issue = createMockIssue({ title: 'Add user authentication' });
    const result = generateTaskSummary(issue);
    assert.ok(result.includes('user authentication'));
  });

  await t.test('should remove prefix tags', () => {
    const issue = createMockIssue({ title: '[feat] Add new feature' });
    const result = generateTaskSummary(issue);
    assert.ok(!result.includes('[feat]'));
    assert.ok(result.includes('Add new feature'));
  });

  await t.test('should truncate long titles', () => {
    const issue = createMockIssue({ title: 'A'.repeat(100) });
    const result = generateTaskSummary(issue);
    assert.ok(result.length <= 43); // 40 + "..."
  });
});
