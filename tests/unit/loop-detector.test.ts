/**
 * Loop Detector Tests
 *
 * ADR-033: ループ検出と無限ループ防止
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createLoopDetector } from '../../src/core/orchestrator/loop-detector.ts';
import type { StateTransition } from '../../src/types/loop-detection.ts';

describe('LoopDetector', () => {
  describe('recordStepExecution', () => {
    it('should track step iterations', () => {
      const detector = createLoopDetector();

      const result1 = detector.recordStepExecution('worker_execute');
      const result2 = detector.recordStepExecution('worker_execute');

      assert.strictEqual(result1.type, 'ok');
      assert.strictEqual(result2.type, 'ok');
      assert.strictEqual(detector.getStepIterationCount('worker_execute'), 2);
    });

    it('should detect step iteration exceeded', () => {
      const detector = createLoopDetector({
        enabled: true,
        maxStepIterations: {
          default: 5,
          worker: 2, // Low limit for testing
          judge: 3,
          replan: 2,
        },
        similarityDetection: { enabled: false, threshold: 0.8, windowSize: 3 },
        transitionPatternDetection: { enabled: false, minOccurrences: 2 },
        onLoop: { default: 'escalate' },
      });

      detector.recordStepExecution('worker_task');
      detector.recordStepExecution('worker_task');
      const result = detector.recordStepExecution('worker_task');

      assert.strictEqual(result.type, 'step_iteration_exceeded');
      if (result.type === 'step_iteration_exceeded') {
        assert.strictEqual(result.stepName, 'worker_task');
        assert.strictEqual(result.count, 3);
        assert.strictEqual(result.max, 2);
      }
    });

    it('should return ok when disabled', () => {
      const detector = createLoopDetector({
        enabled: false,
        maxStepIterations: { default: 1, worker: 1, judge: 1, replan: 1 },
        similarityDetection: { enabled: false, threshold: 0.8, windowSize: 3 },
        transitionPatternDetection: { enabled: false, minOccurrences: 2 },
        onLoop: { default: 'escalate' },
      });

      for (let i = 0; i < 10; i++) {
        const result = detector.recordStepExecution('worker');
        assert.strictEqual(result.type, 'ok');
      }
    });
  });

  describe('recordResponse', () => {
    it('should detect similar responses', () => {
      const detector = createLoopDetector({
        enabled: true,
        maxStepIterations: { default: 5, worker: 3, judge: 3, replan: 2 },
        similarityDetection: {
          enabled: true,
          threshold: 0.8,
          windowSize: 3,
        },
        transitionPatternDetection: { enabled: false, minOccurrences: 2 },
        onLoop: { default: 'escalate' },
      });

      const response1 = 'The task has been completed successfully with all tests passing.';
      const response2 = 'The task has been completed successfully with all tests passing.';

      detector.recordResponse('worker', response1);
      const result = detector.recordResponse('worker', response2);

      assert.strictEqual(result.type, 'similar_response');
      if (result.type === 'similar_response') {
        assert.strictEqual(result.stepName, 'worker');
        assert.ok(result.similarity >= 0.8);
      }
    });

    it('should not detect dissimilar responses', () => {
      const detector = createLoopDetector({
        enabled: true,
        maxStepIterations: { default: 5, worker: 3, judge: 3, replan: 2 },
        similarityDetection: {
          enabled: true,
          threshold: 0.8,
          windowSize: 3,
        },
        transitionPatternDetection: { enabled: false, minOccurrences: 2 },
        onLoop: { default: 'escalate' },
      });

      const response1 = 'Task A completed with implementation of feature X.';
      const response2 = 'Error occurred during build process, fixing type issues.';

      detector.recordResponse('worker', response1);
      const result = detector.recordResponse('worker', response2);

      assert.strictEqual(result.type, 'ok');
    });
  });

  describe('recordTransition', () => {
    it('should detect transition patterns', () => {
      const detector = createLoopDetector({
        enabled: true,
        maxStepIterations: { default: 5, worker: 3, judge: 3, replan: 2 },
        similarityDetection: { enabled: false, threshold: 0.8, windowSize: 3 },
        transitionPatternDetection: {
          enabled: true,
          minOccurrences: 2,
        },
        onLoop: { default: 'escalate' },
      });

      const transitions: StateTransition[] = [
        { from: 'plan', to: 'implement', reason: 'start', timestamp: '2026-01-01T00:00:00Z' },
        { from: 'implement', to: 'review', reason: 'done', timestamp: '2026-01-01T00:01:00Z' },
        { from: 'review', to: 'plan', reason: 'issues', timestamp: '2026-01-01T00:02:00Z' },
        { from: 'plan', to: 'implement', reason: 'retry', timestamp: '2026-01-01T00:03:00Z' },
        { from: 'implement', to: 'review', reason: 'done', timestamp: '2026-01-01T00:04:00Z' },
        { from: 'review', to: 'plan', reason: 'issues', timestamp: '2026-01-01T00:05:00Z' },
      ];

      let lastResult: ReturnType<typeof detector.recordTransition> | undefined;
      for (const t of transitions) {
        lastResult = detector.recordTransition(t);
      }

      // Should detect the plan -> implement -> review pattern repeating
      assert.ok(lastResult !== undefined, 'Expected lastResult to be defined');
      assert.strictEqual(lastResult.type, 'transition_pattern');
      if (lastResult.type === 'transition_pattern') {
        assert.ok(lastResult.pattern.length >= 2);
        assert.ok(lastResult.occurrences >= 2);
      }
    });
  });

  describe('determineAction', () => {
    it('should return escalate for step_iteration_exceeded', () => {
      const detector = createLoopDetector();

      const action = detector.determineAction({
        type: 'step_iteration_exceeded',
        stepName: 'worker',
        count: 4,
        max: 3,
      });

      assert.strictEqual(action.type, 'escalate');
      if (action.type === 'escalate') {
        assert.strictEqual(action.target, 'user');
      }
    });

    it('should return retry_with_hint for similar_response', () => {
      const detector = createLoopDetector();

      const action = detector.determineAction({
        type: 'similar_response',
        stepName: 'worker',
        similarity: 0.85,
        threshold: 0.8,
      });

      assert.strictEqual(action.type, 'retry_with_hint');
      if (action.type === 'retry_with_hint') {
        assert.ok(action.hint.includes('85%'));
      }
    });

    it('should return escalate to planner for transition_pattern', () => {
      const detector = createLoopDetector();

      const action = detector.determineAction({
        type: 'transition_pattern',
        pattern: [],
        occurrences: 2,
      });

      assert.strictEqual(action.type, 'escalate');
      if (action.type === 'escalate') {
        assert.strictEqual(action.target, 'planner');
      }
    });
  });

  describe('reset', () => {
    it('should clear all state', () => {
      const detector = createLoopDetector();

      detector.recordStepExecution('worker');
      detector.recordResponse('worker', 'test response');
      detector.recordTransition({
        from: 'a',
        to: 'b',
        reason: 'test',
        timestamp: '2026-01-01T00:00:00Z',
      });

      detector.reset();

      const state = detector.getState();
      assert.strictEqual(state.stepIterations.size, 0);
      assert.strictEqual(state.responseHistory.length, 0);
      assert.strictEqual(state.transitions.length, 0);
    });
  });
});
