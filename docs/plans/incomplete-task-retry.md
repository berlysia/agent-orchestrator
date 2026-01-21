# 未完了タスク再実行機能の設計

## 概要

追加タスク生成ループにおいて、未完了タスク（NEEDS_CONTINUATION、BLOCKED (MAX_RETRIES)）を統合ブランチから再実行し、完了を支援する機能を追加する。

## 背景と動機

### 現在のアーキテクチャ

```
初回タスク実行 → 統合worktree作成 → 完了判定
  ↓ 不完全
追加タスク生成 → 統合ブランチから実行 → 統合worktreeにマージ → 再判定
  ↑ ループ（最大3回）
```

### 問題点

1. **BLOCKED (MAX_RETRIES) タスクの扱い**
   - 元のブランチで最大3回失敗 → BLOCKED に遷移
   - 追加タスクループでは完全に除外される
   - **統合ブランチから実行すれば成功する可能性があるが、そのチャンスがない**

2. **状態の硬直性**
   - BLOCKED = 「永久失敗」として扱われ、回復不可能
   - 実際には、他のタスクのコミットと統合すれば成功する場合がある

### 目標

- 統合ブランチから未完了タスクを**1回だけ**再実行する機会を提供
- 無限ループを防止しつつ、成功の可能性を最大化
- 追加タスクが未完了タスクに依存できるようにする

## 設計詳細

### 1. BLOCKED理由の細分化

#### BlockReason型定義

```typescript
// src/types/task.ts
export const BlockReason = {
  MAX_RETRIES: 'MAX_RETRIES',                           // 元ブランチでの継続実行の回数上限
  MAX_RETRIES_INTEGRATION: 'MAX_RETRIES_INTEGRATION',   // 統合ブランチからも失敗
  CONFLICT: 'CONFLICT',                                 // マージコンフリクト
  SYSTEM_ERROR_TRANSIENT: 'SYSTEM_ERROR_TRANSIENT',     // 一時的システムエラー（ネットワーク等）
  SYSTEM_ERROR_PERMANENT: 'SYSTEM_ERROR_PERMANENT',     // 永続的システムエラー（ディスク満杯等）
  MANUAL: 'MANUAL',                                     // ユーザーが手動でブロック
  UNKNOWN: 'UNKNOWN',                                   // マイグレーション用（既存データ）
} as const;

export type BlockReason = typeof BlockReason[keyof typeof BlockReason];

// Task型に追加
export interface Task {
  // ... existing fields
  blockReason?: BlockReason | null;
  blockMessage?: string | null;     // BLOCKED理由の詳細メッセージ
  integrationRetried: boolean;      // 統合ブランチからの再試行済みフラグ
}
```

#### BlockReasonの使い分け

| BlockReason | 説明 | 統合ブランチからの再試行 | 手動介入 |
|------------|------|------------------------|---------|
| `MAX_RETRIES` | 元ブランチで最大回数失敗 | ✅ 1回のみ許可 | 任意 |
| `MAX_RETRIES_INTEGRATION` | 統合ブランチからも失敗 | ❌ 禁止 | 必須 |
| `CONFLICT` | マージコンフリクト | ❌ 禁止（コンフリクト解決後に検討） | 必須 |
| `SYSTEM_ERROR_TRANSIENT` | 一時的障害 | ✅ 次回ループで自動リトライ | 任意 |
| `SYSTEM_ERROR_PERMANENT` | 永続的障害 | ❌ 禁止 | 必須 |
| `MANUAL` | ユーザー指定 | ❌ 禁止 | 必須 |
| `UNKNOWN` | 既存データ（マイグレーション） | ❌ 禁止 | 必須 |

### 2. 統合ブランチからの再実行メカニズム

#### 2.1. 再実行対象の判定

