# Session Concept Review

`docs/session-concept.md` の概念モデルに対するレビュー結果。

---

## 概要

| 深刻度 | 件数 | 内容 |
|--------|------|------|
| 🔴 Critical | 5件 | 型不整合、命名矛盾、参照構造、ID体系、情報損失 |
| 🟡 Moderate | 5件 | 設計意図の不明確さ、状態遷移の不完全性、欠けている概念 |
| 🟢 Minor | 2件 | ドキュメント記載の改善 |

---

## 🔴 Critical Issues

### C1. Session.generatedTasks の型不整合

**現状**:
- ドキュメント: `generatedTasks: Task[]`
- 実装: `generatedTasks: TaskBreakdown[]`

**問題点**:
- `TaskBreakdown` は Planner の設計出力（生のLLM応答）
- `Task` は実行エンティティ（state, version, owner を持つ）
- 両者は**別の型**であり、フィールド構成が異なる

**影響**:
- ドキュメントを読んだ開発者が「SessionからTaskエンティティを直接取得できる」と誤解
- 実際は TaskStore から別途取得が必要

**推奨修正**:
```typescript
interface PlannerSession {
  // Before
  generatedTasks: Task[];

  // After
  generatedTasks: TaskBreakdown[];  // Planner設計出力（Taskエンティティとは別）
}
```

---

### C2. "Run" と "Session" の概念的混同

**現状**:
```typescript
Task.plannerRunId: string    // 実体は SessionID（"planner-<UUID>"）
Run.plannerRunId: string     // 実体は SessionID（"planner-<UUID>"）
Run.id: RunId                // Worker実行のID（"run-<UUID>"）
```

**問題点**:
1. `plannerRunId` という名前が "Run" を含むが、指しているのは Session
2. "Run" が「Worker実行」と「Planner実行」の2つの意味を持つ
3. ID形式の不統一:
   - Worker Run: `run-<UUID>`
   - Planner Run: `planner-<UUID>`（Session IDと同一）

**影響**:
- 新規開発者が `plannerRunId` を Run エンティティへの参照と誤解
- Planner実行とWorker実行の関係が不明確

**推奨修正案**:

| Option | 内容 | 工数 |
|--------|------|------|
| A. 命名修正 | `plannerRunId` → `plannerSessionId` | 中 |
| B. 概念再定義 | `Run = WorkerRun \| PlannerRun` として統一 | 大 |
| C. 文書化 | 現状維持 + 混同回避の説明追加 | 小 |

---

### C3. 参照構造の冗長性と非対称性

**現状**:
```
Session → Task: generatedTasks (1:N)
Task → Session: plannerRunId (N:1)     ← 双方向参照
Run → Session: plannerRunId (N:1)
Run → Task: taskId (N:1)
```

**問題点**:
1. Session.generatedTasks と Task.plannerRunId で双方向参照
2. しかし `generatedTasks` は `TaskBreakdown[]` なので実際のTaskは参照できない
3. 双方向参照が必須である理由がドキュメントに記載されていない

**論理的疑問**:
- Task単体からSession情報を取得 → `plannerRunId` が必要 ✓
- Sessionから全Taskを取得 → TaskStoreから検索で取得可能（`generatedTasks` は不要？）

**推奨修正案**:
```typescript
// Option 1: 軽量参照に変更
interface PlannerSession {
  generatedTaskIds: TaskId[];  // IDのみ保持（TaskStoreから取得）
}

// Option 2: 用途を明示して維持
interface PlannerSession {
  taskBreakdowns: TaskBreakdown[];  // 設計情報（監査用、不変）
  // 実行情報は TaskStore から plannerSessionId で取得
}
```

---

### C4. 追加タスクのID体系が分離

**現状**:
- 初回タスク: `task-<sessionShort>-<seq>` （sessionShort = 元Session ID の8文字）
- 追加タスク: `task-<additionalShort>-<seq>` （additionalShort = `planner-additional-<UUID>` の8文字）

**問題点**:
- `planAdditionalTasks` は新しい `planner-additional-<UUID>` から `sessionShort` を生成
- 追加タスクが**元セッションと異なるプレフィックス**を持つ
- セッション単位の検索・集計で追加タスクが漏れる

**影響**:
- `agent continue` で生成されたタスクが元セッションと関連付けにくい
- 履歴追跡やリプレイが困難

