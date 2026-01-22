# スコア差分ノイズ耐性

## 選定日時

2026-01-23

## 選定結果

**ノイズ閾値による差分有意性判定** を採用

スコア変動が一定範囲内の場合は「実質同等」とみなし、誤判定を防止する。

## 背景・課題

### 問題点

QualityJudgeのスコアはLLMによる評価であり、同一の計画に対しても評価のたびに数点の変動が発生しうる。

```
計画A → 評価1回目: 72点
計画A → 評価2回目: 75点
計画A → 評価3回目: 70点
```

この変動により以下の問題が発生：

1. **改善の誤検知**: 実際には改善していないのに「改善した」と判定
2. **劣化の誤検知**: 実際には劣化していないのに「劣化した」と判定
3. **停滞判定の不安定**: 本来停滞なのに継続、または本来継続すべきなのに停滞と判定

### 関連ADR

- [ADR-010: Task Refinement Design](010-task-refinement-design.md) の制限事項として記載

## 採用した設計

### 1. ノイズ閾値の導入

スコア差が閾値未満の場合は「ノイズ」として扱い、前回の判定を維持：

```typescript
interface RefinementConfig {
  // 既存
  deltaThreshold: number;         // 停滞判定の絶対閾値（デフォルト: 5）
  deltaThresholdPercent: number;  // 停滞判定の相対閾値（デフォルト: 5%）

  // 新規
  noiseThreshold: number;         // ノイズ判定の閾値（デフォルト: 3）
}
```

### 2. 判定ロジック

```typescript
function isScoreChangeSignificant(
  currentScore: number,
  previousScore: number,
  noiseThreshold: number
): boolean {
  const diff = Math.abs(currentScore - previousScore);
  return diff >= noiseThreshold;
}

function determineScoreDirection(
  currentScore: number,
  previousScore: number,
  noiseThreshold: number
): 'improved' | 'degraded' | 'stable' {
  const diff = currentScore - previousScore;

  if (Math.abs(diff) < noiseThreshold) {
    return 'stable';  // ノイズ範囲内 → 実質同等
  }

  return diff > 0 ? 'improved' : 'degraded';
}
```

### 3. makeRefinementDecision への統合

既存の停滞判定ロジックにノイズ判定を追加：

```typescript
// 既存: 停滞判定
const improvement = currentScore - previousScore;
const isStagnated = improvement < deltaThreshold
  || relativeImprovement < deltaThresholdPercent;

// 新規: ノイズ判定を追加
const direction = determineScoreDirection(currentScore, previousScore, noiseThreshold);

if (direction === 'stable') {
  // スコア変動がノイズ範囲内
  // → 前回の判定を維持、または追加のreplan試行をスキップ
}
```

## 設定項目

| 設定 | デフォルト | 説明 |
|------|-----------|------|
| noiseThreshold | 3 | この値未満のスコア差は「ノイズ」として扱う |

## 影響範囲

### 変更対象ファイル

1. **types/planner-session.ts**: `RefinementConfig` に `noiseThreshold` 追加
2. **src/core/orchestrator/planner-operations.ts**: `makeRefinementDecision` にノイズ判定追加
3. **.agent/config-schema.json**: `noiseThreshold` 設定追加
4. **src/config/agent-config.ts**: デフォルト値設定

### 後方互換性

- 設定が存在しない場合はデフォルト値（3）で動作
- 既存の `deltaThreshold` との関係: `noiseThreshold` < `deltaThreshold` を推奨

## 利点

1. **誤判定の低減**: LLMスコアの自然な変動による誤った意思決定を防止
2. **低コスト**: 追加のLLM呼び出しなし、単純な数値比較のみ
3. **既存ロジックとの親和性**: 停滞判定ロジックに自然に統合可能

## 制約・考慮事項

| リスク | 対策 |
|--------|------|
| 閾値が大きすぎると実際の改善/劣化を見逃す | デフォルト3、最大5程度を推奨 |
| 閾値が小さすぎるとノイズ対策にならない | 最小2以上を推奨 |

## テスト戦略

### 単体テスト

- `isScoreChangeSignificant()` の境界値テスト
- `determineScoreDirection()` の各パターン
- ノイズ範囲内でのrefinement判定

### テストケース例

```typescript
// ノイズ閾値: 3
assert(determineScoreDirection(72, 70, 3) === 'stable');   // diff=2 < 3
assert(determineScoreDirection(75, 70, 3) === 'improved'); // diff=5 >= 3
assert(determineScoreDirection(66, 70, 3) === 'degraded'); // diff=-4, |diff|>=3
```

## ステータス

**設計中**

---

## 次回セッション用情報

### 参照すべきファイル

| ファイル | 内容 |
|----------|------|
| `src/types/planner-session.ts:139-148` | `RefinementConfig` 型定義 |
| `src/types/planner-session.ts:169-177` | `RefinementResult` 型定義 |
| `src/types/planner-session.ts:183-190` | `StructureValidation` 型定義 |
| `src/core/orchestrator/planner-operations.ts` | `makeRefinementDecision` 実装箇所 |
| `tests/unit/core/orchestrator/validate-structure.test.ts` | 既存テスト |

### 実装タスク

1. `RefinementConfig` に `noiseThreshold: number` を追加
2. `isScoreChangeSignificant()` 関数を新規作成
3. `determineScoreDirection()` 関数を新規作成
4. `makeRefinementDecision()` にノイズ判定を統合
5. `.agent/config-schema.json` に設定追加
6. 単体テスト追加

### 確認ポイント

- `makeRefinementDecision` の現在の停滞判定ロジックを確認
- `deltaThreshold` との関係性（noiseThreshold < deltaThreshold を推奨）
- `RefinementResult` に `scoreDirection` フィールドを追加するか検討