```typescript
// planner-operations.ts: planAdditionalTasks 内

// 再実行対象タスクの抽出
const retryableTasks = allTasksResult.val.filter(task => {
  // NEEDS_CONTINUATION は常に再実行対象
  if (task.state === TaskState.NEEDS_CONTINUATION) {
    return true;
  }

  // BLOCKED (MAX_RETRIES) かつ未再試行
  if (
    task.state === TaskState.BLOCKED &&
    task.blockReason === BlockReason.MAX_RETRIES &&
    !task.integrationRetried
  ) {
    return true;
  }

  // SYSTEM_ERROR_TRANSIENT も再試行対象（1回のみ）
  if (
    task.state === TaskState.BLOCKED &&
    task.blockReason === BlockReason.SYSTEM_ERROR_TRANSIENT &&
    !task.integrationRetried  // 統合ブランチからの再試行は1回のみ
  ) {
    return true;
  }

  return false;
});
```

#### 2.2. 再実行前の準備

```typescript
// タスク状態のリセット
const prepareForRetry = async (
  task: Task,
  taskStore: TaskStore
): Promise<Result<Task, TaskStoreError>> => {
  // CAS更新でタスク状態をリセット
  return await taskStore.updateTaskCAS(task.id, task.version, (currentTask) => {
    const updatedTask = {
      ...currentTask,
      state: TaskState.READY,
      owner: null,
      updatedAt: new Date().toISOString(),
    };

    // MAX_RETRIES からの再試行の場合、フラグを立てる
    if (currentTask.blockReason === BlockReason.MAX_RETRIES) {
      updatedTask.integrationRetried = true;
      updatedTask.blockReason = null;  // 理由をクリア
    }

    // SYSTEM_ERROR_TRANSIENT の場合もクリア
    if (currentTask.blockReason === BlockReason.SYSTEM_ERROR_TRANSIENT) {
      updatedTask.blockReason = null;
    }

    return updatedTask;
  });
};
```

#### 2.3. 再実行の実行

```typescript
// orchestrate.ts: 追加タスクループ内

// Step 1: 再実行対象タスクの準備
const preparedRetryTasks: Task[] = [];
for (const task of retryableTasks) {
  const prepared = await prepareForRetry(task);
  if (prepared.ok) {
    preparedRetryTasks.push(prepared.val);
  }
}

// Step 2: 追加タスクと再実行タスクを統合
const allTasksToExecute = [...preparedRetryTasks, ...additionalTasks];

// Step 3: 依存関係を解決して実行
await executeTaskPipeline({
  tasks: allTasksToExecute,
  baseBranch: integrationBranch,  // 統合ブランチをベースに
  // ...
});
```

### 3. ブランチ管理戦略

#### 3.1. Worktree管理の原則

**決定事項**: 統合ブランチから再実行する場合、**新しいworktreeを作成する**

**理由**:
- 元のworktree（`.git/worktree/task-xxxx-N/`）は元のブランチを指している
- rebase によるブランチ切り替えはリスクが高い（コンフリクト、作業ディレクトリの状態変化）
- 新しいworktreeを作成することで、元のブランチの状態を保持しつつ、統合ブランチから実行可能

#### 3.2. Worktree作成フロー

```typescript
// worker-operations.ts: executeTask 内

// 統合ブランチから再実行する場合の処理
if (task.integrationRetried && integrationBranch) {
  // 新しいworktreeを作成（既存のものと区別するため）
  const worktreeName = `${task.id}-integration`;  // サフィックスで区別

  const worktreeResult = await gitEffects.createWorktree(
    repoPath(config.agentCoordPath),  // repo
    worktreeName,                      // name
    task.branch,                        // branch（タスクのブランチ名はそのまま）
    false,                              // createBranch（既存ブランチを使用）
    integrationBranch,                  // startPoint（統合ブランチから開始）
  );

  if (isErr(worktreeResult)) {
    // Worktree作成失敗時はBLOCKED (SYSTEM_ERROR_PERMANENT) に
    await judgeOps.markTaskAsBlocked(task.id, {
      reason: BlockReason.SYSTEM_ERROR_PERMANENT,
      message: `Failed to create worktree: ${worktreeResult.err.message}`,
    });
    return { status: TaskExecutionStatus.FAILED };
  }

  // 以降は通常の実行フロー（worktreePath = worktreeResult.val）
}
```