**推奨修正**:
```typescript
// 追加タスクも元セッションのsessionShortを継承
interface PlanAdditionalTasksOptions {
  originalSessionId: string;  // 元セッションID（IDプレフィックス用）
  additionalPlanId: string;   // 追加計画の識別子（追跡用）
}
```

---

### C5. TaskBreakdown の情報損失

**現状**:
- `TaskBreakdown` には `estimatedDuration`, `description` などの計画情報がある
- `Task` エンティティには**これらのフィールドが存在しない**

**問題点**:
```typescript
// TaskBreakdown（Planner出力）
{
  id: "task-1",
  description: "認証機能を実装",
  estimatedDuration: "2h",
  dependencies: []
}

// Task（実行エンティティ）
{
  id: "task-7682b3a8-1",
  instruction: "...",  // descriptionとは異なる
  // estimatedDuration は存在しない
}
```

**影響**:
- スケジューラがタスク見積もりを使えない
- 事後分析で「予定 vs 実績」の比較ができない
- Plannerの出力品質評価が困難

**推奨修正**:
```typescript
interface Task {
  // 既存フィールド...

  // 計画情報を保持
  planningMetadata?: {
    originalDescription: string;
    estimatedDuration: string | null;
    plannedAt: string;
  };
}
```

---

## 🟡 Moderate Issues

### M1. Session Short ID の必要性が不明確

**現状**:
- Task ID: `task-<sessionShort>-<seq>`
- sessionShort: UUIDの最初の8文字

**疑問**:
- なぜ UUID 全体（36文字）を使わないのか？
- 8文字で衝突リスクは許容範囲か？

**推奨修正**: 設計理由を明記
```markdown
### Session Short ID の設計理由

1. **視認性**: CLI表示時の可読性向上
2. **ファイル名長**: 一部OSの制限に対応
3. **衝突確率**: 16^8 ≈ 43億通りで実用上十分
   - 生成時に既存IDチェックで二重保証
```

---

### M2. Task State 遷移図の不完全性

**現状の遷移図（L77-87）**:
```
READY ──→ RUNNING ──→ DONE
              │
              ├──→ NEEDS_CONTINUATION ──→ RUNNING
              ├──→ BLOCKED
              └──→ REPLACED_BY_REPLAN
CANCELLED
```

**不明確な点**:
1. `NEEDS_CONTINUATION` → `RUNNING` の遷移条件（自動？手動？）
2. `BLOCKED` からの復帰可能性（`BlockReason` による分岐）
3. `CANCELLED` への遷移元（どの状態からでも可能？）
4. 終端状態の明示（`DONE`, `BLOCKED`, `REPLACED_BY_REPLAN`, `CANCELLED`）

**推奨修正**: 実装に基づく詳細遷移図
```
READY ──────────────────────→ RUNNING ──→ DONE (終端)
                                  │
    ┌─────────────────────────────┼─────────────────────────────┐
    │                             │                             │
    ▼                             ▼                             ▼
NEEDS_CONTINUATION            BLOCKED                    REPLACED_BY_REPLAN
    │                        (条件分岐)                       (終端)
    │                             │
    │         ┌───────────────────┴───────────────────┐
    │         │                                       │
    │    MAX_RETRIES                            CONFLICT等
    │    (再試行可能)                              (終端)
    │         │
    └─────────┴──→ RUNNING（再実行）

* CANCELLED: いずれの非終端状態からも遷移可能
```

---

### M3. Judge がエンティティでない理由の説明不足

**現状の説明（L449-451）**:
> タスクと1:1で紐づくため

**論理的疑問**:
- Run も Task と紐づくが独立エンティティ
- なぜ Judge だけ Task のフィールドなのか？

**推奨修正**: 設計理由を詳述
```markdown
### Judge がエンティティでない理由

| 観点 | Run | JudgementFeedback |
|------|-----|-------------------|
| 履歴 | 複数保持（リトライ追跡） | 最新のみ |
| 用途 | 実行ログ参照 | 継続判定のみ |
| 関係 | Task : Run = 1 : N | Task : Judgement = 1 : 1 |

JudgementFeedback は「最新の判定状態」のみ必要であり、
過去の判定履歴を追跡する要件がないため、Task内フィールドで十分。
```

---

### M4. createdAt/updatedAt の更新タイミング不明

