/**
 * Issue Actions Tests (ADR-029)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

// Note: Actual gh CLI calls are not tested here as they require GitHub authentication
// These tests verify the module structure and exported functions

describe('issue-actions module', () => {
  test('should export postIssueComment function', async () => {
    const { postIssueComment } = await import(
      '../../../../src/adapters/github/issue-actions.ts'
    );
    assert.strictEqual(typeof postIssueComment, 'function');
  });

  test('should export addIssueLabels function', async () => {
    const { addIssueLabels } = await import(
      '../../../../src/adapters/github/issue-actions.ts'
    );
    assert.strictEqual(typeof addIssueLabels, 'function');
  });

  test('should export removeIssueLabels function', async () => {
    const { removeIssueLabels } = await import(
      '../../../../src/adapters/github/issue-actions.ts'
    );
    assert.strictEqual(typeof removeIssueLabels, 'function');
  });

  test('should export updateIssueLabels function', async () => {
    const { updateIssueLabels } = await import(
      '../../../../src/adapters/github/issue-actions.ts'
    );
    assert.strictEqual(typeof updateIssueLabels, 'function');
  });

  test('should export executeCompletionActions function', async () => {
    const { executeCompletionActions } = await import(
      '../../../../src/adapters/github/issue-actions.ts'
    );
    assert.strictEqual(typeof executeCompletionActions, 'function');
  });
});