#### 3.3. Worktreeクリーンアップ

**実行場所**: `src/core/orchestrator/dynamic-scheduler.ts` の `executeTask` 完了後

**クリーンアップポリシー**: タスクがDONEまたはBLOCKED状態に遷移した直後にworktreeを削除する。ユーザーが手動で確認したい場合は、`agent info <task-id>` コマンドでログファイルやメタデータを確認可能。

```typescript
// dynamic-scheduler.ts: executeTask 完了後

// タスク完了後（DONE or BLOCKED）、worktreeを削除
if (task.state === TaskState.DONE || task.state === TaskState.BLOCKED) {
  // 元のworktreeパス（task.branchから導出）
  const originalWorktreePath = worktreePath(
    path.join(config.agentCoordPath, '.git', 'worktree', task.branch)
  );

  // 元のworktreeを削除
  const removeResult = await gitEffects.removeWorktree(originalWorktreePath);
  if (isErr(removeResult)) {
    console.warn(`Failed to remove worktree: ${removeResult.err.message}`);
  }

  // 統合ブランチ用のworktree（存在する場合）
  if (task.integrationRetried) {
    const integrationWorktreePath = worktreePath(
      path.join(config.agentCoordPath, '.git', 'worktree', `${task.id}-integration`)
    );

    const removeIntegrationResult = await gitEffects.removeWorktree(integrationWorktreePath);
    if (isErr(removeIntegrationResult)) {
      console.warn(`Failed to remove integration worktree: ${removeIntegrationResult.err.message}`);
    }
  }
}
```

**パスの取得方法**:
- 元のworktree: `.git/worktree/<task.branch>`
- 統合worktree: `.git/worktree/<task.id>-integration`

**エラーハンドリング**: worktreeの削除に失敗してもタスク実行は継続する（警告ログのみ）。

### 4. 追加タスクからの依存サポート

#### 4.1. Plannerへの情報提供

```typescript
// planner-operations.ts: planAdditionalTasks

// 未完了タスク情報をプロンプトに含める
const incompleteTaskInfo = retryableTasks.map(t => ({
  id: String(t.id),
  state: t.state,
  acceptance: t.acceptance,
  lastError: t.judgementFeedback?.feedback || 'N/A',
}));

const prompt = `
CONTEXT:
${contextPrompt}

INCOMPLETE TASKS (can be used as dependencies):
${incompleteTaskInfo.map(t => `- ${t.id} (${t.state}): ${t.acceptance}`).join('\n')}

INSTRUCTIONS:
You can:
1. Create new independent tasks
2. Create tasks that depend on incomplete tasks (use EXACT IDs above, e.g., "task-abc123-1")
3. Suggest fixes for incomplete tasks

...
`;
```

#### 4.2. 依存関係のマッピング

**Note**: `makeUniqueTaskId` は新規追加のヘルパー関数で、短縮形ID（例: `task-1`）をフルID形式（例: `task-abc12345-1`）に変換します。実装場所は `src/core/orchestrator/planner-operations.ts` を推奨。

```typescript
// Plannerの出力から依存関係を抽出
dependencies: breakdown.dependencies.map((depId) => {
  // 実際のタスクID形式（task-xxxx-N）の場合
  if (depId.match(/^task-[a-f0-9]{8}-\d+$/)) {
    // 未完了タスクへの依存
    return taskId(depId);
  }

  // 短縮形（task-N）の場合は新規タスク間の依存
  // sessionShort: 現在のセッションID（runId）の最初の8文字
  const sessionShort = runId.slice(0, 8);
  return taskId(makeUniqueTaskId(depId, sessionShort));
}),

// ヘルパー関数（新規追加）
function makeUniqueTaskId(
  shortId: string,
  sessionShort: string
): Result<TaskId, ValidationError> {
  // 短縮形 "task-N" を "task-<session>-N" に変換
  const match = shortId.match(/^task-(\d+)$/);
  if (!match) {
    return createErr(validationError(`Invalid short task ID: ${shortId}`));
  }
  return createOk(taskId(`task-${sessionShort}-${match[1]}`));
}
```