**疑問**:
- `Task.updatedAt`: 状態変更時？judgementFeedback更新時？
- `Session.updatedAt`: finalJudgement設定時のみ？

**推奨修正**: 更新タイミングを明記
```markdown
| エンティティ | updatedAt 更新タイミング |
|-------------|-------------------------|
| Session | finalJudgement設定時、continue反復時 |
| Task | 状態遷移時、judgementFeedback更新時、owner変更時 |
| Run | finishedAt設定時（実質1回のみ） |
```

---

### M5. 欠けている概念

現在のモデルで表現できない重要な概念がある。

#### PlanIteration（計画の版）

**現状**:
- `planner-additional-<UUID>` が実質「別の計画」
- しかし明示的な識別子として表現されていない

**推奨**: 計画のイテレーションを独立概念として定義
```typescript
interface PlanIteration {
  id: string;                    // "plan-<UUID>"
  sessionId: string;             // 親セッションID
  iterationNumber: number;       // 0 = 初回, 1+ = continue
  taskBreakdowns: TaskBreakdown[];
  createdAt: string;
}
```

#### TaskAttempt（試行）

**現状**:
- `Run` がこれに近いが、`attemptNumber` がない
- 同一タスクの複数Runを時系列で追いにくい

**推奨**: 明示的な試行番号
```typescript
interface Run {
  // 既存...
  attemptNumber: number;  // 1, 2, 3...
}
```

#### SessionStatus（セッション状態）

**現状**:
- Session がどの段階にあるか不明（planning / executing / integrating / completed）
- `finalJudgement.isComplete` でしか判断できない

**推奨**: 明示的な状態フィールド
```typescript
type SessionStatus =
  | 'planning'     // タスク分解中
  | 'executing'    // タスク実行中
  | 'integrating'  // ブランチ統合中
  | 'completed'    // 完了
  | 'failed';      // 失敗
```

#### Evaluation履歴

**現状**:
- Judge結果は `Task.judgementFeedback` に**上書き**
- 過去の判定履歴が消える

**推奨**: 履歴配列として保持
```typescript
interface Task {
  judgementHistory: JudgementFeedback[];  // 全履歴
  // または独立エンティティとして保存
}
```

---

## 🟢 Minor Issues

### N1. Integration Task の特性が不明確

**現状**:
- `taskType: 'integration'` で通常タスクと区別
- しかし型定義は同じ `Task`

**推奨修正**: 特性を明記
```markdown
### Integration Task の特性

| 項目 | 通常Task | Integration Task |
|------|---------|------------------|
| 生成元 | Planner | Integration Operations |
| 用途 | 機能実装 | コンフリクト解決 |
| 特有フィールド | - | pendingConflictResolution |
| plannerRunId | 親Session | 元タスクのSessionを継承 |
```

---

### N2. conversationHistory の用途記載に誤り

**現状（L440-443）**:
> 3. **継続実行**: `agent continue` 時にコンテキスト保持

**問題**:
- `agent continue` は新Session（`planner-additional-<UUID>`）を作成
- 元Sessionの `conversationHistory` は直接参照されない

**推奨修正**:
```markdown
### conversationHistory の用途

1. **デバッグ**: タスク分解の意図・理由を追跡
2. **品質改善**: Planner出力品質の分析データ
3. **監査証跡**: 「なぜこのタスクが生成されたか」の記録

※ `agent continue` は新Sessionを作成するため、
  継続実行時に直接参照されるわけではない。
```

---

## 推奨アクションサマリ

### 優先度: 高（概念モデルの根本的問題）

| # | 内容 | 工数 |
|---|------|------|
| C1 | `generatedTasks` の型を `TaskBreakdown[]` に修正（ドキュメント） | 小 |
| C2 | `plannerRunId` → `sessionId` への命名変更を検討 | 中〜大 |
| C3 | 参照構造の設計方針を決定し文書化 | 小〜中 |
| C4 | 追加タスクのID体系を元セッションに統一 | 中 |
| C5 | TaskBreakdown の計画情報を Task に継承 | 中 |

### 優先度: 中（設計の明確化）

| # | 内容 | 工数 |
|---|------|------|
| M1 | Session Short ID の設計理由を追記 | 小 |
| M2 | Task State 遷移図を実装に合わせて更新 | 小 |
| M3 | Judge がエンティティでない理由を詳述 | 小 |
| M4 | タイムスタンプ更新タイミングを明記 | 小 |
| M5 | 欠けている概念（PlanIteration, SessionStatus等）の導入検討 | 大 |

