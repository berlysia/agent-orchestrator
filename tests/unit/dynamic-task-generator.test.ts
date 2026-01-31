import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateTaskCandidates } from '../../src/core/orchestrator/dynamic-task-generator.ts';
import type { WorkerFeedback, Task } from '../../src/types/task.ts';
import {
  TaskCandidateSource,
  TaskCandidateCategory,
  TaskCandidateStatus,
} from '../../src/types/leader-session.ts';
import { taskId, repoPath, branchName } from '../../src/types/branded.ts';

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: taskId('test-task-1'),
    repo: repoPath('/test/repo'),
    branch: branchName('feature/test'),
    acceptance: 'Test acceptance criteria',
    scopePaths: ['src/test.ts'],
    dependencies: [],
    state: 'READY',
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    retryCount: 0,
    runHistory: [],
    maxRetries: 3,
    checkFixEnabled: false,
    baseBranch: branchName('main'),
    baseCommit: 'abc123',
    owner: null,
    ...overrides,
  } as Task;
}

describe('dynamic-task-generator', () => {
  describe('generateTaskCandidates', () => {
    it('should generate candidates from recommendations', () => {
      const feedback: WorkerFeedback = {
        type: 'exploration',
        findings: 'Found issues in module',
        recommendations: [
          'Add input validation',
          'Extract common utility function',
        ],
        confidence: 'high',
      };

      const task = createMockTask();
      const candidates = generateTaskCandidates(feedback, task);

      assert.strictEqual(candidates.length, 2);

      const first = candidates[0];
      assert.ok(first, 'First candidate should exist');
      assert.strictEqual(first.source, TaskCandidateSource.WORKER_RECOMMENDATION);
      assert.strictEqual(first.description, 'Add input validation');
      assert.strictEqual(first.status, TaskCandidateStatus.PENDING);
      assert.strictEqual(first.autoExecutable, false);

      const second = candidates[1];
      assert.ok(second, 'Second candidate should exist');
      assert.strictEqual(second.description, 'Extract common utility function');
    });

    it('should generate candidates from patterns', () => {
      const feedback: WorkerFeedback = {
        type: 'implementation',
        result: 'success',
        changes: ['src/file.ts'],
        patterns: [
          'Repeated null checks in all handlers',
          'Same error handling code everywhere',
        ],
      };

      const task = createMockTask();
      const candidates = generateTaskCandidates(feedback, task);

      assert.strictEqual(candidates.length, 2);

      const first = candidates[0];
      assert.ok(first, 'First candidate should exist');
      assert.strictEqual(first.source, TaskCandidateSource.PATTERN_DISCOVERY);
      assert.ok(first.description.startsWith('Refactor:'));
      assert.strictEqual(first.priority, 'low');
      assert.strictEqual(first.category, TaskCandidateCategory.REFACTORING);
      assert.strictEqual(first.autoExecutable, false);
    });

    it('should not generate candidates for non-security findings', () => {
      const feedback: WorkerFeedback = {
        type: 'implementation',
        result: 'success',
        changes: ['src/utils.ts'],
        findings: [
          'Found potential performance issue in query builder',
          'Regular finding about code style',
        ],
      };

      const task = createMockTask();
      const candidates = generateTaskCandidates(feedback, task);

      assert.strictEqual(candidates.length, 0);
    });

    it('should detect security-related findings', () => {
      const feedback: WorkerFeedback = {
        type: 'implementation',
        result: 'success',
        changes: ['src/auth.ts'],
        findings: ['Found SQL injection vulnerability in query builder'],
      };

      const task = createMockTask();
      const candidates = generateTaskCandidates(feedback, task);

      assert.strictEqual(candidates.length, 1);

      const first = candidates[0];
      assert.ok(first, 'First candidate should exist');
      assert.strictEqual(first.source, TaskCandidateSource.EXPLORATION_FINDING);
      assert.ok(first.description.includes('Security:'));
      assert.strictEqual(first.priority, 'high');
      assert.strictEqual(first.category, TaskCandidateCategory.SECURITY);
    });

    it('should assign high priority to security recommendations', () => {
      const feedback: WorkerFeedback = {
        type: 'exploration',
        findings: 'Found issues',
        recommendations: ['Fix security vulnerability in auth'],
        confidence: 'high',
      };

      const task = createMockTask();
      const candidates = generateTaskCandidates(feedback, task);

      assert.strictEqual(candidates.length, 1);

      const first = candidates[0];
      assert.ok(first, 'First candidate should exist');
      assert.strictEqual(first.priority, 'high');
      assert.strictEqual(first.category, TaskCandidateCategory.SECURITY);
    });

    it('should assign medium priority to performance recommendations', () => {
      const feedback: WorkerFeedback = {
        type: 'exploration',
        findings: 'Found issues',
        recommendations: ['Optimize database queries'],
        confidence: 'medium',
      };

      const task = createMockTask();
      const candidates = generateTaskCandidates(feedback, task);

      assert.strictEqual(candidates.length, 1);

      const first = candidates[0];
      assert.ok(first, 'First candidate should exist');
      assert.strictEqual(first.priority, 'medium');
      assert.strictEqual(first.category, TaskCandidateCategory.PERFORMANCE);
    });

    it('should categorize refactoring recommendations', () => {
      const feedback: WorkerFeedback = {
        type: 'exploration',
        findings: 'Found issues',
        recommendations: ['Extract common validation function'],
        confidence: 'medium',
      };

      const task = createMockTask();
      const candidates = generateTaskCandidates(feedback, task);

      assert.strictEqual(candidates.length, 1);

      const first = candidates[0];
      assert.ok(first, 'First candidate should exist');
      assert.strictEqual(first.category, TaskCandidateCategory.REFACTORING);
    });

    it('should categorize documentation recommendations', () => {
      const feedback: WorkerFeedback = {
        type: 'exploration',
        findings: 'Found issues',
        recommendations: ['Add JSDoc comments to public API'],
        confidence: 'medium',
      };

      const task = createMockTask();
      const candidates = generateTaskCandidates(feedback, task);

      assert.strictEqual(candidates.length, 1);

      const first = candidates[0];
      assert.ok(first, 'First candidate should exist');
      assert.strictEqual(first.category, TaskCandidateCategory.DOCUMENTATION);
    });

    it('should return empty array when no actionable feedback', () => {
      const feedback: WorkerFeedback = {
        type: 'implementation',
        result: 'success',
        changes: ['src/file.ts'],
      };

      const task = createMockTask();
      const candidates = generateTaskCandidates(feedback, task);

      assert.deepStrictEqual(candidates, []);
    });

    it('should set relatedTaskId correctly', () => {
      const feedback: WorkerFeedback = {
        type: 'exploration',
        findings: 'Found issues',
        recommendations: ['Some recommendation'],
        confidence: 'high',
      };

      const task = createMockTask({ id: taskId('specific-task-id') });
      const candidates = generateTaskCandidates(feedback, task);

      assert.strictEqual(candidates.length, 1);

      const first = candidates[0];
      assert.ok(first, 'First candidate should exist');
      assert.strictEqual(first.relatedTaskId, 'specific-task-id');
    });

    it('should generate unique IDs for each candidate', () => {
      const feedback: WorkerFeedback = {
        type: 'exploration',
        findings: 'Found issues',
        recommendations: ['Rec 1', 'Rec 2', 'Rec 3'],
        confidence: 'high',
      };

      const task = createMockTask();
      const candidates = generateTaskCandidates(feedback, task);

      const ids = candidates.map((c) => c.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(uniqueIds.size, ids.length);
    });

    it('should combine recommendations and patterns', () => {
      const feedback: WorkerFeedback = {
        type: 'implementation',
        result: 'success',
        changes: ['src/file.ts'],
        recommendations: ['Add validation'],
        patterns: ['Repeated error handling'],
      };

      const task = createMockTask();
      const candidates = generateTaskCandidates(feedback, task);

      assert.strictEqual(candidates.length, 2);

      const sources = candidates.map((c) => c.source);
      assert.ok(sources.includes(TaskCandidateSource.WORKER_RECOMMENDATION));
      assert.ok(sources.includes(TaskCandidateSource.PATTERN_DISCOVERY));
    });
  });
});
