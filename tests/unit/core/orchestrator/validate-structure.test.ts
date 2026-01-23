import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateStructure } from '../../../../src/core/orchestrator/planner-operations.ts';
import type { Task } from '../../../../src/types/task.ts';
import type { RefinementConfig } from '../../../../src/types/planner-session.ts';
import { TaskState } from '../../../../src/types/task.ts';
import { taskId, branchName, repoPath } from '../../../../src/types/branded.ts';

/**
 * テスト用のTask生成ヘルパー関数
 *
 * @param id タスクID
 * @param deps 依存タスクIDの配列
 * @returns Taskオブジェクト
 */
function createTestTask(id: string, deps: string[] = []): Task {
  return {
    id: taskId(id),
    summary: `Test task ${id}`,
    acceptance: `Acceptance criteria for ${id}`,
    branch: branchName(`feature/${id}`),
    scopePaths: ['src/'],
    dependencies: deps.map((d) => taskId(d)),
    state: TaskState.READY,
    blockReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    repo: repoPath('/test/repo'),
    version: 0,
    owner: null,
    taskType: 'implementation',
    context: `Context for ${id}`,
    check: null,
    integrationRetried: false,
  };
}

/**
 * デフォルトのRefinementConfig
 */
const defaultConfig: RefinementConfig = {
  maxRefinementAttempts: 2,
  refineSuggestionsOnSuccess: false,
  maxSuggestionReplans: 1,
  enableIndividualFallback: true,
  deltaThreshold: 5,
  deltaThresholdPercent: 5,
  taskCountChangeThreshold: 0.3, // 30%
  taskCountChangeMinAbsolute: 2,
  targetScore: 85,
};

