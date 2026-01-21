import { test } from 'node:test';
import assert from 'node:assert';
import { executeTaskPipeline } from '../../src/core/orchestrator/task-execution-pipeline.ts';
import { createInitialTask } from '../../src/types/task.ts';
import { taskId, repoPath, branchName } from '../../src/types/branded.ts';
import { initialSchedulerState } from '../../src/core/orchestrator/scheduler-state.ts';
import type { TaskStore } from '../../src/core/task-store/interface.ts';
import { createSchedulerOperations } from '../../src/core/orchestrator/scheduler-operations.ts';
import { createWorkerOperations } from '../../src/core/orchestrator/worker-operations.ts';
import { createJudgeOperations } from '../../src/core/orchestrator/judge-operations.ts';
import type { GitEffects } from '../../src/adapters/vcs/git-effects.ts';
import { createBaseBranchResolver } from '../../src/core/orchestrator/base-branch-resolver.ts';
import type { Config } from '../../src/types/config.ts';

type SchedulerOperations = ReturnType<typeof createSchedulerOperations>;
type WorkerOperations = ReturnType<typeof createWorkerOperations>;
type JudgeOperations = ReturnType<typeof createJudgeOperations>;
type BaseBranchResolver = ReturnType<typeof createBaseBranchResolver>;

test('task-execution-pipeline', async (t) => {
  await t.test('executeTaskPipeline - should handle empty task list', async () => {
    const mockConfig = {
      iterations: { serialChainTaskRetries: 3 },
    } as Config;

    const mockTaskStore = {} as TaskStore;
    const mockSchedulerOps = {
      blockTask: async () => {},
    } as unknown as SchedulerOperations;
    const mockWorkerOps = {} as WorkerOperations;
    const mockJudgeOps = {} as JudgeOperations;
    const mockGitEffects = {} as GitEffects;
    const mockBaseBranchResolver = {} as BaseBranchResolver;

    const result = await executeTaskPipeline({
      tasks: [],
      taskStore: mockTaskStore,
      schedulerOps: mockSchedulerOps,
      workerOps: mockWorkerOps,
      judgeOps: mockJudgeOps,
      gitEffects: mockGitEffects,
      baseBranchResolver: mockBaseBranchResolver,
      config: mockConfig,
      maxWorkers: 3,
      initialSchedulerState: initialSchedulerState(3),
    });

    assert.strictEqual(result.completedTaskIds.length, 0);
    assert.strictEqual(result.failedTaskIds.length, 0);
    assert.strictEqual(result.blockedTaskIds.length, 0);
  });

  // NOTE: タスクを含むパイプライン実行は実際の依存関係（executeDynamically等）を呼び出すため、
  // 完全なモックが必要で複雑になります。実際の動作はE2Eテストで検証されます。
});
