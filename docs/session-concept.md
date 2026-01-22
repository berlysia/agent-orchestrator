# Session Concept

Agent Orchestratorにおける「セッション」と関連概念（タスク、ラン、操作）の関係を説明します。

## Overview

Agent Orchestratorは **Planner → Worker → Judge** のサイクルでタスクを処理します。

```
ユーザー指示
    │
    ▼
┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────────┐
│ Planner │ ──→ │ Worker  │ ──→ │  Judge  │ ──→ │ Integration │
│(計画)   │     │(実行)   │     │(判定)   │     │(統合)       │
└─────────┘     └─────────┘     └─────────┘     └─────────────┘
    │               │               │
    ▼               ▼               ▼
 Session          Task            Task状態
 生成             Run生成          更新
```

このドキュメントでは、**永続化されるエンティティ**と**処理ロジック（操作）**を区別して説明します。

---

## Core Entities（永続化）

### 1. Session（PlannerSession）

**セッション**は、Plannerによる1回のタスク分解とその結果を表す**最上位エンティティ**です。

```typescript
// src/types/planner-session.ts
interface PlannerSession {
  sessionId: string;              // "planner-<UUID>"
  instruction: string;            // ユーザーの元指示
  conversationHistory: Message[]; // Plannerとの会話履歴
  generatedTasks: Task[];         // 生成されたタスク群
  finalJudgement: {               // 最終完了判定
    isComplete: boolean;
    missingAspects: string[];
    additionalTaskSuggestions: string[];
    completionScore?: number;
  } | null;
  continueIterationCount: number; // continue反復回数
  createdAt: string;
  updatedAt: string;
}
```

**保存先**: `agent-coord/planner-sessions/<sessionId>.json`

### 2. Task

**タスク**は、実行可能な作業単位です。セッションから生成され、Workerによって実行されます。

```typescript
// src/types/task.ts
interface Task {
  id: TaskId;                     // "task-<sessionShort>-<seq>"
  state: TaskState;               // READY | RUNNING | DONE | ...
  taskType: TaskType;             // implementation | documentation | ...
  plannerRunId: string | null;    // 親セッションID
  branch: BranchName;             // 作業ブランチ
  dependencies: TaskId[];         // 依存タスク
  acceptance: string;             // 受け入れ基準
  judgementFeedback?: {...};      // Judge判定フィードバック
  version: number;                // CAS用バージョン
}
```

**保存先**: `agent-coord/tasks/<taskId>.json`

#### Task State（タスク状態）

```
READY ──→ RUNNING ──→ DONE
              │
              ├──→ NEEDS_CONTINUATION ──→ RUNNING（再実行）
              │
              ├──→ BLOCKED（失敗）
              │
              └──→ REPLACED_BY_REPLAN（再計画で置換）

CANCELLED（ユーザー中断）
```

| 状態 | 説明 |
|------|------|
| `READY` | 実行待ち |
| `RUNNING` | Worker実行中 |
| `DONE` | 完了 |
| `NEEDS_CONTINUATION` | Judge判定で継続が必要 |
| `BLOCKED` | 失敗（MAX_RETRIES, CONFLICT等） |
| `REPLACED_BY_REPLAN` | 再計画で新タスクに置換済み |
| `CANCELLED` | ユーザーによる中断 |

#### Task Type（タスク種類）

| タイプ | 説明 | 生成元 |
|--------|------|--------|
| `implementation` | 機能実装 | Planner |
| `documentation` | ドキュメント作成 | Planner |
| `investigation` | 調査・分析 | Planner |
| `integration` | 統合・コンフリクト解決 | Integration Operations |

### 3. Run

**Run**は、Worker実行の記録です。1つのタスクに対して複数のRunが生成される場合があります（リトライ時）。

```typescript
// src/types/run.ts
interface Run {
  id: RunId;                      // "run-<UUID>"
  taskId: TaskId;                 // 対象タスクID
  status: RunStatus;              // SUCCESS | FAILURE | TIMEOUT
  agentType: 'claude' | 'codex';  // 使用エージェント
  logPath: string;                // 実行ログパス
  plannerRunId: string | null;    // 親セッションID（トレーサビリティ用）
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
}
```

**保存先**: `agent-coord/runs/<runId>.json` + `<runId>.log`

---

## Entity Relationships（エンティティ関係）

```
┌──────────────────────────────────────────────────────────────────┐
│                         Session                                  │
│  sessionId: "planner-7682b3a8-..."                              │
│  instruction: "ユーザー認証機能を実装して"                       │
│  generatedTasks: [task-7682b3a8-1, task-7682b3a8-2, ...]       │
└──────────────────────────────────────────────────────────────────┘
         │
         │ 1:N（生成）
         ▼
┌──────────────────────────────────────────────────────────────────┐
│                          Task                                    │
│  id: "task-7682b3a8-1"                                          │
│  plannerRunId: "planner-7682b3a8-..."  ←─ 親セッション参照      │
│  state: DONE                                                    │
│  taskType: implementation                                       │
└──────────────────────────────────────────────────────────────────┘
         │
         │ 1:N（実行記録）
         ▼
┌──────────────────────────────────────────────────────────────────┐
│                           Run                                    │
│  id: "run-abc123..."                                            │
│  taskId: "task-7682b3a8-1"  ←─ 親タスク参照                     │
│  plannerRunId: "planner-7682b3a8-..."  ←─ セッション逆参照     │
│  status: SUCCESS                                                │
│  agentType: claude                                              │
└──────────────────────────────────────────────────────────────────┘
```

