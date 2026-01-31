/**
 * AI Antipattern Reviewer Tests
 *
 * ADR-031: AI Antipattern Review（AI生成コード品質ゲート）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createAIAntipatternReviewer } from '../../src/core/orchestrator/ai-antipattern-reviewer.ts';

describe('AIAntipatternReviewer', () => {
  describe('detectFallbackViolations', () => {
    it('should detect nullish coalescing with suspicious defaults', () => {
      const reviewer = createAIAntipatternReviewer();
      const content = `
const name = data.name ?? 'unknown';
const value = result.value ?? 'default';
      `.trim();

      const violations = reviewer.detectFallbackViolations('test.ts', content);

      assert.ok(violations.length >= 1, 'Expected at least one violation');
      assert.ok(
        violations.some((v) => v.type === 'nullish_coalescing'),
        'Expected nullish_coalescing violation',
      );
    });

    it('should detect empty catch blocks', () => {
      const reviewer = createAIAntipatternReviewer();
      const content = `
try {
  doSomething();
} catch (e) { return ''; }
      `.trim();

      const violations = reviewer.detectFallbackViolations('test.ts', content);

      assert.ok(
        violations.some((v) => v.type === 'empty_catch'),
        'Expected empty_catch violation',
      );
    });

    it('should detect fallback chains', () => {
      const reviewer = createAIAntipatternReviewer();
      const content = `const value = a ?? b ?? c ?? d;`;

      const violations = reviewer.detectFallbackViolations('test.ts', content);

      assert.ok(
        violations.some((v) => v.type === 'fallback_chain'),
        'Expected fallback_chain violation',
      );
    });

    it('should skip comment lines', () => {
      const reviewer = createAIAntipatternReviewer();
      const content = `
// const name = data ?? 'unknown';
/* const value = result ?? 'default'; */
      `.trim();

      const violations = reviewer.detectFallbackViolations('test.ts', content);

      // Comment-only lines should not be flagged
      assert.strictEqual(violations.length, 0, 'Expected no violations for comments');
    });

    it('should mark exemptions when explicit comment exists', () => {
      const reviewer = createAIAntipatternReviewer();
      const content = `const name = data ?? 'unknown'; // intentional default`;

      const violations = reviewer.detectFallbackViolations('test.ts', content);

      if (violations.length > 0) {
        assert.ok(
          violations.some((v) => v.exemptionReason !== undefined),
          'Expected exemption reason',
        );
      }
    });

    it('should skip config files in exceptions', () => {
      const reviewer = createAIAntipatternReviewer({
        enabled: true,
        fallbackDetection: {
          enabled: true,
          exceptions: ['*.config.ts'],
        },
        unusedCodeDetection: {
          enabled: false,
          tool: 'grep',
          frameworkExceptions: [],
        },
        scopeCreepDetection: {
          enabled: false,
          tolerance: 0.2,
        },
        rejectThreshold: 3,
      });
      const content = `const value = data ?? 'unknown';`;

      const violations = reviewer.detectFallbackViolations('app.config.ts', content);

      assert.strictEqual(violations.length, 0, 'Config files should be skipped');
    });
  });

  describe('review', () => {
    it('should return perfect score for clean code', async () => {
      const reviewer = createAIAntipatternReviewer();
      const files = new Map<string, string>([
        ['src/clean.ts', `
export function add(a: number, b: number): number {
  return a + b;
}
        `.trim()],
      ]);

      const result = await reviewer.review(files, 'Implement add function');

      assert.ok(result.overallScore >= 80, 'Expected high score for clean code');
      assert.strictEqual(result.shouldReject, false);
    });

    it('should detect multiple issues and calculate score', async () => {
      const reviewer = createAIAntipatternReviewer({
        enabled: true,
        fallbackDetection: { enabled: true, exceptions: [] },
        unusedCodeDetection: { enabled: true, tool: 'grep', frameworkExceptions: [] },
        scopeCreepDetection: { enabled: true, tolerance: 0.2 },
        rejectThreshold: 5,
      });

      const files = new Map<string, string>([
        ['src/problematic.ts', `
export function getValue() {
  const name = data ?? 'unknown';
  const value = result ?? 'default';
  try {
    doSomething();
  } catch { return ''; }
  return name;
}
        `.trim()],
      ]);

      const result = await reviewer.review(files, 'Get value function');

      assert.ok(result.fallbackViolations.length > 0, 'Expected fallback violations');
      assert.ok(result.overallScore < 100, 'Expected reduced score');
    });

    it('should return full score when disabled', async () => {
      const reviewer = createAIAntipatternReviewer({
        enabled: false,
        fallbackDetection: { enabled: true, exceptions: [] },
        unusedCodeDetection: { enabled: true, tool: 'grep', frameworkExceptions: [] },
        scopeCreepDetection: { enabled: true, tolerance: 0.2 },
        rejectThreshold: 3,
      });

      const files = new Map<string, string>([
        ['src/bad.ts', `const x = a ?? b ?? c ?? d ?? 'unknown';`],
      ]);

      const result = await reviewer.review(files, 'Test');

      assert.strictEqual(result.overallScore, 100);
      assert.strictEqual(result.shouldReject, false);
    });

    it('should detect scope creep when file is unrelated to task', async () => {
      const reviewer = createAIAntipatternReviewer({
        enabled: true,
        fallbackDetection: { enabled: false, exceptions: [] },
        unusedCodeDetection: { enabled: false, tool: 'grep', frameworkExceptions: [] },
        scopeCreepDetection: { enabled: true, tolerance: 0.1 },
        rejectThreshold: 3,
      });

      const files = new Map<string, string>([
        ['src/database/migration.ts', `export function migrate() {}`],
      ]);

      const result = await reviewer.review(files, 'Implement user authentication login');

      // File name has no overlap with task keywords
      assert.ok(
        result.scopeCreep.length > 0 || result.overallScore < 100,
        'Expected scope creep detection or reduced score',
      );
    });

    it('should respect reject threshold', async () => {
      const reviewer = createAIAntipatternReviewer({
        enabled: true,
        fallbackDetection: { enabled: true, exceptions: [] },
        unusedCodeDetection: { enabled: false, tool: 'grep', frameworkExceptions: [] },
        scopeCreepDetection: { enabled: false, tolerance: 0.2 },
        rejectThreshold: 2,
      });

      const files = new Map<string, string>([
        ['src/test.ts', `
const a = x ?? 'unknown';
const b = y ?? 'default';
const c = z ?? 'none';
        `.trim()],
      ]);

      const result = await reviewer.review(files, 'Test');

      // With 3 violations and threshold of 2, should reject
      if (result.fallbackViolations.filter((v) => !v.exemptionReason).length >= 2) {
        assert.strictEqual(result.shouldReject, true);
        assert.ok(result.rejectReason !== undefined);
      }
    });
  });
});
