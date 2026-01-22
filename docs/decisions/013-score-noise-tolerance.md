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

### 現状の実装

現在の `isStagnated()` 関数（`planner-operations.ts:2416-2434`）:

```typescript
function isStagnated(
  currentScore: number | undefined,
  previousScore: number | undefined,
  config: RefinementConfig,
): boolean {
  if (currentScore === undefined || previousScore === undefined) {
    return false;
  }
  const improvement = currentScore - previousScore;
  const relativeImprovement =
    previousScore > 0 ? (improvement / previousScore) * 100 : 0;

  // OR条件: 片方でも閾値未満なら停滞とみなす
  return (
    improvement < config.deltaThreshold ||
    relativeImprovement < config.deltaThresholdPercent
  );
}
```

**問題**: この関数は「改善が十分か」を判定するが、**ノイズによる誤判定**を考慮していない。

## 採用した設計

### 概念の整理

| 判定 | 目的 | 条件 | 例 |
|------|------|------|-----|
| **停滞判定** (既存) | 改善が十分か | `improvement < deltaThreshold` | 70→75: 改善5 < 閾値5 → 停滞 |
| **ノイズ判定** (新規) | 変動が有意か | `|diff| < noiseThreshold` | 70→72: |diff|=2 < 閾値3 → ノイズ |

**関係性**: `noiseThreshold` < `deltaThreshold` を推奨（ノイズ範囲は停滞範囲より狭い）

### 1. 型定義の変更

```typescript
// src/types/planner-session.ts

// スコア変動の方向を表す型（新規）
// 'unknown' は previousScore が存在しない場合（初回評価）に使用
export type ScoreDirection = 'improved' | 'degraded' | 'stable' | 'unknown';

// RefinementConfig に追加
export type RefinementConfig = {
  // 既存フィールド（変更なし）
  maxRefinementAttempts: number;
  refineSuggestionsOnSuccess: boolean;
  maxSuggestionReplans: number;
  enableIndividualFallback: boolean;
  deltaThreshold: number;
  deltaThresholdPercent: number;
  taskCountChangeThreshold: number;
  taskCountChangeMinAbsolute: number;

  // 新規フィールド
  noiseThreshold: number;  // デフォルト: 3
};

// RefinementResult に追加
export type RefinementResult = {
  decision: RefinementDecision;
  reason: string;
  feedback?: Feedback;
  previousScore?: number;
  currentScore?: number;
  attemptCount: number;
  suggestionReplanCount: number;

  // 新規フィールド
  scoreDirection?: ScoreDirection;
};
```

**Zodスキーマへの追加**（`src/types/planner-session.ts`）:

```typescript
// refinementHistory スキーマに scoreDirection を追加
refinementHistory: z
  .array(
    z.object({
      decision: z.enum(['accept', 'replan', 'reject']),
      reason: z.string(),
      feedback: z
        .object({
          issues: z.array(z.string()),
          suggestions: z.array(z.string()),
        })
        .optional(),
      previousScore: z.number().optional(),
      currentScore: z.number().optional(),
      attemptCount: z.number().int(),
      suggestionReplanCount: z.number().int(),
      // 新規
      scoreDirection: z.enum(['improved', 'degraded', 'stable', 'unknown']).optional(),
    }),
  )
  .optional(),
```

### 2. ヘルパー関数の追加