**関係性サマリ**:

| 関係 | カーディナリティ | 説明 |
|------|------------------|------|
| Session → Task | 1:N | 1セッションが複数タスクを生成 |
| Task → Run | 1:N | 1タスクに複数のRun（リトライ含む） |
| Run → Session | N:1 | `plannerRunId` で逆参照可能 |

---

## Orchestration Workflow（実行フロー）

### 基本フロー: `agent run`

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. agent run "<instruction>"                                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. Planner Operations                                          │
│    ├── セッション生成: sessionId = "planner-<UUID>"           │
│    ├── LLMと対話してタスク分解                                 │
│    ├── Task品質評価 (judgeTaskQuality)                        │
│    └── タスク保存: tasks/<taskId>.json                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. Task Execution Pipeline                                     │
│    ├── 依存関係グラフ構築                                      │
│    ├── 並列/直列実行戦略決定                                   │
│    └── 各タスクに対して:                                       │
│         │                                                      │
│         ├── Scheduler: タスクをclaim（ロック）                │
│         │                                                      │
│         ├── Worker Operations                                  │
│         │    ├── Worktree作成                                 │
│         │    ├── エージェント実行（Claude/Codex）             │
│         │    ├── Run生成・保存                                │
│         │    └── コミット作成                                 │
│         │                                                      │
│         └── Judge Operations                                   │
│              ├── タスク完了度評価                              │
│              └── 状態更新: DONE / NEEDS_CONTINUATION / BLOCKED│
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. Integration Operations                                      │
│    ├── 完了タスクのブランチをベースにマージ                    │
│    ├── コンフリクト検出時: Conflict Resolution Task生成       │
│    └── PR作成（オプション）                                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. Final Completion Judgement                                  │
│    ├── 全タスク完了度を総合評価                                │
│    ├── session.finalJudgement に結果保存                      │
│    └── isComplete = false なら追加タスク提案                  │
└─────────────────────────────────────────────────────────────────┘
```

### 継続フロー: `agent continue`

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. agent continue [sessionId]                                  │
│    → 最新セッション or 指定セッションを読み込み               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. finalJudgement.isComplete チェック                         │
│    ├── true  → 完了メッセージ表示して終了                     │
│    └── false → 追加タスク生成へ                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. 追加タスク生成                                              │
│    ├── sessionId = "planner-additional-<UUID>"                │
│    ├── missingAspects を元に新タスク分解                      │
│    └── continueIterationCount をインクリメント                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    (基本フローの3-5と同様)
```

---

## Operations（操作）

**操作**はエンティティに対する処理ロジックです。永続化されません。

### Operations vs Entities

```
┌─────────────────────────────────────────────────────────────────┐
│                     Entities（永続化）                          │
│   Session (.json)    Task (.json)    Run (.json + .log)        │
└─────────────────────────────────────────────────────────────────┘
                              ↑
                              │ CRUD操作
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    Operations（処理ロジック）                   │
│  Planner │ Worker │ Judge │ Integration │ Replanning │ Scheduler│
└─────────────────────────────────────────────────────────────────┘
```

### 1. Planner Operations

**役割**: ユーザー指示をタスクに分解

| 関数 | 説明 | 出力 |
|------|------|------|
| `planTasks()` | 指示からタスク分解 | Session + Task[] |
| `judgeTaskQuality()` | 分解品質を評価 | 品質スコア |
| `judgeFinalCompletion()` | 全体完了度を判定 | finalJudgement |

### 2. Worker Operations

**役割**: タスクを実際に実行

| 関数 | 説明 | 出力 |
|------|------|------|
| `executeTask()` | エージェントでタスク実行 | Run |
| `generateCommitMessage()` | taskTypeに応じたコミットメッセージ | string |

### 3. Judge Operations

**役割**: タスク完了判定

| 関数 | 説明 | 出力 |
|------|------|------|
| `judgeTask()` | Worker実行結果を評価 | JudgementResult |
| `markTaskAsCompleted()` | DONE に更新 | Task |
| `markTaskForContinuation()` | NEEDS_CONTINUATION に更新 | Task |
| `markTaskAsBlocked()` | BLOCKED に更新 | Task |

**重要**: Judge は独立したエンティティを生成しません。結果は Task の `judgementFeedback` フィールドに記録されます。

### 4. Integration Operations

**役割**: タスクブランチの統合

| 関数 | 説明 | 出力 |
|------|------|------|
| `integrateTasks()` | ブランチをベースにマージ | IntegrationResult |
| `createConflictResolutionTask()` | コンフリクト解決タスク生成 | Task (integration) |
| `createPullRequest()` | GitHub PR作成 | PullRequestInfo |

