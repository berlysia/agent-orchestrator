import type { Task } from '../../types/task.ts';
import type { TaskId } from '../../types/branded.ts';

/**
 * 依存関係グラフ
 *
 * WHY: タスク間の依存関係を表現し、並列実行可能なタスクを特定するため
 */
export interface DependencyGraph {
  /** タスクID → 依存先タスクID配列のマップ（A→Bの場合、AはBに依存） */
  adjacencyList: Map<TaskId, TaskId[]>;
  /** タスクID → 依存元タスクID配列のマップ（逆グラフ、B←Aの場合、BはAに依存される） */
  reverseAdjacencyList: Map<TaskId, TaskId[]>;
  /** 全タスクIDのセット */
  allTaskIds: Set<TaskId>;
  /** 循環依存が検出された場合のタスクID配列 */
  cyclicDependencies: TaskId[] | null;
}

/**
 * 実行レベル計算結果
 *
 * WHY: トポロジカルソートの結果、同レベルのタスクは並列実行可能
 */
export interface ExecutionLevels {
  /** レベルごとのタスクIDの配列（レベル0から順に実行） */
  levels: TaskId[][];
  /** スケジュール不可能なタスクID（循環依存など） */
  unschedulable: TaskId[];
}

/**
 * タスク配列から依存関係グラフを構築
 *
 * @param tasks タスク配列
 * @returns 依存関係グラフ
 */
export function buildDependencyGraph(tasks: Task[]): DependencyGraph {
  const adjacencyList = new Map<TaskId, TaskId[]>();
  const reverseAdjacencyList = new Map<TaskId, TaskId[]>();
  const allTaskIds = new Set<TaskId>();

  // 初期化：すべてのタスクIDを登録
  for (const task of tasks) {
    allTaskIds.add(task.id);
    adjacencyList.set(task.id, []);
    reverseAdjacencyList.set(task.id, []);
  }

  // エッジを構築
  for (const task of tasks) {
    for (const depId of task.dependencies) {
      // task.id は depId に依存する
      adjacencyList.get(task.id)!.push(depId);
      // 逆方向：depId は task.id に依存される
      reverseAdjacencyList.get(depId)?.push(task.id);
    }
  }

  const graph: DependencyGraph = {
    adjacencyList,
    reverseAdjacencyList,
    allTaskIds,
    cyclicDependencies: null,
  };

  // 循環依存を検出
  const cycles = detectCycles(graph);
  if (cycles && cycles.length > 0) {
    graph.cyclicDependencies = cycles;
  }

  return graph;
}

/**
 * Tarjan's Strongly Connected Components (SCC) アルゴリズムで循環依存を検出
 *
 * WHY: 循環依存があるタスクはスケジュール不可能なため、事前に検出して警告する
 *
 * @param graph 依存関係グラフ
 * @returns 循環依存に含まれるタスクID配列（循環依存がない場合はnull）
 */
export function detectCycles(graph: DependencyGraph): TaskId[] | null {
  const { adjacencyList, allTaskIds } = graph;

  const visited = new Set<TaskId>();
  const recStack = new Set<TaskId>();
  const cyclicNodes = new Set<TaskId>();

  /**
   * DFSで循環依存を検出
   */
  function dfs(node: TaskId): boolean {
    visited.add(node);
    recStack.add(node);

    const neighbors = adjacencyList.get(node) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) {
          cyclicNodes.add(node);
          return true;
        }
      } else if (recStack.has(neighbor)) {
        // 循環依存を検出
        cyclicNodes.add(node);
        cyclicNodes.add(neighbor);
        return true;
      }
    }

    recStack.delete(node);
    return false;
  }

  // すべてのノードを探索
  for (const taskId of allTaskIds) {
    if (!visited.has(taskId)) {
      dfs(taskId);
    }
  }

  return cyclicNodes.size > 0 ? Array.from(cyclicNodes) : null;
}

/**
 * Kahn's Algorithm でトポロジカルソートを実行し、実行レベルを計算
 *
 * WHY: 依存関係を満たしつつ、並列実行可能なタスクをレベル分けする
 *
 * 実行例:
 * - Level 0: [A, B]     ← 依存なし、並列実行可能
 * - Level 1: [C]        ← A,Bに依存
 * - Level 2: [D, E, F]  ← Cに依存、並列実行可能
 *
 * @param graph 依存関係グラフ
 * @returns 実行レベル
 */
export function computeExecutionLevels(graph: DependencyGraph): ExecutionLevels {
  const { adjacencyList, allTaskIds, cyclicDependencies } = graph;

  // 循環依存があるタスクはスケジュール不可能
  const unschedulable = cyclicDependencies ? [...cyclicDependencies] : [];
  const schedulableIds = new Set(
    Array.from(allTaskIds).filter((id) => !unschedulable.includes(id)),
  );

  if (schedulableIds.size === 0) {
    return { levels: [], unschedulable };
  }

  // 入次数（依存先の数）を計算
  const inDegree = new Map<TaskId, number>();
  for (const taskId of schedulableIds) {
    const deps = adjacencyList.get(taskId) || [];
    // スケジュール可能な依存先のみをカウント
    const schedulableDeps = deps.filter((depId) => schedulableIds.has(depId));
    inDegree.set(taskId, schedulableDeps.length);
  }

  // レベル0: 依存先が0のタスク
  const levels: TaskId[][] = [];
  let currentLevel = Array.from(schedulableIds).filter((id) => inDegree.get(id) === 0);

  while (currentLevel.length > 0) {
    levels.push([...currentLevel]);

    const nextLevel: TaskId[] = [];

    for (const taskId of currentLevel) {
      // このタスクに依存しているタスクの入次数を減らす
      const dependents = graph.reverseAdjacencyList.get(taskId) || [];
      for (const depId of dependents) {
        if (!schedulableIds.has(depId)) continue;

        const currentInDegree = inDegree.get(depId)!;
        inDegree.set(depId, currentInDegree - 1);

        if (inDegree.get(depId) === 0) {
          nextLevel.push(depId);
        }
      }
    }

    currentLevel = nextLevel;
  }

  // トポロジカルソート完了後、まだ処理されていないタスクは循環依存の一部
  const processedCount = levels.reduce((sum, level) => sum + level.length, 0);
  if (processedCount < schedulableIds.size) {
    const remaining = Array.from(schedulableIds).filter((id) => {
      return !levels.some((level) => level.includes(id));
    });
    unschedulable.push(...remaining);
  }

  return { levels, unschedulable };
}
