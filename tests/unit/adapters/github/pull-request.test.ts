/**
 * Pull Request Helper Tests (ADR-029)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  appendIssueReference,
  appendMultipleIssueReferences,
} from '../../../../src/adapters/github/pull-request.ts';
import type { SourceIssue } from '../../../../src/types/github-issue.ts';

describe('appendIssueReference', () => {
  test('should append issue reference to empty body', () => {
    const sourceIssue: SourceIssue = {
      number: 123,
      title: 'Test Issue',
      url: 'https://github.com/test/repo/issues/123',
    };

    const result = appendIssueReference('', sourceIssue);
    assert.strictEqual(result, 'Closes #123');
  });

  test('should append issue reference to existing body', () => {
    const sourceIssue: SourceIssue = {
      number: 456,
      title: 'Feature Request',
      url: 'https://github.com/test/repo/issues/456',
    };

    const result = appendIssueReference('Initial PR description.', sourceIssue);
    assert.strictEqual(result, 'Initial PR description.\n\nCloses #456');
  });

  test('should use full reference for cross-repo issues', () => {
    const sourceIssue: SourceIssue = {
      number: 789,
      title: 'Cross Repo Issue',
      url: 'https://github.com/other/project/issues/789',
      owner: 'other',
      repo: 'project',
    };

    const result = appendIssueReference('PR body', sourceIssue);
    assert.strictEqual(result, 'PR body\n\nCloses other/project#789');
  });

  test('should support different keywords', () => {
    const sourceIssue: SourceIssue = {
      number: 100,
      title: 'Bug Fix',
      url: 'https://github.com/test/repo/issues/100',
    };

    const fixesResult = appendIssueReference('Bug fix', sourceIssue, 'Fixes');
    assert.strictEqual(fixesResult, 'Bug fix\n\nFixes #100');

    const resolvesResult = appendIssueReference('Resolution', sourceIssue, 'Resolves');
    assert.strictEqual(resolvesResult, 'Resolution\n\nResolves #100');
  });

  test('should not duplicate existing reference', () => {
    const sourceIssue: SourceIssue = {
      number: 42,
      title: 'Test',
      url: 'https://github.com/test/repo/issues/42',
    };

    const bodyWithRef = 'PR description\n\nCloses #42';
    const result = appendIssueReference(bodyWithRef, sourceIssue);
    assert.strictEqual(result, bodyWithRef);
  });
});

describe('appendMultipleIssueReferences', () => {
  test('should append multiple issue references', () => {
    const issues: SourceIssue[] = [
      { number: 1, title: 'Issue 1', url: 'https://github.com/t/r/issues/1' },
      { number: 2, title: 'Issue 2', url: 'https://github.com/t/r/issues/2' },
      { number: 3, title: 'Issue 3', url: 'https://github.com/t/r/issues/3' },
    ];

    const result = appendMultipleIssueReferences('PR body', issues);
    assert.ok(result.includes('Closes #1'));
    assert.ok(result.includes('Closes #2'));
    assert.ok(result.includes('Closes #3'));
  });

  test('should return original body for empty issues array', () => {
    const result = appendMultipleIssueReferences('Original body', []);
    assert.strictEqual(result, 'Original body');
  });

  test('should handle mixed local and cross-repo issues', () => {
    const issues: SourceIssue[] = [
      { number: 10, title: 'Local', url: 'https://github.com/t/r/issues/10' },
      {
        number: 20,
        title: 'Remote',
        url: 'https://github.com/other/repo/issues/20',
        owner: 'other',
        repo: 'repo',
      },
    ];

    const result = appendMultipleIssueReferences('Body', issues, 'Fixes');
    assert.ok(result.includes('Fixes #10'));
    assert.ok(result.includes('Fixes other/repo#20'));
  });
});
