# Judge再評価戦略の導入

## ステータス

**Implemented** ✅

- Phase 2-1: 型・データ構造の拡張 ✅
- Phase 2-2: Planner再評価機能 ✅
- Phase 2-3: Executor統合 ✅

## 選定日時

2026-01-21

## 選定結果

**Planner自動再評価方式** を採用

タスクが `shouldReplan=true` と判定された場合、Plannerに自動的にタスク再分解を依頼し、より適切なサブタスクに分割する。

## 背景・課題

### 問題点

従来のJudge判定では、`BLOCKED` 状態になったタスクは手動介入（`resume` コマンド）が必要でした。

```
Judge判定 → success=true  → DONE
          → success=false && shouldContinue=true  → NEEDS_CONTINUATION（リトライ）
          → success=false && shouldContinue=false → BLOCKED（手動介入が必要）
```

しかし、以下のケースでは自動回復が可能なはずでした：
- タスクスコープが大きすぎて単一イテレーションで完了できない
- タスク要件が不明確で、より具体的な分解が必要
- 実装アプローチが根本的に間違っている

これらは「Workerでは解決不可能だが、タスク分解をやり直せば解決可能」なケースです。

## 採用した設計

### 1. Judge判定の3段階化

新しい判定フロー：

```
Judge判定 → success=true                                    → DONE
          → success=false && shouldContinue=true            → NEEDS_CONTINUATION
          → success=false && shouldReplan=true              → Planner再評価
          → success=false && !shouldContinue && !shouldReplan → BLOCKED
```

#### shouldReplan判定基準

以下のケースで `shouldReplan=true` と判定：
- タスクスコープが大きすぎて単一イテレーションで完了できない
- タスク要件が矛盾している、または不明確
- 実装アプローチが根本的に間違っている
- 外部リソースや前提条件が欠けている
- 現在のタスク設計では完了が不可能

### 2. タスク状態管理

#### 新状態の追加

```typescript
export const TaskState = {
  READY: 'READY',
  RUNNING: 'RUNNING',
  NEEDS_CONTINUATION: 'NEEDS_CONTINUATION',
  DONE: 'DONE',
  BLOCKED: 'BLOCKED',
  CANCELLED: 'CANCELLED',
  REPLACED_BY_REPLAN: 'REPLACED_BY_REPLAN',  // 新規追加
} as const;
```

#### タスクメタデータの拡張

```typescript
replanningInfo: {
  iteration: number;              // 現在の再評価回数
  maxIterations: number;          // 最大再評価回数（デフォルト: 3）
  originalTaskId?: TaskId;        // 元のタスクID（再評価の連鎖を追跡）
  replacedBy?: TaskId[];          // 生成されたサブタスクID
  replanReason?: string;          // 再評価理由
}
```

### 3. Planner再評価フロー

```
[Judge判定: shouldReplan=true]
    ↓
[Worker実行ログを取得]
    ↓
[Planner再評価プロンプト生成]
    ↓
[Planner実行（新タスク分解）]
    ↓
[新タスクをTaskStoreに保存]
    ↓
[元タスクをREPLACED_BY_REPLANにマーク]
    ↓
[新タスクを実行キューに追加]
    ↓
[実行再開]
```

#### Planner再評価プロンプト

元のタスク情報、Worker実行ログ、Judge判定結果を組み合わせて、より適切なタスク分解を依頼：

- 元のタスク情報（acceptance, context, scopePaths）
- Worker実行ログ
- Judge判定結果（reason, missingRequirements）
- 再分解の方針（より小さく、達成可能なタスクに分割）

### 4. 無限ループ防止

最大再評価回数の制限（デフォルト: 3回）：

```typescript
if (newIteration >= maxReplanIterations) {
  // 最大リトライ回数超過 → BLOCKED
  await markTaskAsBlocked(tid);
}
```

## 実装詳細

### 主要ファイル

1. **型・データ構造** (`src/types/task.ts`, `src/types/config.ts`)
   - `TaskState.REPLACED_BY_REPLAN` の追加
   - `Task.replanningInfo` フィールドの追加
   - `ReplanningConfig` の追加

2. **Planner再評価操作** (`src/core/orchestrator/replanning-operations.ts`)
   - `buildReplanningPrompt()` - 再評価プロンプト生成
   - `replanFailedTask()` - タスク再評価と新タスク生成
   - `markTaskAsReplanned()` - タスク状態を REPLACED_BY_REPLAN に遷移

3. **Executor統合** (`src/core/orchestrator/*.ts`)
   - `task-execution-pipeline.ts` - PlannerDeps情報の伝播
   - `serial-executor.ts`, `dynamic-scheduler.ts` - shouldReplan=trueの処理

4. **Judge判定** (`src/core/orchestrator/judge-operations.ts`)
   - `JudgementResult.shouldReplan` フィールドの追加
   - Judge promptでshouldReplan判定基準を明示化

### 設定パラメータ

```json
{
  "replanning": {
    "enabled": true,
    "maxIterations": 3,
    "timeoutSeconds": 300
  }
}
```

## 利点

1. **自動回復率の向上**: 手動介入なしでタスク完了率が向上
2. **タスク設計の柔軟性**: 大きめのタスクでも、必要に応じて自動分割
3. **Judge判定の精緻化**: 3段階判定により、より適切な対応が可能
4. **追跡可能性**: `replanningInfo` により再評価の履歴を追跡可能

## 制約・考慮事項

### リスクと対策

| リスク | 対策 |
|--------|------|
| 無限ループ | 最大再評価回数の制限（デフォルト: 3回） |
| タスク爆発 | プロンプトで「3-5個のタスクに分割」を推奨 |
| コスト増加 | 設定で `replanning.enabled` を無効化可能 |
| 依存関係の複雑化 | 再評価で生成されたタスク間の依存のみを考慮 |

### 今後の拡張可能性

- **Planner学習機能**: 過去の再評価パターンを学習し、効果的な分解方法を提案
- **段階的タスク実行**: 再評価で生成されたタスクを段階的に実行
- **Judge+Planner対話**: JudgeがPlannerに質問を投げ、追加情報を提供して再分解

## テスト戦略

### 単体テスト

- `buildReplanningPrompt()` のプロンプト生成
- `markTaskAsReplanned()` の状態遷移
- 最大リトライ回数超過のケース

### E2Eテスト（手動検証）

検証シナリオ：
1. 大きすぎるタスクが再分解される
2. 最大リトライ回数超過でBLOCKEDになる
3. Planner再評価失敗時のフォールバック

## 参考資料

- [Judge Improvement Progress](.tmp/docs/judge-improvement-progress.md)
- [Replanning Implementation Plan](.tmp/docs/replanning-implementation-plan.md)
- [Phase 2 Implementation Status](.tmp/docs/phase2-implementation-status.md)

## 実装完了日

2026-01-21
