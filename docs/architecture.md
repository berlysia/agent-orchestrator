# Architecture

## Overview

Agent Orchestratorは、Planner/Worker/Judge アーキテクチャに基づくマルチエージェント協働開発ツールです。

## Core Concepts

### 1. Planning Session

**Planning Session**は、タスク実行前に要件を明確化し、設計を決定するための対話セッションです。

- **SessionId**: `planning-<UUID>` 形式の一意識別子
- **状態遷移**: DISCOVERY → DESIGN → REVIEW → APPROVED
- **責務**: 要件明確化、設計選択、仕様確定
- **次ステップ**: 承認後に PlannerSession を作成し、タスク分解へ移行

**状態遷移図**:

```
DISCOVERY  : 要件明確化（質問生成・回答収集）
    ↓
DESIGN     : 設計決定（選択肢提示・決定記録）
    ↓
REVIEW     : レビュー・承認（サマリー確認）
    ↓ (approve)
APPROVED   : 承認済み（PlannerSessionへ移行）

REVIEW → (reject) → DESIGN  : 拒否時はDESIGNに戻る（最大3回）
任意の状態 → CANCELLED      : ユーザーが明示的にキャンセル
任意の状態 → FAILED         : LLM呼び出し失敗等
```

詳細は [docs/decisions/021-interactive-planning-mode.md](decisions/021-interactive-planning-mode.md) を参照。

### 2. Planner Session

**Planner Session**は、Plannerによる1回のタスク分解とその結果を表す中央的なエンティティです。

- **SessionId**: `planner-<UUID>` 形式の一意識別子
- **Session → Task**: 1対多。1セッションが複数タスクを生成
- **Task → Run**: 1対多。1タスクに複数の実行履歴
- **連携**: Planning Session からの情報を引き継いでタスク分解を実行

詳細は [docs/session-concept.md](session-concept.md) を参照。

### 3. Task State Management

タスクは以下の状態を持ちます：

- **READY**: 実行可能（Workerが割り当て待ち）
- **RUNNING**: Worker実行中
- **NEEDS_CONTINUATION**: 実行済みだが継続が必要（Judgeが不完全と判定）
- **DONE**: 完了
- **BLOCKED**: エラーや依存関係により実行不可
- **CANCELLED**: ユーザーによる中断

**状態遷移**:

```
READY → RUNNING → (Judge判定) → DONE
                              → BLOCKED
                              → NEEDS_CONTINUATION

NEEDS_CONTINUATION → RUNNING → (Judge判定) → DONE
                                           → BLOCKED
                                           → NEEDS_CONTINUATION (継続)
```

### 3. Concurrency Control (CAS)

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

### 4. Storage Layer

**TaskStore インターフェース**:

```typescript
import type { Result } from 'option-t/plain_result';

interface TaskStore {
  createTask(task: Task): Promise<Result<void, TaskStoreError>>;
  readTask(taskId: TaskId): Promise<Result<Task, TaskStoreError>>;
  listTasks(): Promise<Result<Task[], TaskStoreError>>;
  deleteTask(taskId: TaskId): Promise<Result<void, TaskStoreError>>;
  updateTaskCAS(
    taskId: TaskId,
    expectedVersion: number,
    updateFn: (task: Task) => Task,
  ): Promise<Result<Task, TaskStoreError>>;
  writeRun(run: Run): Promise<Result<void, TaskStoreError>>;
  writeCheck(check: Check): Promise<Result<void, TaskStoreError>>;
}
```

**エラーハンドリング** (Phase 2実装):

- `option-t` Result型による統一されたエラーハンドリング
- `TaskStoreError` 型定義: NotFound, CASConflict, IOError, ValidationError等
- Branded Types: `TaskId`, `RunId`, `WorkerId`, `RepoPath`等による型安全性向上

**実装**: FileStore（JSONファイルベース）

```
agent-coord/
  tasks/<taskId>.json       # タスク状態
  runs/<runId>.json         # Worker実行結果
  checks/<checkId>.json     # CI/lint結果
  .locks/<taskId>/          # CASロック
```

### 5. Adapter Layer (VCS / GitHub)

外部サービスとのI/Oは `src/adapters/` に隔離し、CoreからはEffectsインターフェースで利用します。

- `src/adapters/vcs/`: Git/Worktree操作
- `src/adapters/github/`: GitHub API連携

**設計方針**:

Effectsパターンにより、外部APIへの依存をインターフェースで抽象化します。
これにより、テスト時のモック差し替えや、将来的な別プロバイダ対応が容易になります。

```typescript
// GitHubEffects インターフェース
interface GitHubEffects {
  createPullRequest(input: CreatePullRequestInput): Promise<Result<PullRequest, GitHubError>>;
}
```

**エラー分類の設計**:

GitHub APIエラーは原因別に分類し、呼び出し側で適切な対応を可能にします：

- `authentication`: 認証失敗（トークン無効・期限切れ）
- `permission`: 権限不足
- `rate_limit`: APIレート制限
- `validation`: リクエストパラメータ不正
- `not_found`: リソースが存在しない
- `unknown`: その他のエラー

