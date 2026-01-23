# 統合結果の可視化

## 選定日時

2026-01-23

## 選定結果

**IntegrationInfo型を追加し、レポートとサマリーにマージ結果を含める**

## 背景・課題

### 問題1: 完了評価の誤り

マージ失敗時、タスクが実際には成功していても完了評価が0%/5%になる。

**評価フロー**:
1. `mergeTasksInWorktree()` でタスクをマージ
2. マージ失敗 → 統合worktreeにコード変更がない
3. `getIntegrationDiff()` が空のdiffを返す
4. `judgeFinalCompletionWithContext()` が空のdiff（`codeChanges`）を見て評価
5. 結果: 0%/5%と判定、「実装がされていない」と報告

### 問題2: レポートの不足

現在のレポートに含まれる情報：
- 監視期間
- タスク統計（総数、完了、失敗、スキップ、ブロック）
- タスクサマリー
- イベント（コンフリクト、リトライ）

**不足している情報**:
- 統合/マージの成否
- マージ失敗したブランチの詳細
- 完了評価の「Missing aspects」
- 統合ブランチの状態

## 修正内容

### Phase 1: 型定義追加

#### IntegrationInfo型

```typescript
// src/core/report/types.ts
export interface IntegrationInfo {
  integrationBranch?: string;
  mergedCount: number;
  failedCount: number;
  failedBranches: Array<{
    taskId: string;
    branch: string;
    error: string;
  }>;
  completionScore?: number;
  missingAspects: string[];
}

export interface ReportData {
  // ... 既存フィールド
  integration?: IntegrationInfo;
}
```

#### MergeFailureDetail型

```typescript
// src/types/integration.ts
export interface MergeFailureDetail {
  taskId: TaskId;
  branch: BranchName;
  error: string;
}

export interface IntegrationMergeResult {
  success: boolean;
  mergedTaskIds: TaskId[];
  conflictedTaskIds: TaskId[];
  conflictResolutionTaskId: TaskId | null;
  failureDetails: MergeFailureDetail[];  // 追加
}
```

### Phase 2: 失敗詳細の収集

`mergeTasksInWorktree` 内で失敗詳細を収集：

```typescript
const failureDetails: MergeFailureDetail[] = [];

// マージエラー時
if (isErr(mergeResult)) {
  await gitEffects.abortMerge(repo);
  failureDetails.push({
    taskId: task.id,
    branch: sourceBranch,
    error: mergeResult.err.message,
  });
  return createErr(mergeResult.err);
}

// 戻り値に追加
return createOk({
  success: conflictedTaskIds.length === 0,
  mergedTaskIds,
  conflictedTaskIds,
  conflictResolutionTaskId,
  failureDetails,
});
```

### Phase 3: 評価ロジックの改善

マージ失敗時のフォールバック評価を追加：

```typescript
// orchestrate.ts
if (mergeResult && !mergeResult.val.success && codeChanges === '') {
  console.log('  ⚠️  Merge failed, using task-based evaluation fallback');
  // hasMergeFailure フラグを設定し、成功タスク情報に基づいて評価
}
```

`judgeFinalCompletionWithContext` にマージ失敗フラグを追加：

```typescript
interface FinalJudgementContext {
  // 既存パラメータ...
  hasMergeFailure?: boolean;
  mergedTaskCount?: number;
}
```

### Phase 4: 統合情報の構築と受け渡し

```typescript
// orchestrate.ts
const integrationInfo: IntegrationInfo = {
  integrationBranch: integrationWorktreeInfo?.integrationBranch
    ? String(integrationWorktreeInfo.integrationBranch)
    : undefined,
  mergedCount: mergeResult?.val?.mergedTaskIds.length ?? 0,
  failedCount: mergeResult?.val?.failureDetails?.length ?? 0,
  failedBranches: (mergeResult?.val?.failureDetails ?? []).map(d => ({
    taskId: String(d.taskId),
    branch: String(d.branch),
    error: d.error,
  })),
  completionScore: finalJudgement.completionScore,
  missingAspects: finalJudgement.missingAspects,
};
```

