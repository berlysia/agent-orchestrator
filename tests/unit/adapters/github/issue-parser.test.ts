/**
 * Issue Parser Unit Tests (ADR-029)
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { isOk, isErr } from 'option-t/plain_result';
import {
  parseIssueRef,
  isIssueRef,
  formatIssueRef,
  issueRefToUrl,
} from '../../../../src/adapters/github/issue-parser.ts';

test('parseIssueRef: parse number-only format', async (t) => {
  await t.test('should parse #123 format', () => {
    const result = parseIssueRef('#123');
    assert.ok(isOk(result), 'Should succeed');
    assert.strictEqual(result.val.type, 'number');
    assert.strictEqual(result.val.number, 123);
  });

  await t.test('should parse 123 format (without #)', () => {
    const result = parseIssueRef('123');
    assert.ok(isOk(result), 'Should succeed');
    assert.strictEqual(result.val.type, 'number');
    assert.strictEqual(result.val.number, 123);
  });

  await t.test('should reject invalid numbers', () => {
    const result = parseIssueRef('#abc');
    assert.ok(isErr(result), 'Should fail');
    assert.ok(result.err.message.includes('Invalid'));
  });

  await t.test('should reject negative numbers', () => {
    const result = parseIssueRef('#-1');
    assert.ok(isErr(result), 'Should fail');
  });
});

test('parseIssueRef: parse owner/repo#number format', async (t) => {
  await t.test('should parse owner/repo#123 format', () => {
    const result = parseIssueRef('owner/repo#123');
    assert.ok(isOk(result), 'Should succeed');
    assert.strictEqual(result.val.type, 'url');
    if (result.val.type === 'url') {
      assert.strictEqual(result.val.owner, 'owner');
      assert.strictEqual(result.val.repo, 'repo');
      assert.strictEqual(result.val.number, 123);
    }
  });

  await t.test('should handle hyphenated names', () => {
    const result = parseIssueRef('my-org/my-repo#456');
    assert.ok(isOk(result), 'Should succeed');
    if (isOk(result) && result.val.type === 'url') {
      assert.strictEqual(result.val.owner, 'my-org');
      assert.strictEqual(result.val.repo, 'my-repo');
      assert.strictEqual(result.val.number, 456);
    }
  });
});

test('parseIssueRef: parse GitHub URL format', async (t) => {
  await t.test('should parse full GitHub URL', () => {
    const result = parseIssueRef('https://github.com/owner/repo/issues/789');
    assert.ok(isOk(result), 'Should succeed');
    if (isOk(result) && result.val.type === 'url') {
      assert.strictEqual(result.val.owner, 'owner');
      assert.strictEqual(result.val.repo, 'repo');
      assert.strictEqual(result.val.number, 789);
    }
  });

  await t.test('should parse HTTP URL', () => {
    const result = parseIssueRef('http://github.com/owner/repo/issues/100');
    assert.ok(isOk(result), 'Should succeed');
    if (isOk(result) && result.val.type === 'url') {
      assert.strictEqual(result.val.number, 100);
    }
  });

  await t.test('should reject invalid GitHub URL', () => {
    const result = parseIssueRef('https://github.com/owner/repo/pulls/123');
    assert.ok(isErr(result), 'Should fail for pull request URL');
  });
});

test('isIssueRef: detect issue references', async (t) => {
  await t.test('should return true for valid formats', () => {
    assert.strictEqual(isIssueRef('#123'), true);
    assert.strictEqual(isIssueRef('123'), true);
    assert.strictEqual(isIssueRef('owner/repo#123'), true);
    assert.strictEqual(isIssueRef('https://github.com/owner/repo/issues/123'), true);
  });

  await t.test('should return false for invalid formats', () => {
    assert.strictEqual(isIssueRef('hello world'), false);
    assert.strictEqual(isIssueRef('implement feature'), false);
    assert.strictEqual(isIssueRef(''), false);
  });
});

test('formatIssueRef: format issue reference as string', async (t) => {
  await t.test('should format number-only ref', () => {
    const formatted = formatIssueRef({ type: 'number', number: 123 });
    assert.strictEqual(formatted, '#123');
  });

  await t.test('should format url ref', () => {
    const formatted = formatIssueRef({ type: 'url', owner: 'owner', repo: 'repo', number: 456 });
    assert.strictEqual(formatted, 'owner/repo#456');
  });
});

test('issueRefToUrl: convert to GitHub URL', async (t) => {
  await t.test('should convert url ref to URL', () => {
    const url = issueRefToUrl({ type: 'url', owner: 'owner', repo: 'repo', number: 123 });
    assert.strictEqual(url, 'https://github.com/owner/repo/issues/123');
  });

  await t.test('should return undefined for number-only ref', () => {
    const url = issueRefToUrl({ type: 'number', number: 123 });
    assert.strictEqual(url, undefined);
  });
});