describe('validateStructure', () => {
  it('正常なタスクリストでisValid=trueを返す', () => {
    const originalTasks = [
      createTestTask('task-1'),
      createTestTask('task-2', ['task-1']),
      createTestTask('task-3', ['task-2']),
    ];

    const newTasks = [
      createTestTask('task-1'),
      createTestTask('task-2', ['task-1']),
      createTestTask('task-3', ['task-2']),
    ];

    const result = validateStructure(originalTasks, newTasks, defaultConfig);

    assert.strictEqual(result.isValid, true);
    assert.strictEqual(result.hasDependencyIssues, false);
    assert.strictEqual(result.hasCyclicDependency, false);
    assert.strictEqual(result.taskCountChange, 0);
    assert.strictEqual(result.absoluteTaskCountDiff, 0);
  });

  it('タスク数変化率が閾値を超えるとisValid=false', () => {
    // 元3タスク → 新6タスク（100%変化、絶対差3）
    const originalTasks = [
      createTestTask('task-1'),
      createTestTask('task-2'),
      createTestTask('task-3'),
    ];

    const newTasks = [
      createTestTask('task-1'),
      createTestTask('task-2'),
      createTestTask('task-3'),
      createTestTask('task-4'),
      createTestTask('task-5'),
      createTestTask('task-6'),
    ];

    const result = validateStructure(originalTasks, newTasks, defaultConfig);

    assert.strictEqual(result.isValid, false);
    assert.strictEqual(result.taskCountChange, 1.0); // 100%
    assert.strictEqual(result.absoluteTaskCountDiff, 3);
    assert.ok(result.details);
    assert.ok(result.details.includes('タスク数変化率が閾値超過'));
  });

  it('タスク数変化率が閾値以下ならisValid=true', () => {
    // 元10タスク → 新12タスク（20%変化）
    const originalTasks = Array.from({ length: 10 }, (_, i) =>
      createTestTask(`task-${i + 1}`),
    );

    const newTasks = Array.from({ length: 12 }, (_, i) => createTestTask(`task-${i + 1}`));

    const result = validateStructure(originalTasks, newTasks, defaultConfig);

    assert.strictEqual(result.isValid, true);
    assert.strictEqual(result.taskCountChange, 0.2); // 20%
    assert.strictEqual(result.absoluteTaskCountDiff, 2);
  });

  it('存在しないタスクIDへの依存でhasDependencyIssues=true', () => {
    const originalTasks = [createTestTask('task-1')];

    const newTasks = [createTestTask('task-1', ['non-existent'])];

    const result = validateStructure(originalTasks, newTasks, defaultConfig);

    assert.strictEqual(result.isValid, false);
    assert.strictEqual(result.hasDependencyIssues, true);
    assert.ok(result.details);
    assert.ok(result.details.includes('依存関係不整合'));
    assert.ok(result.details.includes('non-existent'));
  });

  it('循環依存でhasCyclicDependency=true', () => {
    // task-1 → task-2 → task-1 の循環
    const originalTasks = [createTestTask('task-1'), createTestTask('task-2')];

    const newTasks = [createTestTask('task-1', ['task-2']), createTestTask('task-2', ['task-1'])];

    const result = validateStructure(originalTasks, newTasks, defaultConfig);

    assert.strictEqual(result.isValid, false);
    assert.strictEqual(result.hasCyclicDependency, true);
    assert.ok(result.details);
    assert.ok(result.details.includes('循環依存検出'));
  });

  it('自己参照の循環依存を検出', () => {
    // task-1 → task-1 の自己参照
    const originalTasks = [createTestTask('task-1')];

    const newTasks = [createTestTask('task-1', ['task-1'])];

    const result = validateStructure(originalTasks, newTasks, defaultConfig);

    assert.strictEqual(result.isValid, false);
    assert.strictEqual(result.hasCyclicDependency, true);
    assert.ok(result.details);
    assert.ok(result.details.includes('循環依存検出'));
  });

  it('originalTasks.length === 0のときchangeRate=0で処理', () => {
    // 空配列から1タスク追加（0除算エラーが発生しないことを確認）
    const originalTasks: Task[] = [];
    const newTasks = [createTestTask('task-1')];

    const result = validateStructure(originalTasks, newTasks, defaultConfig);

    // changeRate = 0 となり、閾値超過にはならない
    assert.strictEqual(result.taskCountChange, 0);
    assert.strictEqual(result.absoluteTaskCountDiff, 1);
    // 絶対差1は taskCountChangeMinAbsolute(2) 未満なので、isValid=true
    assert.strictEqual(result.isValid, true);
  });

  it('閾値境界値: ちょうど30%変化', () => {
    // 元10タスク → 新13タスク（30%変化）
    const originalTasks = Array.from({ length: 10 }, (_, i) =>
      createTestTask(`task-${i + 1}`),
    );

    const newTasks = Array.from({ length: 13 }, (_, i) => createTestTask(`task-${i + 1}`));

    const result = validateStructure(originalTasks, newTasks, defaultConfig);

    // changeRate = 0.3（ちょうど閾値） → 閾値を超えていないので valid
    // 注: 条件は changeRate > threshold なので、等しい場合はfalseになる
    assert.strictEqual(result.taskCountChange, 0.3);
    assert.strictEqual(result.absoluteTaskCountDiff, 3);
    assert.strictEqual(result.isValid, true);
  });

  it('閾値境界値: 30%を1タスク超える変化', () => {
    // 元10タスク → 新14タスク（40%変化）
    const originalTasks = Array.from({ length: 10 }, (_, i) =>
      createTestTask(`task-${i + 1}`),
    );

    const newTasks = Array.from({ length: 14 }, (_, i) => createTestTask(`task-${i + 1}`));

    const result = validateStructure(originalTasks, newTasks, defaultConfig);

    // changeRate = 0.4 (40%) > 0.3 (30%) かつ absoluteDiff = 4 > 2 なので無効
    assert.strictEqual(result.taskCountChange, 0.4);
    assert.strictEqual(result.absoluteTaskCountDiff, 4);
    assert.strictEqual(result.isValid, false);
  });

  it('absoluteTaskCountDiffが戻り値に含まれる', () => {
    const originalTasks = [createTestTask('task-1'), createTestTask('task-2')];

    const newTasks = [
      createTestTask('task-1'),
      createTestTask('task-2'),
      createTestTask('task-3'),
      createTestTask('task-4'),
      createTestTask('task-5'),
    ];

    const result = validateStructure(originalTasks, newTasks, defaultConfig);

    // absoluteTaskCountDiff フィールドが存在し、正しい値を持つことを確認
    assert.ok('absoluteTaskCountDiff' in result);
    assert.strictEqual(result.absoluteTaskCountDiff, 3);
  });

  it('複数の問題が同時に検出される場合', () => {
    // 元3タスク → 新7タスク（133%変化）、かつ循環依存と不正な依存が存在
    const originalTasks = [
      createTestTask('task-1'),
      createTestTask('task-2'),
      createTestTask('task-3'),
    ];

    const newTasks = [
      createTestTask('task-1', ['task-2', 'non-existent']), // 不正な依存
      createTestTask('task-2', ['task-1']), // 循環依存
      createTestTask('task-3'),
      createTestTask('task-4'),
      createTestTask('task-5'),
      createTestTask('task-6'),
      createTestTask('task-7'),
    ];

    const result = validateStructure(originalTasks, newTasks, defaultConfig);

    assert.strictEqual(result.isValid, false);
    assert.strictEqual(result.hasDependencyIssues, true);
    assert.strictEqual(result.hasCyclicDependency, true);
    assert.ok(result.details);
    assert.ok(result.details.includes('タスク数変化率が閾値超過'));
    assert.ok(result.details.includes('依存関係不整合'));
    assert.ok(result.details.includes('循環依存検出'));
  });

  it('変化率は高いが絶対差が小さい場合はisValid=true', () => {
    // 元1タスク → 新2タスク（100%変化だが絶対差1 < taskCountChangeMinAbsolute）
    const originalTasks = [createTestTask('task-1')];

    const newTasks = [createTestTask('task-1'), createTestTask('task-2')];

    const result = validateStructure(originalTasks, newTasks, defaultConfig);

    // 変化率100%だが、絶対差1 < 2 なので有効
    assert.strictEqual(result.taskCountChange, 1.0);
    assert.strictEqual(result.absoluteTaskCountDiff, 1);
    assert.strictEqual(result.isValid, true);
  });

  it('三者間循環依存を検出', () => {
    // task-1 → task-2 → task-3 → task-1
    const originalTasks = [
      createTestTask('task-1'),
      createTestTask('task-2'),
      createTestTask('task-3'),
    ];

    const newTasks = [
      createTestTask('task-1', ['task-3']),
      createTestTask('task-2', ['task-1']),
      createTestTask('task-3', ['task-2']),
    ];

    const result = validateStructure(originalTasks, newTasks, defaultConfig);

    assert.strictEqual(result.isValid, false);
    assert.strictEqual(result.hasCyclicDependency, true);
  });
});