### Phase 5: レポートフォーマット

```typescript
// formatter.ts
if (data.integration) {
  sections.push('## 統合結果');
  sections.push(`- 統合ブランチ: ${data.integration.integrationBranch ?? '未作成'}`);
  sections.push(`- マージ成功: ${data.integration.mergedCount}`);
  sections.push(`- マージ失敗: ${data.integration.failedCount}`);

  if (data.integration.failedBranches.length > 0) {
    sections.push('');
    sections.push('### マージ失敗詳細');
    for (const failed of data.integration.failedBranches) {
      sections.push(`- ${failed.taskId} (${failed.branch}): ${failed.error}`);
    }
  }

  if (data.integration.completionScore !== undefined) {
    sections.push('');
    sections.push(`- 完了スコア: ${data.integration.completionScore}%`);
  }

  if (data.integration.missingAspects.length > 0) {
    sections.push('');
    sections.push('### 未達成の側面');
    for (const aspect of data.integration.missingAspects) {
      sections.push(`- ${aspect}`);
    }
  }
}
```

### Phase 6: サマリー出力の改善

```typescript
// orchestrate.ts
const mergeFailureCount = mergeResult?.val?.failureDetails?.length ?? 0;
if (mergeFailureCount > 0) {
  console.log(`  Merge failures: ${mergeFailureCount}`);
  console.log(`  Status: ⚠️  PARTIAL (${mergeFailureCount} merge failure(s))`);
} else if (failedTaskIds.length > 0) {
  console.log(`  Status: ⚠️  PARTIAL (${failedTaskIds.length} task failure(s))`);
} else {
  console.log(`  Status: ✅ SUCCESS`);
}
```

## 変更対象ファイル

| ファイル | 変更内容 |
|---|---|
| `src/types/integration.ts` | `MergeFailureDetail`型、`IntegrationMergeResult`拡張 |
| `src/core/report/types.ts` | `IntegrationInfo`型追加、`ReportData`拡張 |
| `src/core/orchestrator/integration-operations.ts` | failureDetails収集 |
| `src/core/orchestrator/orchestrate.ts` | 統合情報構築、サマリー出力改善、評価フォールバック |
| `src/core/orchestrator/planner-operations.ts` | マージ失敗フラグ対応（オプショナル） |
| `src/core/report/collector.ts` | 統合情報収集パラメータ追加 |
| `src/core/report/formatter.ts` | 統合情報フォーマット追加 |
| `src/core/report/generator.ts` | `saveReportWithIntegration`メソッド追加 |
| `src/cli/utils/auto-report.ts` | `generateReportSafelyWithIntegration`関数追加 |
| `src/cli/commands/run.ts` | 統合情報をレポートに渡す |
| `src/cli/commands/continue.ts` | 同上 |

## 後方互換性

- レポート形式に新規セクション「統合結果」が追加されるが、既存セクションは維持
- 既存のAPIシグネチャには後方互換性を維持する新規パラメータ（オプショナル）を追加
- `integrationInfo` が未指定の場合、レポートは従来通り動作

## テスト計画

1. `IntegrationMergeResult` に `failureDetails` が正しく含まれること
2. `collectReportData` が `integrationInfo` を正しく受け取ること
3. `formatReportAsMarkdown` が統合情報を正しくフォーマットすること
4. マージ失敗時も完了タスク情報に基づいて部分的な評価ができること
5. マージ失敗時にステータスが `PARTIAL` になること
6. 全成功時にステータスが `SUCCESS` になること

## ステータス

**実装予定**

## 関連ADR

- [ADR-015: 統合worktree内コミットの署名制御](015-integration-worktree-signature-control.md) - 根本原因の修正
- [ADR-016: マージ失敗時のエラーリカバリ](016-merge-failure-error-recovery.md) - MERGE_HEADクリーンアップ