### 5. エッジケース処理

#### 5.1. 依存タスクが再度失敗した場合

**Note**: `findDependentTasks` は新規追加のヘルパー関数で、指定されたタスクに依存している全タスクを取得します。実装場所は `src/core/orchestrator/scheduler-operations.ts` または `src/core/task-store/interface.ts` を推奨。

```typescript
// dynamic-scheduler.ts: タスク実行結果の処理

if (
  executionResult.status === TaskExecutionStatus.FAILED &&
  task.blockReason === BlockReason.MAX_RETRIES_INTEGRATION
) {
  // 依存する追加タスクを再帰的にBLOCKEDにマーク
  await blockDependentTasksRecursively(task.id, deps.taskStore, judgeOps);
}

// ヘルパー関数（新規追加）
async function findDependentTasks(
  taskId: TaskId,
  taskStore: TaskStore
): Promise<Task[]> {
  // 全タスクを読み込み、dependenciesに指定されたtaskIdを含むものを抽出
  const allTasksResult = await taskStore.listTasks();
  if (!allTasksResult.ok) {
    return [];
  }

  return allTasksResult.val.filter(task =>
    task.dependencies.some(dep => dep === taskId)
  );
}

// 再帰的に依存タスクをBLOCKEDにマーク（新規追加）
async function blockDependentTasksRecursively(
  taskId: TaskId,
  taskStore: TaskStore,
  judgeOps: JudgeOperations,
  visited: Set<TaskId> = new Set()
): Promise<void> {
  // 循環参照防止
  if (visited.has(taskId)) {
    return;
  }
  visited.add(taskId);

  // 直接依存しているタスクを取得
  const dependentTasks = await findDependentTasks(taskId, taskStore);

  for (const depTask of dependentTasks) {
    // すでにDONEまたはBLOCKED状態の場合はスキップ
    if (depTask.state === TaskState.DONE || depTask.state === TaskState.BLOCKED) {
      continue;
    }

    // CAS更新でBLOCKEDにマーク（競合を防ぐ）
    const blockResult = await judgeOps.markTaskAsBlocked(depTask.id, {
      reason: BlockReason.MANUAL,
      message: `Dependency ${taskId} failed permanently`,
    });

    if (blockResult.ok) {
      // 再帰的に依存タスクをBLOCKED
      await blockDependentTasksRecursively(depTask.id, taskStore, judgeOps, visited);
    }
  }
}
```

#### 5.2. 再実行対象タスクが多数ある場合

```typescript
// 最大再実行数を制限
const MAX_RETRY_TASKS = 5;

// 優先順位でソート
const sortedRetryTasks = retryableTasks.sort((a, b) => {
  // NEEDS_CONTINUATION を優先
  if (a.state === TaskState.NEEDS_CONTINUATION && b.state !== TaskState.NEEDS_CONTINUATION) {
    return -1;
  }
  if (b.state === TaskState.NEEDS_CONTINUATION && a.state !== TaskState.NEEDS_CONTINUATION) {
    return 1;
  }

  // それ以外は作成順
  return a.id.localeCompare(b.id);
});

// 上位N件のみ再実行
const selectedRetryTasks = sortedRetryTasks.slice(0, MAX_RETRY_TASKS);
```

#### 5.3. Worktree作成失敗時の処理

**Note**: Worktree作成失敗時の処理は「3.2. Worktree作成フロー」に含まれています（重複のため削除）。

### 6. 無限ループ防止

#### 6.1. 再試行回数の制限

**保証**: 各タスクは以下の回数のみ実行される
- 元のブランチ: 最大3回（`config.judgeTaskRetries`）
- 統合ブランチ: 最大1回（`integrationRetried` フラグで制御）
- **合計**: 最大4回

#### 6.2. 追加タスクループとの関係

- 追加タスクループは最大3回（`config.replanning.maxIterations`）
- **各ループで `integrationRetried` をチェック**するため、統合ブランチからの再試行は1回のみ保証される