### 5. Replanning Operations

**役割**: 失敗タスクの再計画

| 関数 | 説明 | 出力 |
|------|------|------|
| `replanFailedTask()` | BLOCKEDタスクを再分解 | Task[] |
| `markTaskAsReplanned()` | REPLACED_BY_REPLAN に更新 | Task |

### 6. Scheduler Operations

**役割**: タスク割り当て（CAS制御）

| 関数 | 説明 | 出力 |
|------|------|------|
| `claimNextTask()` | 次タスクをロック取得 | Task |
| `releaseTask()` | ロック解放 | void |

---

## Special Tasks（特殊タスク）

### Conflict Resolution Task

マージコンフリクト発生時に自動生成されるタスク。

```
Task A (implementation) ──┐
                          ├──→ integrateTasks() ──→ Conflict!
Task B (implementation) ──┘
                                       │
                                       ▼
                          Conflict Resolution Task
                          ├── taskType: integration
                          ├── id: task-<sessionShort>-conflict-resolution-<uuid>
                          └── 目的: コンフリクトを手動/自動解決
```

**生成元**:
- `integration-operations.ts` の `createConflictResolutionTask()`
- `base-branch-resolver.ts`（依存タスクのベースブランチ解決時）

---

## ID Formats

### Session ID

| 種類 | 形式 | 生成タイミング |
|------|------|----------------|
| 通常 | `planner-<UUID>` | `agent run` |
| 追加 | `planner-additional-<UUID>` | `agent continue` |

### Session Short ID

タスクIDの一意性確保のため、セッションIDから8文字を抽出：

```typescript
// "planner-7682b3a8-xxxx-xxxx" → "7682b3a8"
extractSessionShort(sessionId)
```

### Task ID

```
task-<sessionShort>-<sequence>
例: task-7682b3a8-1, task-7682b3a8-2
```

### Run ID

```
run-<UUID>
例: run-abc12345-6789-...
```

---

## Storage Structure

```
agent-coord/
├── planner-sessions/
│   └── planner-7682b3a8-xxxx.json    # Session
│
├── tasks/
│   ├── task-7682b3a8-1.json          # Task
│   └── task-7682b3a8-2.json
│
├── runs/
│   ├── run-abc123.json               # Run metadata
│   ├── run-abc123.log                # Run execution log
│   ├── planner-7682b3a8-xxxx.json    # Planner metadata
│   └── planner-7682b3a8-xxxx.log     # Planner execution log
│
└── .locks/
    └── task-7682b3a8-1/              # CAS lock directory
```

---

## CLI Commands

| コマンド | 説明 |
|----------|------|
| `agent run "<instruction>"` | 新規セッション作成・実行 |
| `agent continue [sessionId]` | セッション継続（追加タスク生成） |
| `agent resume --list` | セッション一覧表示 |
| `agent resume <sessionId>` | セッション再開（未完了タスク実行） |
| `agent info <sessionId>` | セッション詳細表示 |
| `agent status` | 現在の状態表示 |

---

## Design Decisions

### なぜ Session Short ID が必要か

複数セッションで同じシーケンス番号のタスク（例: `task-1`）が生成される可能性があるため、セッション短縮IDをプレフィックスとして付与し、グローバルな一意性を確保。

### なぜ conversationHistory を保存するか

1. **デバッグ**: タスク分解の意図・理由を追跡可能
2. **品質改善**: Planner出力品質を分析するためのデータ
3. **継続実行**: `agent continue` 時にコンテキスト保持

### なぜ continueIterationCount があるか

`agent continue` の無限ループ防止。一定回数を超えると警告/エラー。

### なぜ Judge はエンティティでないか

Judge判定結果はタスクの `judgementFeedback` フィールドに記録されます。独立したエンティティとして保存する必要性がなく、タスクと1:1で紐づくため。

---

## Related Files

| カテゴリ | ファイル | 説明 |
|----------|---------|------|
| **型定義** | `src/types/planner-session.ts` | Session型 |
| | `src/types/task.ts` | Task型 |
| | `src/types/run.ts` | Run型 |
| **操作** | `src/core/orchestrator/planner-operations.ts` | Planner |
| | `src/core/orchestrator/worker-operations.ts` | Worker |
| | `src/core/orchestrator/judge-operations.ts` | Judge |
| | `src/core/orchestrator/integration-operations.ts` | Integration |
| | `src/core/orchestrator/replanning-operations.ts` | Replanning |
| | `src/core/orchestrator/scheduler-operations.ts` | Scheduler |
| **パイプライン** | `src/core/orchestrator/orchestrate.ts` | 全体制御 |
| | `src/core/orchestrator/task-execution-pipeline.ts` | 実行パイプライン |
| **CLI** | `src/cli/commands/run.ts` | run コマンド |
| | `src/cli/commands/continue.ts` | continue コマンド |
| | `src/cli/commands/resume.ts` | resume コマンド |