```typescript
// src/core/orchestrator/planner-operations.ts

/**
 * スコア変動が有意（ノイズではない）かを判定
 *
 * WHY: LLMスコアの自然な変動（±2-3点）を「ノイズ」として扱い、
 *      誤った意思決定を防止するために使用
 *
 * 注意: previousScore が undefined の場合（初回評価）は true を返す
 *       → 初回評価ではノイズ判定をスキップし、通常の評価フローを継続
 *
 * @param currentScore 現在のスコア
 * @param previousScore 前回のスコア
 * @param noiseThreshold ノイズ判定の閾値
 * @returns 変動が有意な場合true、ノイズの場合false
 */
export function isScoreChangeSignificant(
  currentScore: number | undefined,
  previousScore: number | undefined,
  noiseThreshold: number,
): boolean {
  // 初回評価（previousScore がない）は「有意」として扱う
  // → ノイズ判定をスキップして通常の評価フローを継続
  if (previousScore === undefined) {
    return true;
  }
  // currentScore がない場合は判定不能 → 有意として扱う
  if (currentScore === undefined) {
    return true;
  }
  const diff = Math.abs(currentScore - previousScore);
  return diff >= noiseThreshold;
}

/**
 * スコア変動の方向を判定
 *
 * WHY: ノイズを考慮したスコア変動の方向を判定し、
 *      refinement履歴に記録するために使用
 *
 * @param currentScore 現在のスコア
 * @param previousScore 前回のスコア
 * @param noiseThreshold ノイズ判定の閾値
 * @returns 'improved' | 'degraded' | 'stable' | 'unknown'
 */
export function determineScoreDirection(
  currentScore: number | undefined,
  previousScore: number | undefined,
  noiseThreshold: number,
): ScoreDirection {
  // スコアが欠損している場合は 'unknown' を返す
  // これにより「ノイズで安定」と「スコア未取得」を区別可能
  if (currentScore === undefined || previousScore === undefined) {
    return 'unknown';
  }

  const diff = currentScore - previousScore;

  if (Math.abs(diff) < noiseThreshold) {
    return 'stable';  // ノイズ範囲内 → 実質同等
  }

  return diff > 0 ? 'improved' : 'degraded';
}
```

### 3. makeRefinementDecision への統合

**重要**: 初回評価（`previousScore === undefined`）ではノイズ判定をスキップする。

```typescript
// src/core/orchestrator/planner-operations.ts:2452

export function makeRefinementDecision(params: {
  isAcceptable: boolean;
  score?: number;
  previousScore?: number;
  issues: string[];
  suggestions: string[];
  attemptCount: number;
  suggestionReplanCount: number;
  config: RefinementConfig;
}): RefinementResult {
  const {
    isAcceptable,
    score,
    previousScore,
    issues,
    suggestions,
    attemptCount,
    suggestionReplanCount,
    config,
  } = params;

  // スコア変動の方向を判定（履歴記録用）
  const scoreDirection = determineScoreDirection(
    score,
    previousScore,
    config.noiseThreshold,
  );

  // 優先順位1: 最大試行回数到達時、品質OKならaccept、NGならreject
  if (attemptCount >= config.maxRefinementAttempts) {
    return {
      decision: isAcceptable ? 'accept' : 'reject',
      reason: '最大試行回数到達',
      attemptCount,
      suggestionReplanCount,
      currentScore: score,
      previousScore,
      scoreDirection,
    };
  }

  // 優先順位2: スコア取得失敗時、品質OKならaccept、NGならreject
  if (score === undefined) {
    return {
      decision: isAcceptable ? 'accept' : 'reject',
      reason: 'スコア取得失敗',
      attemptCount,
      suggestionReplanCount,
      previousScore,
      scoreDirection,
    };
  }

  // 優先順位3: 改善停滞時（スコア履歴がある場合のみ）
  // 重要: 初回評価（previousScore === undefined）ではスキップ
  const hasScoreHistory = previousScore !== undefined;

  if (hasScoreHistory) {
    const isStagnatedResult = isStagnated(score, previousScore, config);
    const isNoise = !isScoreChangeSignificant(score, previousScore, config.noiseThreshold);

    if (isStagnatedResult || isNoise) {
      return {
        decision: isAcceptable ? 'accept' : 'reject',
        reason: isNoise ? '改善停滞（ノイズ範囲内）' : '改善停滞',
        attemptCount,
        suggestionReplanCount,
        currentScore: score,
        previousScore,
        scoreDirection,
      };
    }
  }

  // 優先順位4: 品質未達ならreplan
  if (!isAcceptable) {
    return {
      decision: 'replan',
      reason: '品質未達',
      feedback: {
        issues,
        suggestions,
      },
      attemptCount,
      suggestionReplanCount,
      currentScore: score,
      previousScore,
      scoreDirection,
    };
  }

  // 優先順位5: 品質OK+suggestions+設定有効+上限未達ならreplan
  if (
    isAcceptable &&
    suggestions.length > 0 &&
    config.refineSuggestionsOnSuccess &&
    suggestionReplanCount < config.maxSuggestionReplans
  ) {
    return {
      decision: 'replan',
      reason: 'suggestions適用',
      feedback: {
        issues: [],
        suggestions,
      },
      attemptCount,
      suggestionReplanCount,
      currentScore: score,
      previousScore,
      scoreDirection,
    };
  }

  // 優先順位6: 品質OKならaccept
  return {
    decision: 'accept',
    reason: '品質OK',
    attemptCount,
    suggestionReplanCount,
    currentScore: score,
    previousScore,
    scoreDirection,
  };
}
```

