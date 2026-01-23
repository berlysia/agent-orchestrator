# Task Refinement 機能の設計

## ステータス

**Implemented** ✅

RefinementConfig、makeRefinementDecision等が実装済み。

## 選定日時

2026-01-23

## 選定結果

**フィードバック付き再計画（Feedback-based Replanning）方式** を採用

## 背景

品質評価（QualityJudge）の結果に含まれる `issues` と `suggestions` を活用して、タスク計画を改善する機能が必要。

### 現状の問題

1. **成功時のSuggestions消失**: `isAcceptable=true` でも `suggestions` が存在するケースがあるが、現状は無視される
2. **失敗時の無限再生成リスク**: `isAcceptable=false` の場合、フィードバック付きで「再生成」を繰り返し、無限ループに陥るリスク
3. **改善検証の欠如**: 再生成後のスコアが向上したかの検証がない

## 設計レビュー経緯

3回の評価サイクル（v1→v2→v3→v3.1）を経て設計を確定。

### Logic-Validator / Codex からの主な指摘と対応

| 指摘 | 対応 |
|------|------|
| 「修正」と「再生成」の境界が曖昧 | 「フィードバック付き再計画」として統一 |
| 収束性が未保証 | 改善停滞検知（deltaThreshold）を追加 |
| 最大試行回数到達時の動作が不明 | accept/rejectを明確化 |
| 停滞＋品質未達で無駄なループ | rejectするよう修正（v3.1） |
| スコアundefined時の処理が不明 | 初回試行も含めフォールバック処理追加（v3.1） |
| suggestionsによる無限ループ | maxSuggestionReplansで制限（v3.1） |

## 採用理由

1. **LLM全体再生成を許容**: 「修正」を依頼しても全体再生成される可能性が高いため、それを前提とした設計
2. **明確な意思決定フロー**: 優先度1〜6として判定順序を明文化
3. **複数の終了条件**: 最大試行回数、改善停滞、スコア未取得の3つで無限ループを防止
4. **構造検証**: タスク数変化率、依存関係チェックで破壊的変更を検出

## 設計概要

### フロー

```
Plan → QualityJudge → makeRefinementDecision()
                       ├─ accept   → 続行（suggestionsは記録）
                       ├─ replan   → フィードバック付き再計画 → 構造検証 → 改善検証 → ループ
                       └─ reject   → エラー終了
```

### 意思決定優先順位

1. 最大試行回数到達 → accept（品質OK時）/ reject（品質NG時）
2. スコア取得失敗 → accept（品質OK時）/ reject（品質NG時）
3. 改善停滞検知 → accept（品質OK時）/ replan継続（品質NG時、試行回数残りあり）
4. 品質未達 → replan
5. 品質OK + suggestions + 設定有効 + 上限未達 → replan
6. 品質OK → accept

**NOTE**: 優先順位3で停滞+品質NGでもreplan継続とするのは、停滞しても試行回数が残っていれば諦めずに改善を試みるため。最大試行回数に達した場合は優先順位1で処理される。

### 構造検証

- タスク数変化率 > 30% かつ 絶対差 > 2 → 構造破壊
- 依存関係の不整合 → 構造破壊
- 循環依存 → 構造破壊
- 構造破壊時 → タスク単位フォールバック or 前回タスク使用

### 停滞判定

```typescript
// 絶対値と相対値のOR判定（より保守的に早期終了）
const isStagnated = improvement < deltaThreshold    // 絶対値 < 5
  || relativeImprovement < deltaThresholdPercent;   // 相対値 < 5%
```

OR条件の理由: ANDだと片方が大きければ継続し、無限ループリスクが高まる

## 設定項目

| 設定 | デフォルト | 説明 |
|------|-----------|------|
| maxRefinementAttempts | 2 | 再計画最大回数 |
| refineSuggestionsOnSuccess | false | 品質OKでもsuggestionsで再計画するか |
| maxSuggestionReplans | 1 | suggestionsによる再計画の上限 |
| enableIndividualFallback | true | タスク単位フォールバック有効化 |
| deltaThreshold | 5 | 停滞判定の絶対閾値 |
| deltaThresholdPercent | 5 | 停滞判定の相対閾値（%） |
| taskCountChangeThreshold | 0.3 | タスク数変化率の閾値（30%） |
| taskCountChangeMinAbsolute | 2 | タスク数変化の絶対差下限 |

## 実装対象ファイル

1. **types/planner-session.ts**: RefinementConfig, RefinementDecision, RefinementResult, Feedback, StructureValidation
2. **src/core/orchestrator/planner-operations.ts**: makeRefinementDecision, validateStructure, replanWithFeedback等
3. **.agent/config-schema.json**: refinement設定セクション
4. **src/config/agent-config.ts**: refinement設定読み込み

## 後方互換性

- 設定が存在しない場合はデフォルト値で動作
- 既存の `maxQualityRetries` との共存: 両方設定時は `maxRefinementAttempts` を優先

## 制限事項

1. **LLMの挙動は保証されない**: 再計画を依頼しても全体再生成される可能性
2. **スコアの安定性に依存**: QualityJudgeのスコアが不安定だと誤判定の可能性
3. **質劣化の検出限界**: 「粒度が粗くなる」「重要タスクが消える」等は検出不可

## 将来の拡張

1. FinalCompletionJudgementのsuggestionsへの適用
2. Suggestionsの優先度分類（critical/major/minor）
3. 別Judgeでの再検証オプション
4. 影響範囲限定（関連タスクのみ再計画）

## 詳細設計

詳細な実装仕様（型定義、関数シグネチャ、プロンプト設計等）は実装時にコード内のコメントとして記載する。