```typescript
// planAdditionalTasks で再実行対象を判定
if (
  task.state === TaskState.BLOCKED &&
  task.blockReason === BlockReason.MAX_RETRIES &&
  !task.integrationRetried  // ← このチェックにより2回目以降は除外
) {
  // 再試行を許可
}
```

## 実装計画

### Phase 1: BLOCKED理由の記録

**目的**: データ収集と既存動作の保持

**変更範囲**:
- `src/types/task.ts`: `BlockReason`列挙型, `blockReason`, `integrationRetried` フィールドを追加
- `src/core/orchestrator/judge-operations.ts`: `markTaskAsBlocked` のシグネチャ変更
- `src/core/orchestrator/dynamic-scheduler.ts`: BLOCKED遷移時に理由を記録
- 既存の`markTaskAsBlocked`呼び出し箇所を全て修正

**既存動作への影響**:
- `markTaskAsBlocked`のシグネチャ変更により、既存呼び出し箇所の修正が必要
- 影響ファイル:
  - `src/core/orchestrator/dynamic-scheduler.ts`（BLOCKED遷移箇所）
  - `src/core/orchestrator/judge-operations.ts`（内部呼び出し）
  - その他、`markTaskAsBlocked`を呼び出す全ての箇所
- Zodスキーマ変更（`.default(false)`により後方互換性あり）

**`markTaskAsBlocked`のシグネチャ変更**:

```typescript
// Before
const markTaskAsBlocked = async (
  tid: TaskId
): Promise<Result<Task, TaskStoreError>> => {
  // ... 実装
};

// After
const markTaskAsBlocked = async (
  tid: TaskId,
  options?: { reason?: BlockReason; message?: string }
): Promise<Result<Task, TaskStoreError>> => {
  const taskResult = await deps.taskStore.readTask(tid);
  if (!taskResult.ok) {
    return taskResult;
  }

  const task = taskResult.val;

  return await deps.taskStore.updateTaskCAS(tid, task.version, (currentTask) => ({
    ...currentTask,
    state: TaskState.BLOCKED,
    blockReason: options?.reason ?? null,
    blockMessage: options?.message ?? null,
    owner: null,
    updatedAt: new Date().toISOString(),
  }));
};
```

**既存呼び出し箇所の修正例**:

```typescript
// Before
await judgeOps.markTaskAsBlocked(tid);

// After（理由を指定しない場合）
await judgeOps.markTaskAsBlocked(tid);

// After（理由を指定する場合）
await judgeOps.markTaskAsBlocked(tid, {
  reason: BlockReason.MAX_RETRIES,
  message: 'Exceeded max retry iterations',
});
```

**dynamic-scheduler.tsでの使用例**:

```typescript
// src/core/orchestrator/dynamic-scheduler.ts

// 最大リトライ回数を超えた場合
if (continuationResult.err) {
  console.log(`❌ Exceeded max iterations, marking as blocked`);
  await judgeOps.markTaskAsBlocked(tid, {
    reason: BlockReason.MAX_RETRIES,
    message: `Exceeded max retry iterations (${config.judgeTaskRetries})`,
  });
  return { status: TaskExecutionStatus.FAILED };
}

// 統合ブランチからも失敗した場合
if (task.integrationRetried && executionResult.status === TaskExecutionStatus.FAILED) {
  await judgeOps.markTaskAsBlocked(tid, {
    reason: BlockReason.MAX_RETRIES_INTEGRATION,
    message: 'Failed even after retry from integration branch',
  });
  return { status: TaskExecutionStatus.FAILED };
}

// Worktree作成失敗
if (isErr(worktreeResult)) {
  await judgeOps.markTaskAsBlocked(tid, {
    reason: BlockReason.SYSTEM_ERROR_PERMANENT,
    message: `Failed to create worktree: ${worktreeResult.err.message}`,
  });
  return { status: TaskExecutionStatus.FAILED };
}
```

### Phase 2: MAX_RETRIESタスクの統合ブランチからの再実行

