# マージ失敗時の評価改善

## ステータス

**Draft** 📝

要再設計。現在のエラーハンドリングフローとの整合性確保が必要。

## 選定日時

2026-01-23

## 選定結果

**未決定** - 設計の見直しが必要

## 背景・課題

### 問題: マージ失敗時の完了評価誤り

マージ失敗時、タスクが実際には成功していても完了評価が0%/5%になる可能性がある。

**評価フロー**:
1. `mergeTasksInWorktree()` でタスクをマージ
2. マージ失敗 → 統合worktreeにコード変更がない
3. `getIntegrationDiff()` が空のdiffを返す
4. `judgeFinalCompletionWithContext()` が空のdiffを見て評価
5. 結果: 0%/5%と判定、「実装がされていない」と報告

### 緩和要因

- [ADR-015](015-integration-worktree-signature-control.md): 署名制御修正により、署名エラー起因のマージ失敗が減少
- [ADR-016](016-merge-failure-error-recovery.md): MERGE_HEADクリーンアップにより、連鎖エラーが防止

これらの修正後、マージ失敗の発生頻度自体が大幅に減少する見込み。

## 検討中の修正内容

### 案1: MergeFailureDetail型による詳細収集

```typescript
// src/types/integration.ts
export interface MergeFailureDetail {
  taskId: TaskId;
  branch: BranchName;
  error: string;
}

export interface IntegrationMergeResult {
  // 既存フィールド...
  failureDetails: MergeFailureDetail[];  // 追加
}
```

**課題**: 現在の実装ではマージエラー時に即座に`createErr`で返却するため、`failureDetails`を蓄積する前に関数が終了する。

```typescript
// 現在の実装（integration-operations.ts:563-566）
if (isErr(mergeResult)) {
  await gitEffects.abortMerge(repo);
  return createErr(mergeResult.err);  // ← ここで即座に返却
}
```

### 案2: 評価フォールバック

```typescript
// orchestrate.ts
if (mergeResult && !mergeResult.val.success && codeChanges === '') {
  console.log('  ⚠️  Merge failed, using task-based evaluation fallback');
  // hasMergeFailure フラグを設定し、成功タスク情報に基づいて評価
}
```

**課題**: マージ失敗という重要な問題を隠蔽するリスクがある。

### 案3: 部分マージ継続

マージ失敗したタスクをスキップして、成功したタスクのみでマージを継続する。

```typescript
const failedMerges: MergeFailureDetail[] = [];

for (const task of completedTasks) {
  const mergeResult = await gitEffects.merge(repo, sourceBranch, options);

  if (isErr(mergeResult)) {
    await gitEffects.abortMerge(repo);
    failedMerges.push({ taskId: task.id, branch: sourceBranch, error: mergeResult.err.message });
    continue;  // ← 次のタスクへ継続
  }
  // ...
}

return createOk({
  success: failedMerges.length === 0,
  mergedTaskIds,
  conflictedTaskIds,
  conflictResolutionTaskId,
  failureDetails: failedMerges,
});
```

**課題**: 部分マージの結果が一貫性を持つか不明。依存関係のあるタスク間で問題が発生する可能性。

## 推奨アクション

1. **ADR-015/016の効果を観察**: これらの修正後にマージ失敗がどの程度発生するか計測
2. **発生頻度に基づいて判断**:
   - 頻度が高い場合 → 案3（部分マージ継続）を検討
   - 頻度が低い場合 → 現状維持でも許容可能
3. **隠蔽を避ける**: いずれの案でも、マージ失敗は明示的にレポートに記録する

## 変更対象ファイル（案3の場合）

| ファイル | 変更内容 |
|---|---|
| `src/types/integration.ts` | `MergeFailureDetail`型追加、`IntegrationMergeResult`拡張 |
| `src/core/orchestrator/integration-operations.ts` | 部分マージ継続ロジック |
| `src/core/orchestrator/orchestrate.ts` | マージ失敗時の評価コンテキスト追加 |
| `src/core/orchestrator/planner-operations.ts` | `hasMergeFailure`フラグ対応（オプショナル） |

## 関連ADR

- [ADR-015: 統合worktree内コミットの署名制御](015-integration-worktree-signature-control.md) - 根本原因の修正
- [ADR-016: マージ失敗時のエラーリカバリ](016-merge-failure-error-recovery.md) - MERGE_HEADクリーンアップ
- [ADR-017: 統合結果のレポート可視化](017-integration-result-visibility.md) - レポート改善