セットアップと使い方は [docs/github-integration.md](github-integration.md) を参照してください。

### 6. Error Handling Strategy

**Result型ベースのエラーハンドリング** (Phase 2実装):

すべてのTaskStore操作は`Result<T, TaskStoreError>`を返却し、明示的なエラーハンドリングを強制します：

```typescript
// エラーハンドリングの例
const taskResult = await taskStore.readTask(taskId);

if (!taskResult.ok) {
  // エラーハンドリング
  console.error(`Failed to read task: ${taskResult.err.message}`);
  return;
}

const task = taskResult.val; // 成功時のみ値を取得
```

**TaskStoreError型階層**:

- `NotFoundError`: リソースが見つからない
- `CASConflictError`: バージョン競合（楽観的ロック失敗）
- `IOError`: ファイルI/O エラー
- `ValidationError`: データ検証エラー
- `LockError`: ロック取得失敗

**Branded Types**:

型安全なドメイン識別子により、異なる種類のIDを誤って混同することを防ぎます：

```typescript
type TaskId = Brand<'TaskId', string>;
type WorkerId = Brand<'WorkerId', string>;

// コンパイルエラー: TaskIdとWorkerIdは互換性がない
const taskId: TaskId = workerId; // ❌
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

## Implemented Architecture

### Worktree-based Parallelization

✅ 実装完了 (Epic 3)

- 1タスク = 1ブランチ = 1worktree
- 並列度制御（デフォルト3）
- simple-git によるGit基本操作
- child_process によるworktree管理

実装ファイル:

- `src/adapters/vcs/git-effects.ts` - Git Effects インターフェース定義
- `src/adapters/vcs/simple-git-effects.ts` - simple-git実装
- `src/adapters/vcs/spawn-git-effects.ts` - worktree管理（child_process）

### Agent Execution

✅ 実装完了 (Epic 4)

- Claude Agent SDK統合 (`@anthropic-ai/claude-agent-sdk`)
- OpenAI Codex SDK統合 (`@openai/codex-sdk`)
- プロセス実行基盤とログ保存機能
- 関数型アーキテクチャによるRunner実装

実装ファイル:

- `src/core/runner/runner-effects.ts` - Runner Effects インターフェース定義
- `src/core/runner/runner-effects-impl.ts` - エージェント実行実装
- `src/core/runner/run-task.ts` - タスク実行フロー
- `src/core/runner/prompt-builder.ts` - プロンプト構築

### Orchestrator

✅ 実装完了 (Epic 5)

- Planner → Worker → Judge サイクル
- タスクスケジューリングと並列度制御
- 関数型による状態管理と操作分離
- Result型によるエラーハンドリング

実装ファイル:

- `src/core/orchestrator/orchestrate.ts` - オーケストレーション全体フロー
- `src/core/orchestrator/scheduler-state.ts` - スケジューラー状態管理
- `src/core/orchestrator/scheduler-operations.ts` - スケジューラー操作
- `src/core/orchestrator/planner-operations.ts` - Planner操作
- `src/core/orchestrator/worker-operations.ts` - Worker操作
- `src/core/orchestrator/judge-operations.ts` - Judge操作

### CLI Interface

✅ 実装完了 (Epic 6)

- `agent init` - プロジェクト初期化
- `agent run` - タスク実行
- `agent status` - 状態確認
- `agent stop` - タスク中断

実装ファイル:

- `src/cli/index.ts` - CLIエントリーポイント
- `src/cli/commands/init.ts` - initコマンド
- `src/cli/commands/run.ts` - runコマンド
- `src/cli/commands/status.ts` - statusコマンド
- `src/cli/commands/stop.ts` - stopコマンド

### Testing

✅ 実装完了 (Epic 7)

- ユニットテスト (node:test)
- E2Eテスト (CLIコマンド統合)
- サンプルプロジェクト (tests/fixtures/)

テストファイル:

- `tests/unit/file-store.test.ts` - TaskStore CRUD/CAS操作テスト
- `tests/e2e/cli-basic.test.ts` - CLI基本コマンドE2Eテスト

### GitHub Integration

✅ Phase 1 実装完了

- Octokit SDKによるGitHub API連携
- Pull Request自動作成機能
- エラー分類と適切なエラーハンドリング

実装ファイル:

- `src/adapters/github/client.ts` - Octokitクライアント生成
- `src/adapters/github/pull-request.ts` - PR作成API呼び出し
- `src/adapters/github/error.ts` - GitHubエラー分類
- `src/adapters/github/index.ts` - GitHubEffects実装
- `src/types/github.ts` - GitHub関連型定義

## Planned Architecture

### GitHub Integration (Phase 2)

Phase 2以降の機能は**未実装（計画段階）**です：

- コメント投稿
- チェック/ステータス更新
- GitHub Actions参照
- GitHub App認証

詳細は以下の計画/設計ドキュメントを参照：

- [docs/plans/github-integration-plan.md](plans/github-integration-plan.md)
- [docs/plans/github-integration-design.md](plans/github-integration-design.md)
