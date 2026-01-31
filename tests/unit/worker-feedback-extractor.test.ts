import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  extractWorkerFeedback,
  validateWorkerFeedback,
  extractRecommendations,
  extractPatterns,
  extractFindings,
} from '../../src/core/orchestrator/worker-feedback-extractor.ts';
import type { WorkerFeedback } from '../../src/types/task.ts';

describe('worker-feedback-extractor', () => {
  describe('extractWorkerFeedback', () => {
    it('should extract implementation feedback from run log', () => {
      const runLog = `
Task completed successfully.

## Feedback
\`\`\`json
{
  "type": "implementation",
  "result": "success",
  "changes": ["src/auth.ts", "src/utils.ts"],
  "notes": "Refactored authentication logic",
  "findings": ["Found duplicate validation in auth module"],
  "recommendations": ["Consider extracting common validation"],
  "patterns": ["Repeated null checks in all handlers"]
}
\`\`\`

Done.
`;

      const feedback = extractWorkerFeedback(runLog);

      assert.ok(feedback);
      assert.strictEqual(feedback.type, 'implementation');
      if (feedback.type === 'implementation') {
        assert.strictEqual(feedback.result, 'success');
        assert.deepStrictEqual(feedback.changes, [
          'src/auth.ts',
          'src/utils.ts',
        ]);
        assert.strictEqual(feedback.notes, 'Refactored authentication logic');
        assert.deepStrictEqual(feedback.findings, [
          'Found duplicate validation in auth module',
        ]);
        assert.deepStrictEqual(feedback.recommendations, [
          'Consider extracting common validation',
        ]);
        assert.deepStrictEqual(feedback.patterns, [
          'Repeated null checks in all handlers',
        ]);
      }
    });

    it('should extract exploration feedback from run log', () => {
      const runLog = `
Exploring codebase...

## Feedback
\`\`\`json
{
  "type": "exploration",
  "findings": "Found 3 potential security issues in auth module",
  "recommendations": ["Add input validation", "Use parameterized queries"],
  "confidence": "high",
  "patterns": ["SQL queries built with string concatenation"]
}
\`\`\`
`;

      const feedback = extractWorkerFeedback(runLog);

      assert.ok(feedback);
      assert.strictEqual(feedback.type, 'exploration');
      if (feedback.type === 'exploration') {
        assert.strictEqual(
          feedback.findings,
          'Found 3 potential security issues in auth module',
        );
        assert.deepStrictEqual(feedback.recommendations, [
          'Add input validation',
          'Use parameterized queries',
        ]);
        assert.strictEqual(feedback.confidence, 'high');
        assert.deepStrictEqual(feedback.patterns, [
          'SQL queries built with string concatenation',
        ]);
      }
    });

    it('should extract difficulty feedback from run log', () => {
      const runLog = `
Encountered issues...

## Feedback
\`\`\`json
{
  "type": "difficulty",
  "issue": "Cannot determine correct API endpoint",
  "attempts": ["Tried /api/v1/users", "Tried /api/users"],
  "impediment": {
    "category": "ambiguity",
    "requestedAction": "clarification"
  },
  "suggestion": "Need API documentation",
  "patterns": ["Missing endpoint documentation across all services"]
}
\`\`\`
`;

      const feedback = extractWorkerFeedback(runLog);

      assert.ok(feedback);
      assert.strictEqual(feedback.type, 'difficulty');
      if (feedback.type === 'difficulty') {
        assert.strictEqual(
          feedback.issue,
          'Cannot determine correct API endpoint',
        );
        assert.deepStrictEqual(feedback.attempts, [
          'Tried /api/v1/users',
          'Tried /api/users',
        ]);
        assert.strictEqual(feedback.impediment.category, 'ambiguity');
        assert.strictEqual(feedback.impediment.requestedAction, 'clarification');
        assert.strictEqual(feedback.suggestion, 'Need API documentation');
        assert.deepStrictEqual(feedback.patterns, [
          'Missing endpoint documentation across all services',
        ]);
      }
    });

    it('should return null when no feedback section exists', () => {
      const runLog = `
Task completed.
No structured feedback provided.
`;

      const feedback = extractWorkerFeedback(runLog);
      assert.strictEqual(feedback, null);
    });

    it('should return null when JSON is invalid', () => {
      const runLog = `
## Feedback
\`\`\`json
{ invalid json here }
\`\`\`
`;

      const feedback = extractWorkerFeedback(runLog);
      assert.strictEqual(feedback, null);
    });

    it('should return null when feedback does not match schema', () => {
      const runLog = `
## Feedback
\`\`\`json
{
  "type": "unknown_type",
  "data": "invalid"
}
\`\`\`
`;

      const feedback = extractWorkerFeedback(runLog);
      assert.strictEqual(feedback, null);
    });
  });

  describe('validateWorkerFeedback', () => {
    it('should validate correct implementation feedback', () => {
      const feedback = validateWorkerFeedback({
        type: 'implementation',
        result: 'success',
        changes: ['file1.ts'],
      });

      assert.ok(feedback);
      assert.strictEqual(feedback.type, 'implementation');
    });

    it('should validate correct exploration feedback', () => {
      const feedback = validateWorkerFeedback({
        type: 'exploration',
        findings: 'Found issues',
        recommendations: ['Fix it'],
        confidence: 'medium',
      });

      assert.ok(feedback);
      assert.strictEqual(feedback.type, 'exploration');
    });

    it('should return null for invalid feedback', () => {
      const feedback = validateWorkerFeedback({
        type: 'implementation',
        // missing required fields
      });

      assert.strictEqual(feedback, null);
    });
  });

  describe('extractRecommendations', () => {
    it('should extract recommendations from exploration feedback', () => {
      const feedback: WorkerFeedback = {
        type: 'exploration',
        findings: 'Found issues',
        recommendations: ['Rec 1', 'Rec 2'],
        confidence: 'high',
      };

      const recs = extractRecommendations(feedback);
      assert.deepStrictEqual(recs, ['Rec 1', 'Rec 2']);
    });

    it('should extract recommendations from implementation feedback', () => {
      const feedback: WorkerFeedback = {
        type: 'implementation',
        result: 'success',
        changes: ['file.ts'],
        recommendations: ['Rec A', 'Rec B'],
      };

      const recs = extractRecommendations(feedback);
      assert.deepStrictEqual(recs, ['Rec A', 'Rec B']);
    });

    it('should return empty array for difficulty feedback', () => {
      const feedback: WorkerFeedback = {
        type: 'difficulty',
        issue: 'Problem',
        attempts: ['Try 1'],
        impediment: {
          category: 'technical',
          requestedAction: 'escalate',
        },
      };

      const recs = extractRecommendations(feedback);
      assert.deepStrictEqual(recs, []);
    });
  });

  describe('extractPatterns', () => {
    it('should extract patterns from feedback with patterns field', () => {
      const feedback: WorkerFeedback = {
        type: 'implementation',
        result: 'success',
        changes: ['file.ts'],
        patterns: ['Pattern 1', 'Pattern 2'],
      };

      const patterns = extractPatterns(feedback);
      assert.deepStrictEqual(patterns, ['Pattern 1', 'Pattern 2']);
    });

    it('should return empty array when no patterns field', () => {
      const feedback: WorkerFeedback = {
        type: 'implementation',
        result: 'success',
        changes: ['file.ts'],
      };

      const patterns = extractPatterns(feedback);
      assert.deepStrictEqual(patterns, []);
    });
  });

  describe('extractFindings', () => {
    it('should extract findings from implementation feedback', () => {
      const feedback: WorkerFeedback = {
        type: 'implementation',
        result: 'success',
        changes: ['file.ts'],
        findings: ['Finding 1', 'Finding 2'],
      };

      const findings = extractFindings(feedback);
      assert.deepStrictEqual(findings, ['Finding 1', 'Finding 2']);
    });

    it('should convert exploration findings string to array', () => {
      const feedback: WorkerFeedback = {
        type: 'exploration',
        findings: 'Single finding as string',
        recommendations: [],
        confidence: 'medium',
      };

      const findings = extractFindings(feedback);
      assert.deepStrictEqual(findings, ['Single finding as string']);
    });

    it('should return empty array for difficulty feedback', () => {
      const feedback: WorkerFeedback = {
        type: 'difficulty',
        issue: 'Problem',
        attempts: ['Try 1'],
        impediment: {
          category: 'technical',
          requestedAction: 'escalate',
        },
      };

      const findings = extractFindings(feedback);
      assert.deepStrictEqual(findings, []);
    });
  });
});