**目的**: 基本的な再実行機能の実装

**変更範囲**:
- `src/core/orchestrator/planner-operations.ts`: 再実行対象タスクの抽出と準備
- `src/core/orchestrator/orchestrate.ts`: 追加タスクループで再実行タスクを実行
- `src/core/orchestrator/worker-operations.ts`: `integrationRetried`フラグに応じたWorktree管理
- `src/adapters/vcs/git-effects.ts`: Worktree作成時の `startPoint` サポート（**既に実装済み**）

**既存動作への影響**: 追加タスクループの実行時間が増加する可能性

### Phase 3: 追加タスクからの依存サポート

**目的**: Plannerが未完了タスクを参照可能に

**変更範囲**:
- `src/core/orchestrator/planner-operations.ts`: プロンプトに未完了タスク情報を追加
- 依存関係マッピングの拡張

**既存動作への影響**: Plannerの応答品質が向上（未完了タスクを考慮した計画）

## マイグレーション戦略

### 既存BLOCKEDタスクの扱い

```typescript
// TaskStore読み込み時の処理
// Zodスキーマで .default(false) を定義するため、integrationRetried は自動的に false になる
// blockReason のみ、BLOCKED状態で未定義の場合に UNKNOWN を設定

const task = TaskSchema.parse(rawData);

// blockReason フィールドがない場合、UNKNOWN として扱う
if (task.state === TaskState.BLOCKED && !task.blockReason) {
  task.blockReason = BlockReason.UNKNOWN;
}
```

### Zodスキーマの更新

```typescript
// src/types/task.ts

// BlockReason列挙型の追加
export const BlockReason = {
  MAX_RETRIES: 'MAX_RETRIES',
  MAX_RETRIES_INTEGRATION: 'MAX_RETRIES_INTEGRATION',
  CONFLICT: 'CONFLICT',
  SYSTEM_ERROR_TRANSIENT: 'SYSTEM_ERROR_TRANSIENT',
  SYSTEM_ERROR_PERMANENT: 'SYSTEM_ERROR_PERMANENT',
  MANUAL: 'MANUAL',
  UNKNOWN: 'UNKNOWN',
} as const;

export type BlockReason = typeof BlockReason[keyof typeof BlockReason];

// TaskSchemaに追加
export const TaskSchema = z.object({
  // ... existing fields
  blockReason: z.nativeEnum(BlockReason).optional().nullable(),
  blockMessage: z.string().optional().nullable(),  // BLOCKED理由の詳細メッセージ
  integrationRetried: z.boolean().default(false),  // デフォルト値で自動処理
});
```

## リスクと制約

### リスク

1. **Worktree数の増加**
   - 統合ブランチ用のworktreeが追加されるため、ディスク使用量が増加
   - 緩和策: タスク完了後は即座にworktreeを削除

2. **依存タスクの連鎖失敗**
   - 未完了タスクが再度失敗すると、依存する追加タスクもBLOCKEDになる
   - 緩和策: 依存タスクの状態を監視し、ユーザーに通知

3. **統合ブランチからの実行でも失敗するケース**
   - タスク自体に問題がある場合、統合ブランチからも失敗する
   - 緩和策: `MAX_RETRIES_INTEGRATION` でマークし、手動介入を促す

### 制約

1. **再試行は1回のみ**
   - 統合ブランチからの再試行は1回に制限
   - 理由: 無限ループ防止、リソース効率

2. **CONFLICT, MANUAL, UNKNOWN は再試行しない**
   - これらの理由でBLOCKEDになったタスクは手動介入が必要
   - 理由: 自動解決が困難、またはユーザー意図の尊重

3. **Worktreeの管理コスト**
   - 新しいworktreeを作成するため、Git操作が増加
   - 理由: rebaseよりも安全で予測可能

## 関連ドキュメント

- [Architecture Overview](../architecture.md)
- [Task State Machine](../architecture.md#4-task-state-machine)
- [CAS Implementation](../decisions/001-cas-implementation-approach.md)