### 優先度: 低（ドキュメント改善）

| # | 内容 | 工数 |
|---|------|------|
| N1 | Integration Task の特性を明記 | 小 |
| N2 | conversationHistory の用途記載を修正 | 小 |

---

## 類似システムとの比較

業界標準のワークフローシステムと比較した概念マッピング。

### 概念対応表

| Agent Orchestrator | GitHub Actions | Jenkins | Airflow | Temporal |
|-------------------|----------------|---------|---------|----------|
| Session | WorkflowRun | PipelineRun | DAGRun | WorkflowExecution |
| Task | Job | Stage | TaskInstance | Activity |
| Run | Step/Attempt | Build | try_number | ActivityAttempt |
| Judge | (なし) | (なし) | (なし) | (なし) |

### 命名の逆転問題

**業界標準**: "Run" は**上位概念**（Workflow/Pipeline全体の実行）を指すことが多い

| システム | "Run" の意味 |
|---------|-------------|
| GitHub Actions | WorkflowRun = ワークフロー全体の1回の実行 |
| Airflow | DAGRun = DAG全体の1回の実行 |
| **本システム** | Run = タスク1つの実行（= Attempt相当） |

**影響**:
- 他システム経験者が混乱しやすい
- ドキュメントで明示的に違いを説明する必要がある

### 本システム独自の概念

| 概念 | 説明 | 他システムの類似機能 |
|------|------|---------------------|
| **Planner** | LLMによるタスク分解 | なし（手動定義が一般的） |
| **Judge** | LLMによる完了判定 | なし（テスト結果で判断が一般的） |
| **Integration** | 自動コンフリクト解決 | Merge Queue（GitHub）に近い |

---

## 拡張性の観点

将来的な機能追加に対する現設計の課題。

### 並列実行の強化

**課題**:
- Session ↔ Task のリンクが `sessionShort` プレフィックスに依存
- 追加タスクのID体系が分離（C4参照）

**影響**: セッション単位の並列タスク管理が困難

### 分散実行

**課題**:
- `Run` に Worker/Host 情報がない
- ロック機構（`.locks/`）がローカルファイルシステム前提

**影響**: 複数マシンでの分散実行に対応できない

### 履歴管理・分析

**課題**:
- Judge履歴が上書きで消失（M5参照）
- TaskBreakdown の計画情報が Task に引き継がれない（C5参照）

**影響**: 「予定 vs 実績」分析、品質改善のためのデータ蓄積が困難

### 推奨: 安定IDの導入

```typescript
// 全エンティティでセッションIDを安定参照
interface Task {
  sessionId: SessionId;        // 安定ID（継承ではなく明示参照）
  planIterationId?: string;    // 計画イテレーションID（追跡用）
}

interface Run {
  sessionId: SessionId;        // 安定ID
  // ...
}
```

---

## 推奨リファクタリング案

### Phase 1: ドキュメント整備（工数: 小）

| 項目 | 内容 |
|------|------|
| 型記載の修正 | `generatedTasks: TaskBreakdown[]` に修正 |
| 命名の注意書き | `plannerRunId` が Session を指す旨を明記 |
| 状態遷移図の更新 | 実装に基づく詳細図に差し替え |
| 欠けている概念の記載 | 将来追加予定として明記 |

### Phase 2: 命名の改善（工数: 中）

| 項目 | 内容 |
|------|------|
| `plannerRunId` → `sessionId` | Task, Run の両方で変更 |
| マイグレーション | 既存データの変換スクリプト作成 |

### Phase 3: 概念モデルの拡張（工数: 大）

| 項目 | 内容 |
|------|------|
| `PlanIteration` 導入 | 計画の版管理 |
| `SessionStatus` 導入 | セッション状態の明示化 |
| Judge履歴の保持 | `judgementHistory` 配列化 |
| TaskBreakdown情報の継承 | `planningMetadata` フィールド追加 |

---

## 関連ファイル

- ドキュメント: `docs/session-concept.md`
- 型定義:
  - `src/types/planner-session.ts`
  - `src/types/task.ts`
  - `src/types/run.ts`
- 実装:
  - `src/core/orchestrator/planner-operations.ts`
  - `src/core/orchestrator/worker-operations.ts`
  - `src/core/orchestrator/judge-operations.ts`