### 4. 設定スキーマの変更

**注意**: 後方互換性のため `required` には追加しない（`default` のみ）。

```json
// .agent/config-schema.json の refinement セクション

"refinement": {
  "default": {
    "maxRefinementAttempts": 2,
    "refineSuggestionsOnSuccess": false,
    "maxSuggestionReplans": 1,
    "enableIndividualFallback": true,
    "deltaThreshold": 5,
    "deltaThresholdPercent": 5,
    "taskCountChangeThreshold": 0.3,
    "taskCountChangeMinAbsolute": 2,
    "noiseThreshold": 3
  },
  "properties": {
    // 既存プロパティ...

    "noiseThreshold": {
      "default": 3,
      "type": "number",
      "minimum": 1,
      "maximum": 10,
      "description": "この値未満のスコア差はノイズとして扱い、実質同等とみなす"
    }
  },
  "required": [
    "maxRefinementAttempts",
    "refineSuggestionsOnSuccess",
    "maxSuggestionReplans",
    "enableIndividualFallback",
    "deltaThreshold",
    "deltaThresholdPercent",
    "taskCountChangeThreshold",
    "taskCountChangeMinAbsolute"
    // noiseThreshold は required に含めない（後方互換性のため）
  ]
}
```

### 5. Zodスキーマの変更

**実際の設定スキーマは `src/types/config.ts` にある**（ADR当初の記載は誤り）。

```typescript
// src/types/config.ts:191-219

const RefinementConfigSchema = z
  .object({
    /** 最大Refinement試行回数 */
    maxRefinementAttempts: z.number().int().min(0).max(10).default(2),
    /** 成功時も改善提案を適用するか */
    refineSuggestionsOnSuccess: z.boolean().default(false),
    /** 提案ベースの再計画最大回数 */
    maxSuggestionReplans: z.number().int().min(0).max(5).default(1),
    /** 個別タスク評価フォールバックを有効化 */
    enableIndividualFallback: z.boolean().default(true),
    /** スコア改善の最小絶対値閾値 */
    deltaThreshold: z.number().min(0).max(50).default(5),
    /** スコア改善の最小パーセント閾値 */
    deltaThresholdPercent: z.number().min(0).max(100).default(5),
    /** タスク数変化の許容割合 */
    taskCountChangeThreshold: z.number().min(0).max(1).default(0.3),
    /** タスク数変化の最小絶対値 */
    taskCountChangeMinAbsolute: z.number().int().min(0).max(10).default(2),
    // 新規: ノイズ判定閾値
    /** この値未満のスコア差はノイズとして扱う */
    noiseThreshold: z.number().min(1).max(10).default(3),
  })
  .default({
    maxRefinementAttempts: 2,
    refineSuggestionsOnSuccess: false,
    maxSuggestionReplans: 1,
    enableIndividualFallback: true,
    deltaThreshold: 5,
    deltaThresholdPercent: 5,
    taskCountChangeThreshold: 0.3,
    taskCountChangeMinAbsolute: 2,
    noiseThreshold: 3,  // 新規
  });
```

### 6. 設定バリデーション（オプション）

`noiseThreshold < deltaThreshold` のランタイム検証を追加する場合：

```typescript
// src/types/config.ts

const RefinementConfigSchema = z
  .object({
    // ... 既存フィールド
  })
  .superRefine((val, ctx) => {
    if (val.noiseThreshold >= val.deltaThreshold) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'noiseThreshold must be less than deltaThreshold',
        path: ['noiseThreshold'],
      });
    }
  });
```

## 設定項目

| 設定 | デフォルト | 範囲 | 説明 |
|------|-----------|------|------|
| `noiseThreshold` | 3 | 1-10 | この値未満のスコア差は「ノイズ」として扱う |

