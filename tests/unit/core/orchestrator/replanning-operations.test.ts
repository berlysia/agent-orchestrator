import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildReplanningPrompt,
} from '../../../../src/core/orchestrator/replanning-operations.ts';
import {
  TaskState,
  type Task,
  createInitialTask,
} from '../../../../src/types/task.ts';
import {
  taskId,
  workerId,
  runId,
  branchName,
  repoPath,
} from '../../../../src/types/branded.ts';
import type { JudgementResult } from '../../../../src/core/orchestrator/judge-operations.ts';

describe('Replanning Operations', () => {
  const createMockTask = (): Task => {
    const task = createInitialTask({
      id: taskId('task-1'),
      repo: repoPath('/app/repo'),
      branch: branchName('feature/large-task'),
      scopePaths: ['src/feature.ts'],
      acceptance: 'Feature should be implemented',
      taskType: 'implementation',
      context: 'This is a large task',
      dependencies: [],
    });
    task.state = TaskState.RUNNING;
    task.owner = workerId('worker-1');
    task.plannerRunId = runId('planner-1');
    return task;
  };

  const createMockJudgement = (): JudgementResult => ({
    taskId: taskId('task-1'),
    success: false,
    shouldContinue: false,
    shouldReplan: true,
    reason: 'Task scope is too large for single iteration',
    missingRequirements: ['Split into smaller subtasks'],
  });

  describe('buildReplanningPrompt', () => {
    it('should build prompt with task info, run log, and judgement', () => {
      const mockTask = createMockTask();
      const mockJudgement = createMockJudgement();
      const runLog = 'Worker execution log...';

      const prompt = buildReplanningPrompt(mockTask, runLog, mockJudgement);

      // プロンプトに必要な情報が含まれているか確認
      assert.match(prompt, /feature\/large-task/);
      assert.match(prompt, /Feature should be implemented/);
      assert.match(prompt, /Worker execution log/);
      assert.match(prompt, /Task scope is too large for single iteration/);
      assert.match(prompt, /Split into smaller subtasks/);
      assert.match(prompt, /JSON/i);
    });

    it('should truncate long logs', () => {
      const mockTask = createMockTask();
      const mockJudgement = createMockJudgement();
      const longLog = 'A'.repeat(10000);

      const prompt = buildReplanningPrompt(mockTask, longLog, mockJudgement);

      // プロンプトが長すぎないことを確認
      assert.ok(prompt.length < 15000);
      assert.match(prompt, /truncated/);
    });
  });
});
