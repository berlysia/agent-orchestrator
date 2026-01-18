# Architecture

## Overview

Agent Orchestratorは、Planner/Worker/Judge アーキテクチャに基づくマルチエージェント協働開発ツールです。

## Core Concepts

### 1. Task State Management

タスクは以下の状態を持ちます：

- **READY**: 実行可能（Workerが割り当て待ち）
- **RUNNING**: Worker実行中
- **DONE**: 完了
- **BLOCKED**: エラーや依存関係により実行不可
- **CANCELLED**: ユーザーによる中断

### 2. Concurrency Control (CAS)

**Compare-And-Swap (CAS)** による楽観的並行制御：

```typescript
// versionフィールドで並行更新を検出
const updated = await store.updateTaskCAS(taskId, expectedVersion, (task) => ({
  ...task,
  state: TaskState.RUNNING,
  owner: 'worker-1',
}));
```

**なぜCASが必要か**:

Worktreeで各Workerは独立した作業ディレクトリを持ちますが、**タスク状態管理（agent-coord repo）は共有**されます。
複数Workerが同時に同じタスクを取得（claim）しようとする競合を防ぐため、CASによる楽観的ロックが必要です。

**実装方式**: mkdirベースのロック（ローカル環境用）

- タスク状態更新時のみロック取得: `mkdir .locks/<taskId>` （atomicな操作）
- version不一致時はエラー → リトライ
- Worktree内での作業にはロック不要（独立したディレクトリ）
- 将来的にGit commit方式への移行可能

詳細: [docs/decisions/001-cas-implementation-approach.md](decisions/001-cas-implementation-approach.md)

### 3. Storage Layer

**TaskStore インターフェース**:

```typescript
interface TaskStore {
  createTask(task: Task): Promise<void>;
  readTask(taskId: string): Promise<Task>;
  listTasks(): Promise<Task[]>;
  deleteTask(taskId: string): Promise<void>;
  updateTaskCAS(
    taskId: string,
    expectedVersion: number,
    updateFn: (task: Task) => Task,
  ): Promise<Task>;
  writeRun(run: Run): Promise<void>;
  writeCheck(check: Check): Promise<void>;
}
```

**実装**: FileStore（JSONファイルベース）

```
agent-coord/
  tasks/<taskId>.json       # タスク状態
  runs/<runId>.json         # Worker実行結果
  checks/<checkId>.json     # CI/lint結果
  .locks/<taskId>/          # CASロック
```

## Design Decisions

すべての設計判断は `docs/decisions/` に記録されています：

- [001: CAS実装方式の選定](decisions/001-cas-implementation-approach.md)

## Implementation Principles

### Functional Programming

- クラスは必要最小限（Errorクラスのみ）
- 純粋関数でロジックを実装
- ファクトリー関数でインスタンス生成

### Type Safety

- Zod によるランタイムバリデーション
- TypeScript strict モード
- 実験的機能: `erasableSyntaxOnly`, `allowImportingTsExtensions`

## Future Architecture

### Worktree-based Parallelization

（Epic 3で実装予定）

- 1タスク = 1ブランチ = 1worktree
- 並列度制御（デフォルト3）

### Agent Execution

（Epic 4で実装予定）

- Claude Agent SDK統合
- OpenAI Codex SDK統合

### Orchestrator

（Epic 5で実装予定）

- Planner → Worker → Judge サイクル
- タスクスケジューリング
- 状態機械による制御