**設定ガイドライン**:
- `noiseThreshold` < `deltaThreshold` を維持すること
- LLMの評価変動が大きい場合は4-5に上げる
- 厳密な判定が必要な場合は2に下げる

## 影響範囲

### 変更対象ファイル

| ファイル | 変更内容 |
|----------|----------|
| `src/types/planner-session.ts` | `ScoreDirection` 型追加、`RefinementResult` に `scoreDirection` 追加、Zodスキーマに `scoreDirection` 追加 |
| `src/types/config.ts` | `RefinementConfigSchema` に `noiseThreshold` 追加 |
| `src/core/orchestrator/planner-operations.ts` | `isScoreChangeSignificant()` 追加、`determineScoreDirection()` 追加、`makeRefinementDecision()` 修正 |
| `.agent/config-schema.json` | `noiseThreshold` 設定追加（`required` には追加しない） |
| `tests/unit/core/orchestrator/noise-tolerance.test.ts` | 新規テストファイル |
| `tests/unit/core/orchestrator/planner-operations.test.ts` | 既存テストに `noiseThreshold` 追加 |
| `tests/unit/core/orchestrator/validate-structure.test.ts` | 既存テストに `noiseThreshold` 追加 |

### 後方互換性

- **設定ファイル**: `noiseThreshold` が存在しない場合はデフォルト値（3）で動作
- **`RefinementResult.scoreDirection`**: オプショナル（既存コードに影響なし）
- **既存の停滞判定ロジック**: 維持（ノイズ判定は追加の条件）
- **`refinementHistory`**: 古いデータは `scoreDirection` がないが、Zodスキーマでオプショナルなので問題なし

## 利点

1. **誤判定の低減**: LLMスコアの自然な変動による誤った意思決定を防止
2. **低コスト**: 追加のLLM呼び出しなし、単純な数値比較のみ
3. **既存ロジックとの親和性**: 停滞判定ロジックに自然に統合可能
4. **透明性向上**: `scoreDirection` により変動の方向を履歴に記録
5. **分析可能性**: `'unknown'` により初回評価とノイズ安定を区別可能

## 制約・考慮事項

| リスク | 対策 |
|--------|------|
| 閾値が大きすぎると実際の改善/劣化を見逃す | デフォルト3、最大5程度を推奨 |
| 閾値が小さすぎるとノイズ対策にならない | 最小2以上を推奨 |
| `noiseThreshold` ≥ `deltaThreshold` だと意味がない | 設定ガイドラインで明記、オプションでランタイム検証 |
| 低スコア帯での相対改善を見逃す | 絶対差のみで判定（意図的な設計） |

## テスト戦略

### 単体テスト

新規テストファイル: `tests/unit/core/orchestrator/noise-tolerance.test.ts`

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  isScoreChangeSignificant,
  determineScoreDirection,
  makeRefinementDecision,
} from '../../../../src/core/orchestrator/planner-operations.ts';
import type { RefinementConfig } from '../../../../src/types/planner-session.ts';

const defaultConfig: RefinementConfig = {
  maxRefinementAttempts: 2,
  refineSuggestionsOnSuccess: false,
  maxSuggestionReplans: 1,
  enableIndividualFallback: true,
  deltaThreshold: 5,
  deltaThresholdPercent: 5,
  taskCountChangeThreshold: 0.3,
  taskCountChangeMinAbsolute: 2,
  noiseThreshold: 3,
};

describe('isScoreChangeSignificant', () => {
  it('閾値以上の差は有意と判定', () => {
    assert.strictEqual(isScoreChangeSignificant(75, 70, 3), true);  // diff=5 >= 3
    assert.strictEqual(isScoreChangeSignificant(73, 70, 3), true);  // diff=3 >= 3
  });

  it('閾値未満の差はノイズ（有意でない）と判定', () => {
    assert.strictEqual(isScoreChangeSignificant(72, 70, 3), false); // diff=2 < 3
    assert.strictEqual(isScoreChangeSignificant(71, 70, 3), false); // diff=1 < 3
  });

  it('負の差も絶対値で判定', () => {
    assert.strictEqual(isScoreChangeSignificant(67, 70, 3), true);  // |diff|=3 >= 3
    assert.strictEqual(isScoreChangeSignificant(68, 70, 3), false); // |diff|=2 < 3
  });

  it('previousScoreがundefinedの場合はtrue（初回評価）', () => {
    // 初回評価ではノイズ判定をスキップするため、有意として扱う
    assert.strictEqual(isScoreChangeSignificant(70, undefined, 3), true);
    assert.strictEqual(isScoreChangeSignificant(undefined, undefined, 3), true);
  });

  it('currentScoreがundefinedの場合はtrue', () => {
    // スコア取得失敗時は有意として扱い、後続の判定に委ねる
    assert.strictEqual(isScoreChangeSignificant(undefined, 70, 3), true);
  });
});

