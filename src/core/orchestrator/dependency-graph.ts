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
 * @param globalTaskIds グローバルなタスクIDセット（部分グラフ構築時に使用）
 * @returns 依存関係グラフ
 */
export function buildDependencyGraph(tasks: Task[], globalTaskIds?: Set<TaskId>): DependencyGraph {
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
  const missingDependencies: Array<{ taskId: TaskId; missingDepId: TaskId }> = [];

  for (const task of tasks) {
    for (const depId of task.dependencies) {
      // 依存先タスクが存在するか確認
      if (!allTaskIds.has(depId)) {
        // グローバルタスクセットが提供されている場合、そちらで存在確認
        if (globalTaskIds && globalTaskIds.has(depId)) {
          // 依存先はグローバルには存在するが、このサブグラフには含まれていない（例: serial chain）
          // この場合は警告を出さず、エッジも追加しない（別途実行される）
          continue;
        }

        missingDependencies.push({ taskId: task.id, missingDepId: depId });
        console.warn(`⚠️  Task ${String(task.id)} depends on non-existent task ${String(depId)}`);
        continue; // 存在しない依存関係はスキップ
      }

      // task.id は depId に依存する
      adjacencyList.get(task.id)!.push(depId);
      // 逆方向：depId は task.id に依存される
      reverseAdjacencyList.get(depId)!.push(task.id);
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

/**
 * 直列チェーン（連続した依存関係）を検出
 *
 * WHY: 直列チェーンのタスクは同じworktreeを共有することで、前のタスクの変更を次のタスクに引き継げる
 *
 * 例:
 * - A → B → C は直列チェーン（BはAにのみ依存、CはBにのみ依存）
 * - A → B ← D の場合、BはAとDに依存されるため、A→Bは直列チェーンではない
 *
 * @param graph 依存関係グラフ
 * @returns 直列チェーンの配列（各チェーンはTaskId配列）
 */
export function detectSerialChains(graph: DependencyGraph): TaskId[][] {
  const { adjacencyList, reverseAdjacencyList, allTaskIds } = graph;

  const visited = new Set<TaskId>();
  const chains: TaskId[][] = [];

  // 入次数（依存先の数）を計算
  const inDegree = new Map<TaskId, number>();
  for (const taskId of allTaskIds) {
    const deps = adjacencyList.get(taskId) || [];
    inDegree.set(taskId, deps.length);
  }

  // 出次数（依存元の数）を計算
  const outDegree = new Map<TaskId, number>();
  for (const taskId of allTaskIds) {
    const dependents = reverseAdjacencyList.get(taskId) || [];
    outDegree.set(taskId, dependents.length);
  }

  /**
   * 特定のタスクから直列チェーンを構築
   */
  function buildChainFrom(startTaskId: TaskId): TaskId[] | null {
    const chain: TaskId[] = [startTaskId];
    let current = startTaskId;

    while (true) {
      const dependents = reverseAdjacencyList.get(current) || [];

      // 出次数が1でない場合、チェーン終了
      if (dependents.length !== 1) {
        break;
      }

      const next = dependents[0];
      if (!next) break; // 型安全性のためのガード（実際には発生しない）

      // 次のタスクが既に訪問済みの場合、チェーン終了（循環防止）
      if (visited.has(next)) {
        break;
      }

      // 次のタスクの入次数が1でない場合、チェーン終了
      const nextInDegree = inDegree.get(next) || 0;
      if (nextInDegree !== 1) {
        break;
      }

      // チェーンを継続
      chain.push(next);
      visited.add(next);
      current = next;
    }

    // チェーンの長さが2以上の場合のみ返す
    return chain.length >= 2 ? chain : null;
  }

  // すべてのタスクについて、チェーンの開始点になりうるかチェック
  for (const taskId of allTaskIds) {
    if (visited.has(taskId)) {
      continue;
    }

    // 入次数0（依存先なし）のタスクはチェーンの開始点候補
    const taskInDegree = inDegree.get(taskId) || 0;
    if (taskInDegree === 0) {
      const chain = buildChainFrom(taskId);
      if (chain) {
        // チェーン内のすべてのタスクを訪問済みにマーク
        for (const tid of chain) {
          visited.add(tid);
        }
        chains.push(chain);
      }
    }
  }

  return chains;
}
