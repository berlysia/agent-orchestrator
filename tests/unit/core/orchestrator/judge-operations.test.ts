import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import {
  createJudgeOperations,
  type JudgeDeps,
} from '../../../../src/core/orchestrator/judge-operations.ts';
import { createInitialTask } from '../../../../src/types/task.ts';
import { TaskState } from '../../../../src/types/task.ts';
import { taskId, branchName, runId as createRunId, repoPath } from '../../../../src/types/branded.ts';
import { createOk, createErr } from 'option-t/plain_result';
import { agentExecutionError, logWriteError } from '../../../../src/types/errors.ts';
import type { TaskStore } from '../../../../src/core/task-store/interface.ts';
import type { RunnerEffects } from '../../../../src/core/runner/runner-effects.ts';

describe('Judge Operations', () => {
  describe('judgeTask - Agent-based judgement', () => {
    it('should successfully judge task with agent', async () => {
      const tid = taskId('task-1');
      const task = createInitialTask({
        id: tid,
        repo: repoPath('/app'),
        branch: branchName('feature/test'),
        scopePaths: ['src/'],
        acceptance: 'Feature works correctly',
        context: 'Test context',
        taskType: 'implementation',
      });
      task.state = TaskState.RUNNING;
      const runId = 'run-' + String(task.id) + '-1234567890';

      const mockTaskStore: TaskStore = {
        readTask: mock.fn(async () => createOk(task)),
        updateTaskCAS: mock.fn(),
        listTasks: mock.fn(),
        createTask: mock.fn(),
        deleteTask: mock.fn(),
        writeRun: mock.fn(),
        writeCheck: mock.fn(),
      };

      const mockRunnerEffects: RunnerEffects = {
        readLog: mock.fn(async () =>
          createOk(
            '[2024-01-01] Task started\n[2024-01-01] Feature implemented successfully\n[2024-01-01] All tests passed\n',
          ),
        ),
        runClaudeAgent: mock.fn(async () =>
          createOk({
            finalResponse: JSON.stringify({
              success: true,
              reason: 'All acceptance criteria met',
              missingRequirements: [],
              shouldContinue: false,
            }),
          }),
        ),
        runCodexAgent: mock.fn(),
        ensureRunsDir: mock.fn(),
        initializeLogFile: mock.fn(),
        appendLog: mock.fn(),
        saveRunMetadata: mock.fn(),
        loadRunMetadata: mock.fn(),
        listRunLogs: mock.fn(),
      };

      const deps: JudgeDeps = {
        taskStore: mockTaskStore,
        runnerEffects: mockRunnerEffects,
        appRepoPath: '/app',
        agentType: 'claude',
        model: 'claude-haiku-4-5',
        judgeTaskRetries: 3,
      };

      const ops = createJudgeOperations(deps);
      const result = await ops.judgeTask(tid, runId);

      assert(result.ok);
      assert.strictEqual(result.val.taskId, tid);
      assert.strictEqual(result.val.success, true);
      assert.strictEqual(result.val.shouldContinue, false);
      assert.strictEqual(result.val.reason, 'All acceptance criteria met');
    });

    it('should handle failed task judgement', async () => {
      const tid = taskId('task-2');
      const task = createInitialTask({
        id: tid,
        repo: repoPath('/app'),
        branch: branchName('feature/test'),
        scopePaths: ['src/'],
        acceptance: 'Feature works correctly with all edge cases handled',
        context: 'Test context',
        taskType: 'implementation',
      });
      task.state = TaskState.RUNNING;
      const runId = 'run-' + String(task.id) + '-1234567890';

      const mockTaskStore: TaskStore = {
        readTask: mock.fn(async () => createOk(task)),
        updateTaskCAS: mock.fn(),
        listTasks: mock.fn(),
        createTask: mock.fn(),
        deleteTask: mock.fn(),
        writeRun: mock.fn(),
        writeCheck: mock.fn(),
      };

      const mockRunnerEffects: RunnerEffects = {
        readLog: mock.fn(async () =>
          createOk('[2024-01-01] Task started\n[2024-01-01] Basic feature implemented\n'),
        ),
        runClaudeAgent: mock.fn(async () =>
          createOk({
            finalResponse: JSON.stringify({
              success: false,
              reason: 'Edge cases not handled',
              missingRequirements: ['Error handling for null inputs', 'Validation for edge cases'],
              shouldContinue: true,
            }),
          }),
        ),
        runCodexAgent: mock.fn(),
        ensureRunsDir: mock.fn(),
        initializeLogFile: mock.fn(),
        appendLog: mock.fn(),
        saveRunMetadata: mock.fn(),
        loadRunMetadata: mock.fn(),
        listRunLogs: mock.fn(),
      };

      const deps: JudgeDeps = {
        taskStore: mockTaskStore,
        runnerEffects: mockRunnerEffects,
        appRepoPath: '/app',
        agentType: 'claude',
        model: 'claude-haiku-4-5',
        judgeTaskRetries: 3,
      };

      const ops = createJudgeOperations(deps);
      const result = await ops.judgeTask(tid, runId);

      assert(result.ok);
      assert.strictEqual(result.val.success, false);
      assert.strictEqual(result.val.shouldContinue, true);
      assert.strictEqual(result.val.missingRequirements?.length, 2);
    });

    it('should return error when log not available', async () => {
      const tid = taskId('task-3');
      const task = createInitialTask({
        id: tid,
        repo: repoPath('/app'),
        branch: branchName('feature/test'),
        scopePaths: ['src/'],
        acceptance: 'Feature works',
        context: 'Test context',
        taskType: 'implementation',
      });
      task.state = TaskState.RUNNING;
      const runId = 'run-' + String(task.id) + '-1234567890';

      const mockTaskStore: TaskStore = {
        readTask: mock.fn(async () => createOk(task)),
        updateTaskCAS: mock.fn(),
        listTasks: mock.fn(),
        createTask: mock.fn(),
        deleteTask: mock.fn(),
        writeRun: mock.fn(),
        writeCheck: mock.fn(),
      };

      const mockRunnerEffects: RunnerEffects = {
        readLog: mock.fn(async () => createErr(logWriteError(createRunId(runId), 'Log not found'))),
        runClaudeAgent: mock.fn(),
        runCodexAgent: mock.fn(),
        ensureRunsDir: mock.fn(),
        initializeLogFile: mock.fn(),
        appendLog: mock.fn(),
        saveRunMetadata: mock.fn(),
        loadRunMetadata: mock.fn(),
        listRunLogs: mock.fn(),
      };

      const deps: JudgeDeps = {
        taskStore: mockTaskStore,
        runnerEffects: mockRunnerEffects,
        appRepoPath: '/app',
        agentType: 'claude',
        model: 'claude-haiku-4-5',
        judgeTaskRetries: 3,
      };

      const ops = createJudgeOperations(deps);
      const result = await ops.judgeTask(tid, runId);

      assert(!result.ok);
      assert(result.err.message.includes('Failed to read log'));
    });

    it('should return error when agent execution fails', async () => {
      const tid = taskId('task-4');
      const task = createInitialTask({
        id: tid,
        repo: repoPath('/app'),
        branch: branchName('feature/test'),
        scopePaths: ['src/'],
        acceptance: 'Feature works',
        context: 'Test context',
        taskType: 'implementation',
      });
      task.state = TaskState.RUNNING;
      const runId = 'run-' + String(task.id) + '-1234567890';

      const mockTaskStore: TaskStore = {
        readTask: mock.fn(async () => createOk(task)),
        updateTaskCAS: mock.fn(),
        listTasks: mock.fn(),
        createTask: mock.fn(),
        deleteTask: mock.fn(),
        writeRun: mock.fn(),
        writeCheck: mock.fn(),
      };

      const mockRunnerEffects: RunnerEffects = {
        readLog: mock.fn(async () => createOk('Log content')),
        runClaudeAgent: mock.fn(async () => createErr(agentExecutionError('claude', 'Agent failed'))),
        runCodexAgent: mock.fn(),
        ensureRunsDir: mock.fn(),
        initializeLogFile: mock.fn(),
        appendLog: mock.fn(),
        saveRunMetadata: mock.fn(),
        loadRunMetadata: mock.fn(),
        listRunLogs: mock.fn(),
      };

      const deps: JudgeDeps = {
        taskStore: mockTaskStore,
        runnerEffects: mockRunnerEffects,
        appRepoPath: '/app',
        agentType: 'claude',
        model: 'claude-haiku-4-5',
        judgeTaskRetries: 3,
      };

      const ops = createJudgeOperations(deps);
      const result = await ops.judgeTask(tid, runId);

      assert(!result.ok);
      assert(result.err.message.includes('Judge agent execution failed'));
    });

    it('should return error when response parsing fails', async () => {
      const tid = taskId('task-5');
      const task = createInitialTask({
        id: tid,
        repo: repoPath('/app'),
        branch: branchName('feature/test'),
        scopePaths: ['src/'],
        acceptance: 'Feature works',
        context: 'Test context',
        taskType: 'implementation',
      });
      task.state = TaskState.RUNNING;
      const runId = 'run-' + String(task.id) + '-1234567890';

      const mockTaskStore: TaskStore = {
        readTask: mock.fn(async () => createOk(task)),
        updateTaskCAS: mock.fn(),
        listTasks: mock.fn(),
        createTask: mock.fn(),
        deleteTask: mock.fn(),
        writeRun: mock.fn(),
        writeCheck: mock.fn(),
      };

      const mockRunnerEffects: RunnerEffects = {
        readLog: mock.fn(async () => createOk('Log content')),
        runClaudeAgent: mock.fn(async () =>
          createOk({
            finalResponse: 'Invalid JSON response',
          }),
        ),
        runCodexAgent: mock.fn(),
        ensureRunsDir: mock.fn(),
        initializeLogFile: mock.fn(),
        appendLog: mock.fn(),
        saveRunMetadata: mock.fn(),
        loadRunMetadata: mock.fn(),
        listRunLogs: mock.fn(),
      };

      const deps: JudgeDeps = {
        taskStore: mockTaskStore,
        runnerEffects: mockRunnerEffects,
        appRepoPath: '/app',
        agentType: 'claude',
        model: 'claude-haiku-4-5',
        judgeTaskRetries: 3,
      };

      const ops = createJudgeOperations(deps);
      const result = await ops.judgeTask(tid, runId);

      assert(!result.ok);
      assert(result.err.message.includes('Failed to parse judge response'));
    });

    it('should retry when rate limited and then succeed', async () => {
      const tid = taskId('task-8');
      const task = createInitialTask({
        id: tid,
        repo: repoPath('/app'),
        branch: branchName('feature/test'),
        scopePaths: ['src/'],
        acceptance: 'Feature works',
        context: 'Test context',
        taskType: 'implementation',
      });
      task.state = TaskState.RUNNING;
      const runId = 'run-' + String(task.id) + '-1234567890';

      const mockTaskStore: TaskStore = {
        readTask: mock.fn(async () => createOk(task)),
        updateTaskCAS: mock.fn(),
        listTasks: mock.fn(),
        createTask: mock.fn(),
        deleteTask: mock.fn(),
        writeRun: mock.fn(),
        writeCheck: mock.fn(),
      };

      const rateLimitError = agentExecutionError('claude', {
        status: 429,
        headers: { 'retry-after': '0' },
      });

      const mockRunnerEffects: RunnerEffects = {
        readLog: mock.fn(async () => createOk('Log content')),
        runClaudeAgent: mock.fn(async () => createErr(rateLimitError)),
        runCodexAgent: mock.fn(),
        ensureRunsDir: mock.fn(),
        initializeLogFile: mock.fn(),
        appendLog: mock.fn(),
        saveRunMetadata: mock.fn(),
        loadRunMetadata: mock.fn(),
        listRunLogs: mock.fn(),
      };

      const deps: JudgeDeps = {
        taskStore: mockTaskStore,
        runnerEffects: mockRunnerEffects,
        appRepoPath: '/app',
        agentType: 'claude',
        model: 'claude-haiku-4-5',
        judgeTaskRetries: 2,
      };

      const ops = createJudgeOperations(deps);

      let callCount = 0;
      mockRunnerEffects.runClaudeAgent = mock.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          return createErr(rateLimitError);
        }
        return createOk({
          finalResponse: JSON.stringify({
            success: true,
            reason: 'All acceptance criteria met',
            missingRequirements: [],
            shouldContinue: false,
          }),
        });
      });

      const result = await ops.judgeTask(tid, runId);

      assert(result.ok);
      assert.strictEqual(callCount, 2);
      assert.strictEqual(result.val.success, true);
    });

    it('should handle task not in RUNNING state', async () => {
      const tid = taskId('task-6');
      const task = createInitialTask({
        id: tid,
        repo: repoPath('/app'),
        branch: branchName('feature/test'),
        scopePaths: ['src/'],
        acceptance: 'Feature works',
        context: 'Test context',
        taskType: 'implementation',
      });
      task.state = TaskState.DONE; // Already completed
      const runId = 'run-' + String(task.id) + '-1234567890';

      const mockTaskStore: TaskStore = {
        readTask: mock.fn(async () => createOk(task)),
        updateTaskCAS: mock.fn(),
        listTasks: mock.fn(),
        createTask: mock.fn(),
        deleteTask: mock.fn(),
        writeRun: mock.fn(),
        writeCheck: mock.fn(),
      };

      const mockRunnerEffects: RunnerEffects = {
        readLog: mock.fn(),
        runClaudeAgent: mock.fn(),
        runCodexAgent: mock.fn(),
        ensureRunsDir: mock.fn(),
        initializeLogFile: mock.fn(),
        appendLog: mock.fn(),
        saveRunMetadata: mock.fn(),
        loadRunMetadata: mock.fn(),
        listRunLogs: mock.fn(),
      };

      const deps: JudgeDeps = {
        taskStore: mockTaskStore,
        runnerEffects: mockRunnerEffects,
        appRepoPath: '/app',
        agentType: 'claude',
        model: 'claude-haiku-4-5',
        judgeTaskRetries: 3,
      };

      const ops = createJudgeOperations(deps);
      const result = await ops.judgeTask(tid, runId);

      assert(result.ok);
      assert.strictEqual(result.val.success, false);
      assert(result.val.reason.includes('not in RUNNING state'));
    });

    it('should parse JSON from markdown code blocks', async () => {
      const tid = taskId('task-7');
      const task = createInitialTask({
        id: tid,
        repo: repoPath('/app'),
        branch: branchName('feature/test'),
        scopePaths: ['src/'],
        acceptance: 'Feature works',
        context: 'Test context',
        taskType: 'implementation',
      });
      task.state = TaskState.RUNNING;
      const runId = 'run-' + String(task.id) + '-1234567890';

      const mockTaskStore: TaskStore = {
        readTask: mock.fn(async () => createOk(task)),
        updateTaskCAS: mock.fn(),
        listTasks: mock.fn(),
        createTask: mock.fn(),
        deleteTask: mock.fn(),
        writeRun: mock.fn(),
        writeCheck: mock.fn(),
      };

      const mockRunnerEffects: RunnerEffects = {
        readLog: mock.fn(async () => createOk('Log content')),
        runClaudeAgent: mock.fn(async () =>
          createOk({
            finalResponse: `Here is my judgement:

\`\`\`json
{
  "success": true,
  "reason": "Task completed successfully",
  "missingRequirements": [],
  "shouldContinue": false
}
\`\`\``,
          }),
        ),
        runCodexAgent: mock.fn(),
        ensureRunsDir: mock.fn(),
        initializeLogFile: mock.fn(),
        appendLog: mock.fn(),
        saveRunMetadata: mock.fn(),
        loadRunMetadata: mock.fn(),
        listRunLogs: mock.fn(),
      };

      const deps: JudgeDeps = {
        taskStore: mockTaskStore,
        runnerEffects: mockRunnerEffects,
        appRepoPath: '/app',
        agentType: 'claude',
        model: 'claude-haiku-4-5',
        judgeTaskRetries: 3,
      };

      const ops = createJudgeOperations(deps);
      const result = await ops.judgeTask(tid, runId);

      assert(result.ok);
      assert.strictEqual(result.val.success, true);
      assert.strictEqual(result.val.reason, 'Task completed successfully');
    });
  });

  describe('markTaskAsCompleted', () => {
    it('should update task state to DONE', async () => {
      const tid = taskId('task-1');
      const task = createInitialTask({
        id: tid,
        repo: repoPath('/app'),
        branch: branchName('feature/test'),
        scopePaths: ['src/'],
        acceptance: 'Feature works',
        context: 'Test context',
        taskType: 'implementation',
      });
      task.state = TaskState.RUNNING;

      const updatedTask = { ...task, state: TaskState.DONE, owner: null };

      const mockTaskStore: TaskStore = {
        readTask: mock.fn(async () => createOk(task)),
        updateTaskCAS: mock.fn(async () => createOk(updatedTask)),
        listTasks: mock.fn(),
        createTask: mock.fn(),
        deleteTask: mock.fn(),
        writeRun: mock.fn(),
        writeCheck: mock.fn(),
      };

      const mockRunnerEffects: RunnerEffects = {
        readLog: mock.fn(),
        runClaudeAgent: mock.fn(),
        runCodexAgent: mock.fn(),
        ensureRunsDir: mock.fn(),
        initializeLogFile: mock.fn(),
        appendLog: mock.fn(),
        saveRunMetadata: mock.fn(),
        loadRunMetadata: mock.fn(),
        listRunLogs: mock.fn(),
      };

      const deps: JudgeDeps = {
        taskStore: mockTaskStore,
        runnerEffects: mockRunnerEffects,
        appRepoPath: '/app',
        agentType: 'claude',
        model: 'claude-haiku-4-5',
        judgeTaskRetries: 3,
      };

      const ops = createJudgeOperations(deps);
      const result = await ops.markTaskAsCompleted(tid);

      assert(result.ok);
      assert.strictEqual(result.val.state, TaskState.DONE);
      assert.strictEqual(result.val.owner, null);
    });
  });

  describe('markTaskAsBlocked', () => {
    it('should update task state to BLOCKED', async () => {
      const tid = taskId('task-1');
      const task = createInitialTask({
        id: tid,
        repo: repoPath('/app'),
        branch: branchName('feature/test'),
        scopePaths: ['src/'],
        acceptance: 'Feature works',
        context: 'Test context',
        taskType: 'implementation',
      });
      task.state = TaskState.RUNNING;

      const updatedTask = { ...task, state: TaskState.BLOCKED, owner: null };

      const mockTaskStore: TaskStore = {
        readTask: mock.fn(async () => createOk(task)),
        updateTaskCAS: mock.fn(async () => createOk(updatedTask)),
        listTasks: mock.fn(),
        createTask: mock.fn(),
        deleteTask: mock.fn(),
        writeRun: mock.fn(),
        writeCheck: mock.fn(),
      };

      const mockRunnerEffects: RunnerEffects = {
        readLog: mock.fn(),
        runClaudeAgent: mock.fn(),
        runCodexAgent: mock.fn(),
        ensureRunsDir: mock.fn(),
        initializeLogFile: mock.fn(),
        appendLog: mock.fn(),
        saveRunMetadata: mock.fn(),
        loadRunMetadata: mock.fn(),
        listRunLogs: mock.fn(),
      };

      const deps: JudgeDeps = {
        taskStore: mockTaskStore,
        runnerEffects: mockRunnerEffects,
        appRepoPath: '/app',
        agentType: 'claude',
        model: 'claude-haiku-4-5',
        judgeTaskRetries: 3,
      };

      const ops = createJudgeOperations(deps);
      const result = await ops.markTaskAsBlocked(tid);

      assert(result.ok);
      assert.strictEqual(result.val.state, TaskState.BLOCKED);
      assert.strictEqual(result.val.owner, null);
    });
  });
});