describe('determineScoreDirection', () => {
  it('有意な改善はimproved', () => {
    assert.strictEqual(determineScoreDirection(75, 70, 3), 'improved');
    assert.strictEqual(determineScoreDirection(73, 70, 3), 'improved');
  });

  it('有意な劣化はdegraded', () => {
    assert.strictEqual(determineScoreDirection(66, 70, 3), 'degraded');
    assert.strictEqual(determineScoreDirection(67, 70, 3), 'degraded');
  });

  it('ノイズ範囲内はstable', () => {
    assert.strictEqual(determineScoreDirection(72, 70, 3), 'stable');
    assert.strictEqual(determineScoreDirection(68, 70, 3), 'stable');
    assert.strictEqual(determineScoreDirection(70, 70, 3), 'stable');
  });

  it('スコアがundefinedの場合はunknown', () => {
    // unknown によりノイズ安定と初回評価を区別可能
    assert.strictEqual(determineScoreDirection(undefined, 70, 3), 'unknown');
    assert.strictEqual(determineScoreDirection(70, undefined, 3), 'unknown');
    assert.strictEqual(determineScoreDirection(undefined, undefined, 3), 'unknown');
  });
});

describe('makeRefinementDecision with noiseThreshold', () => {
  it('初回評価（previousScore undefined）は通常フローで処理', () => {
    // 重要: 初回評価でノイズ判定が発動しないことを確認
    const result = makeRefinementDecision({
      isAcceptable: false,
      score: 55,
      previousScore: undefined,  // 初回評価
      issues: ['issue1'],
      suggestions: ['suggestion1'],
      attemptCount: 1,
      suggestionReplanCount: 0,
      config: defaultConfig,
    });

    // 初回評価で品質未達ならreplan（ノイズ判定をスキップ）
    assert.strictEqual(result.decision, 'replan');
    assert.strictEqual(result.reason, '品質未達');
    assert.strictEqual(result.scoreDirection, 'unknown');
  });

  it('初回評価で品質OKならaccept', () => {
    const result = makeRefinementDecision({
      isAcceptable: true,
      score: 70,
      previousScore: undefined,  // 初回評価
      issues: [],
      suggestions: [],
      attemptCount: 1,
      suggestionReplanCount: 0,
      config: defaultConfig,
    });

    assert.strictEqual(result.decision, 'accept');
    assert.strictEqual(result.reason, '品質OK');
    assert.strictEqual(result.scoreDirection, 'unknown');
  });

  it('ノイズ範囲内の変動は停滞として扱う', () => {
    const result = makeRefinementDecision({
      isAcceptable: true,
      score: 72,
      previousScore: 70,  // diff=2 < noiseThreshold(3)
      issues: [],
      suggestions: [],
      attemptCount: 1,
      suggestionReplanCount: 0,
      config: defaultConfig,
    });

    assert.strictEqual(result.decision, 'accept');
    assert.strictEqual(result.reason, '改善停滞（ノイズ範囲内）');
    assert.strictEqual(result.scoreDirection, 'stable');
  });

  it('有意な改善でも停滞判定される場合', () => {
    const result = makeRefinementDecision({
      isAcceptable: true,
      score: 73,
      previousScore: 70,  // diff=3 >= noiseThreshold(3), but < deltaThreshold(5)
      issues: [],
      suggestions: [],
      attemptCount: 1,
      suggestionReplanCount: 0,
      config: defaultConfig,
    });

    assert.strictEqual(result.decision, 'accept');
    assert.strictEqual(result.reason, '改善停滞');
    assert.strictEqual(result.scoreDirection, 'improved');
  });

  it('十分な改善で品質OKならaccept', () => {
    const result = makeRefinementDecision({
      isAcceptable: true,
      score: 80,
      previousScore: 70,  // diff=10 >= deltaThreshold(5)
      issues: [],
      suggestions: [],
      attemptCount: 1,
      suggestionReplanCount: 0,
      config: defaultConfig,
    });

    assert.strictEqual(result.decision, 'accept');
    assert.strictEqual(result.reason, '品質OK');
    assert.strictEqual(result.scoreDirection, 'improved');
  });

  it('十分な改善で品質NGならreplan', () => {
    const result = makeRefinementDecision({
      isAcceptable: false,
      score: 55,
      previousScore: 45,  // diff=10 >= deltaThreshold(5)
      issues: ['issue1'],
      suggestions: ['suggestion1'],
      attemptCount: 1,
      suggestionReplanCount: 0,
      config: defaultConfig,
    });

    assert.strictEqual(result.decision, 'replan');
    assert.strictEqual(result.reason, '品質未達');
    assert.strictEqual(result.scoreDirection, 'improved');
  });

  it('ノイズ範囲内かつ品質NGならreject', () => {
    const result = makeRefinementDecision({
      isAcceptable: false,
      score: 52,
      previousScore: 50,  // diff=2 < noiseThreshold(3)
      issues: ['issue1'],
      suggestions: [],
      attemptCount: 1,
      suggestionReplanCount: 0,
      config: defaultConfig,
    });

    assert.strictEqual(result.decision, 'reject');
    assert.strictEqual(result.reason, '改善停滞（ノイズ範囲内）');
    assert.strictEqual(result.scoreDirection, 'stable');
  });

  it('noiseThreshold = deltaThreshold の場合でも動作する', () => {
    const configWithEqualThresholds: RefinementConfig = {
      ...defaultConfig,
      noiseThreshold: 5,
      deltaThreshold: 5,
    };

    const result = makeRefinementDecision({
      isAcceptable: true,
      score: 73,
      previousScore: 70,  // diff=3 < noiseThreshold(5)
      issues: [],
      suggestions: [],
      attemptCount: 1,
      suggestionReplanCount: 0,
      config: configWithEqualThresholds,
    });

    // この設定は非推奨だが、クラッシュせず動作することを確認
    assert.strictEqual(result.decision, 'accept');
    assert.strictEqual(result.scoreDirection, 'stable');
  });

  it('previousScore = 0 の場合の相対改善計算', () => {
    const result = makeRefinementDecision({
      isAcceptable: false,
      score: 10,
      previousScore: 0,  // relativeImprovement = 0（0除算回避）
      issues: ['issue1'],
      suggestions: [],
      attemptCount: 1,
      suggestionReplanCount: 0,
      config: defaultConfig,
    });

    // diff=10 >= noiseThreshold(3) なので有意
    // improvement=10 >= deltaThreshold(5) なので停滞ではない
    assert.strictEqual(result.decision, 'replan');
    assert.strictEqual(result.reason, '品質未達');
    assert.strictEqual(result.scoreDirection, 'improved');
  });
});
```

### 既存テストへの影響

`tests/unit/core/orchestrator/planner-operations.test.ts` の `makeRefinementDecision` テストに `noiseThreshold` を追加:

```typescript
const defaultConfig: RefinementConfig = {
  // 既存...
  noiseThreshold: 3,  // 追加
};
```

`tests/unit/core/orchestrator/validate-structure.test.ts` の `defaultConfig` にも追加。

## ステータス

**実装準備完了**

---

## 実装チェックリスト

### 実装方針

- **各Phase完了後にコミット**を推奨（ロールバック容易性のため）
- **Phase 1a と Phase 2 は並列実行可能**
- 依存関係: `Phase 1a/2 → Phase 3 → Phase 4 → Phase 5 → Phase 6`

---

### Phase 1a: 型定義（planner-session.ts）

- [ ] `ScoreDirection` 型を追加（`'improved' | 'degraded' | 'stable' | 'unknown'`）
- [ ] **`RefinementConfig` に `noiseThreshold: number` を追加**（重要：欠落していた）
- [ ] `RefinementResult` に `scoreDirection?: ScoreDirection` を追加
- [ ] Zodスキーマ `refinementHistory` に `scoreDirection` を追加

**完了確認**: `pnpm typecheck` が型エラーを出すことを確認（`noiseThreshold` が設定スキーマにまだないため）

### Phase 2: 設定スキーマ（Phase 1aと並列実行可能）

- [ ] `src/types/config.ts`: `RefinementConfigSchema` に `noiseThreshold` を追加（`.default(3)`）
- [ ] `src/types/config.ts`: デフォルト値オブジェクトに `noiseThreshold: 3` を追加
- [ ] `.agent/config-schema.json`: `noiseThreshold` プロパティを追加
- [ ] `.agent/config-schema.json`: `required` には**追加しない**ことを確認

**完了確認**: `pnpm typecheck` 通過

---

### Phase 3: ヘルパー関数（Phase 1a, 2 完了後）

- [ ] `ScoreDirection` を `planner-session.ts` からインポート
- [ ] `isScoreChangeSignificant()` を追加・export
- [ ] `determineScoreDirection()` を追加・export

**完了確認**: `pnpm typecheck` 通過

---

### Phase 4: ロジック統合（Phase 3 完了後）

#### 4.1 `makeRefinementDecision()` の修正

- [ ] 関数冒頭で `scoreDirection` を計算（`determineScoreDirection()` 呼び出し）
- [ ] `hasScoreHistory` ガード条件を追加（`previousScore !== undefined`）
- [ ] ノイズ判定ロジックを停滞判定ブロックに統合
- [ ] `reason` の分岐を追加（`isNoise ? '改善停滞（ノイズ範囲内）' : '改善停滞'`）

#### 4.2 return文への `scoreDirection` 追加（6箇所）

- [ ] 優先順位1: 最大試行回数到達
- [ ] 優先順位2: スコア取得失敗
- [ ] 優先順位3: 改善停滞（ノイズ含む）
- [ ] 優先順位4: 品質未達
- [ ] 優先順位5: suggestions適用
- [ ] 優先順位6: 品質OK

**完了確認**: `pnpm typecheck` 通過

---

### Phase 5: テスト（Phase 4 完了後）

#### 5.1 新規テストファイル作成

- [ ] `tests/unit/core/orchestrator/noise-tolerance.test.ts` を新規作成
- [ ] ADRのテストコード（504-743行目）を基に実装

#### 5.2 既存テストの更新（並列実行可能）

- [ ] `planner-operations.test.ts`: `defaultConfig` に `noiseThreshold: 3` 追加
- [ ] `validate-structure.test.ts`: `defaultConfig` に `noiseThreshold: 3` 追加

#### 5.3 後方互換性テスト

- [ ] `noiseThreshold` 未定義の設定でデフォルト値（3）が適用されることを確認
- [ ] `scoreDirection` がない古い `refinementHistory` データが正しくパースされることを確認

#### 5.4 全テスト実行

- [ ] `pnpm test` で全テスト通過を確認

---

### Phase 6: 検証（Phase 5 完了後）

- [ ] `pnpm typecheck` 通過
- [ ] `pnpm lint` 通過
- [ ] `.agent/config-schema.json` の `required` 配列に `noiseThreshold` が**含まれていない**ことを確認

---

### Phase 7（オプション）: 設定バリデーション

- [ ] `src/types/config.ts`: `superRefine` で `noiseThreshold < deltaThreshold` 検証追加
- [ ] バリデーションエラーケースのテスト追加（`noiseThreshold >= deltaThreshold` で警告）

---

## 実装時の注意事項

### 依存関係マトリクス

```
Phase 1a ─┬─→ Phase 3 → Phase 4 → Phase 5 → Phase 6
Phase 2  ─┘
```

### 既存テスト破損リスクへの対策

`RefinementConfig` に必須フィールドを追加すると、既存テストの `defaultConfig` が不完全になり失敗します。

**対策**: Phase 2 の Zod スキーマで `.default(3)` を設定することで、明示的に指定されていなくてもデフォルト値が適用される。ただし、テストの `defaultConfig` は Phase 5.2 で更新が必要。

### ロールバック手順

各Phase完了後にコミットしておくことで、問題発生時に `git revert` で戻せる。

```bash
# Phase N で問題発生時
git revert HEAD~1  # 直前のPhaseを取り消し
```
