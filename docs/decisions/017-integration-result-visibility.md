# 統合結果のレポート可視化

## ステータス

**Proposed** ⏳

IntegrationInfo型等は未実装。

## 選定日時

2026-01-23

## 選定結果

**IntegrationInfo型を追加し、レポートに統合結果を含める**

## 背景・課題

### 問題: レポートの情報不足

現在のレポートに含まれる情報：
- 監視期間
- タスク統計（総数、完了、失敗、スキップ、ブロック）
- タスクサマリー
- イベント（コンフリクト、リトライ）

**不足している情報**:
- 統合ブランチ名
- マージ成功/失敗の数
- 完了評価スコア
- 未達成の側面（missingAspects）

### 先行事例

手動作成の監視レポート（`.tmp/monitoring-report-2026-01-23.md`）では、以下の情報が有用だった：
- 統合ブランチ: `integration/evaluation-1769114871832`
- コンフリクト発生と自動解決の詳細
- タスク実行の流れと結果

これらを自動生成レポートに含めることで、監視の手間を削減できる。

## 修正内容

### Phase 1: 型定義追加

#### IntegrationInfo型

```typescript
// src/core/report/types.ts
export interface IntegrationInfo {
  /** 統合ブランチ名 */
  integrationBranch?: string;
  /** マージ成功数 */
  mergedCount: number;
  /** コンフリクト発生数 */
  conflictCount: number;
  /** コンフリクト解決タスクID（存在する場合） */
  conflictResolutionTaskId?: string;
  /** 完了スコア（0-100） */
  completionScore?: number;
  /** 未達成の側面 */
  missingAspects: string[];
}

export interface ReportData {
  // ... 既存フィールド
  integration?: IntegrationInfo;
}
```

### Phase 2: 統合情報の構築

```typescript
// orchestrate.ts
const integrationInfo: IntegrationInfo = {
  integrationBranch: integrationWorktreeInfo?.integrationBranch
    ? String(integrationWorktreeInfo.integrationBranch)
    : undefined,
  mergedCount: mergeResult?.val?.mergedTaskIds.length ?? 0,
  conflictCount: mergeResult?.val?.conflictedTaskIds.length ?? 0,
  conflictResolutionTaskId: mergeResult?.val?.conflictResolutionTaskId
    ? String(mergeResult.val.conflictResolutionTaskId)
    : undefined,
  completionScore: finalJudgement.completionScore,
  missingAspects: finalJudgement.missingAspects,
};
```

### Phase 3: レポートフォーマット

```typescript
// formatter.ts
if (data.integration) {
  sections.push('## 統合結果');
  sections.push(`- 統合ブランチ: ${data.integration.integrationBranch ?? '未作成'}`);
  sections.push(`- マージ成功: ${data.integration.mergedCount}`);
  sections.push(`- コンフリクト: ${data.integration.conflictCount}`);

  if (data.integration.conflictResolutionTaskId) {
    sections.push(`- コンフリクト解決タスク: ${data.integration.conflictResolutionTaskId}`);
  }

  if (data.integration.completionScore !== undefined) {
    sections.push('');
    sections.push(`### 完了評価`);
    sections.push(`- スコア: ${data.integration.completionScore}%`);
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

### Phase 4: サマリー出力の改善

```typescript
// orchestrate.ts
if (mergeResult?.val?.conflictedTaskIds.length > 0) {
  console.log(`  Conflicts resolved: ${mergeResult.val.conflictedTaskIds.length}`);
}
console.log(`  Completion score: ${finalJudgement.completionScore ?? 'N/A'}%`);
```

## 変更対象ファイル

| ファイル | 変更内容 |
|---|---|
| `src/core/report/types.ts` | `IntegrationInfo`型追加、`ReportData`拡張 |
| `src/core/orchestrator/orchestrate.ts` | 統合情報構築、サマリー出力改善 |
| `src/core/report/collector.ts` | 統合情報収集パラメータ追加 |
| `src/core/report/formatter.ts` | 統合情報フォーマット追加 |
| `src/cli/commands/run.ts` | 統合情報をレポートに渡す |
| `src/cli/commands/continue.ts` | 同上 |

## 後方互換性

- レポート形式に新規セクション「統合結果」が追加されるが、既存セクションは維持
- `integration` が未指定の場合、レポートは従来通り動作

## テスト計画

1. `collectReportData` が `integrationInfo` を正しく受け取ること
2. `formatReportAsMarkdown` が統合情報を正しくフォーマットすること
3. `integration` が `undefined` の場合も正常動作すること

## 関連ADR

- [ADR-015: 統合worktree内コミットの署名制御](015-integration-worktree-signature-control.md)
- [ADR-016: マージ失敗時のエラーリカバリ](016-merge-failure-error-recovery.md)
- [ADR-018: マージ失敗時の評価改善](018-merge-failure-evaluation-improvement.md) - 評価ロジック改善（要再設計）
