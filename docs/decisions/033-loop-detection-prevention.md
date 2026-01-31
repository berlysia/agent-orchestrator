# ADR-033: ループ検出と無限ループ防止

## Status

Implemented

## Context

マルチエージェントワークフローでは、以下の理由で無限ループが発生するリスクがある：

1. **Judge-Worker間の往復**: Judgeが`NEEDS_CONTINUATION`を出し続け、Workerが同じ問題を解決できない
2. **Replanning無限ループ**: Plannerが同じ計画を繰り返し生成
3. **レビュー-修正サイクル**: レビュアーが同じ問題を指摘し続け、修正が収束しない
4. **エスカレーション失敗**: Leaderのエスカレーションが解決につながらない

### 現状

- `max_iterations` による全体制限は存在するが、特定パターンの検出はない
- 同じステップの繰り返しは検出していない

## Decision

ワークフロー実行にループ検出機構を追加し、無限ループを防止する。

### 検出パターン

#### 1. 同一ステップ反復検出

```typescript
interface StepIterationTracker {
  stepName: string;
  count: number;
  maxAllowed: number;
}

// 同じステップが規定回数を超えて実行された場合に検出
function checkStepIteration(
  stepName: string,
  tracker: Map<string, StepIterationTracker>
): LoopDetectionResult;
```

**デフォルト設定**:
- Worker実行: 最大3回（同一タスクに対して）
- Judge評価: 最大3回
- Replan: 最大2回

#### 2. 応答類似度検出

同じステップが類似した出力を繰り返している場合を検出：

```typescript
interface SimilarityDetector {
  addResponse(stepName: string, response: string): void;
  checkSimilarity(stepName: string, response: string): {
    isSimilar: boolean;
    similarity: number;
    previousResponse?: string;
  };
}

// Jaccard類似度またはレーベンシュタイン距離で判定
function calculateSimilarity(a: string, b: string): number;
```

**デフォルト設定**:
- 類似度閾値: 0.8（80%以上類似で検出）
- 比較ウィンドウ: 直近3回の応答

#### 3. 状態遷移パターン検出

同じ状態遷移パターンの繰り返しを検出：

```typescript
type StateTransition = {
  from: string;  // step name
  to: string;    // step name
  reason: string; // transition reason
};

interface TransitionPatternDetector {
  addTransition(transition: StateTransition): void;
  checkPattern(): {
    isLoop: boolean;
    pattern?: StateTransition[];
    occurrences: number;
  };
}

// 例: plan → implement → review → plan → implement → review（2回繰り返し）
```

### ループ検出結果

```typescript
type LoopDetectionResult =
  | { type: 'ok' }
  | { type: 'step_iteration_exceeded'; stepName: string; count: number; max: number }
  | { type: 'similar_response'; stepName: string; similarity: number; threshold: number }
  | { type: 'transition_pattern'; pattern: StateTransition[]; occurrences: number };
```

### ループ検出時のアクション

```typescript
interface LoopHandler {
  onLoopDetected(result: LoopDetectionResult): LoopAction;
}

type LoopAction =
  | { type: 'abort'; reason: string }
  | { type: 'escalate'; target: 'user' | 'planner' | 'leader' }
  | { type: 'force_continue'; warning: string }
  | { type: 'retry_with_hint'; hint: string };
```

**デフォルトアクション**:

| 検出タイプ | アクション |
|-----------|-----------|
| `step_iteration_exceeded` | ユーザーへエスカレート |
| `similar_response` | ヒント付きリトライ（1回）→ エスカレート |
| `transition_pattern` | Plannerへ再計画要求 → 失敗時はユーザーへ |

### ワークフロー設定

```typescript
interface LoopDetectionConfig {
  enabled: boolean;
  maxStepIterations: {
    default: number;
    worker: number;
    judge: number;
    replan: number;
  };
  similarityDetection: {
    enabled: boolean;
    threshold: number;
    windowSize: number;
  };
  transitionPatternDetection: {
    enabled: boolean;
    minOccurrences: number;
  };
  onLoop: {
    default: LoopAction;
    [stepName: string]: LoopAction;
  };
}
```

**デフォルト設定**:

```typescript
const defaultLoopConfig: LoopDetectionConfig = {
  enabled: true,
  maxStepIterations: {
    default: 5,
    worker: 3,
    judge: 3,
    replan: 2,
  },
  similarityDetection: {
    enabled: true,
    threshold: 0.8,
    windowSize: 3,
  },
  transitionPatternDetection: {
    enabled: true,
    minOccurrences: 2,
  },
  onLoop: {
    default: { type: 'escalate', target: 'user' },
  },
};
```

### 全体イテレーション制限との関係

```
┌─────────────────────────────────────────────────────┐
│ max_iterations (全体制限)                            │
│   ┌───────────────────────────────────────────────┐ │
│   │ ループ検出 (パターンベース)                      │ │
│   │   - step_iteration_exceeded                   │ │
│   │   - similar_response                          │ │
│   │   - transition_pattern                        │ │
│   └───────────────────────────────────────────────┘ │
│                                                     │
│ ループ検出: 早期に問題を検出し、適切なアクションを取る │
│ max_iterations: 最終的な安全弁（これを超えたら強制終了）│
└─────────────────────────────────────────────────────┘
```

### Leaderパターンとの統合

ADR-023/024のLeaderパターンでは、ループ検出はLeaderの判断材料となる：

```typescript
// Leader判断時にループ情報を提供
interface LeaderContext {
  loopDetection: {
    currentResult: LoopDetectionResult;
    history: LoopDetectionResult[];
    suggestion: LoopAction;
  };
}

// Leaderはループ検出結果を考慮して判断
// 例: similar_response検出時に異なるアプローチを指示
```

## Consequences

### Positive

- 無限ループによるリソース浪費を防止
- 問題の早期検出と適切なエスカレーション
- ユーザー体験の向上（長時間待機の回避）
- デバッグ情報の提供（どのパターンでループしたか）

### Negative

- 検出ロジックの複雑性
- 類似度計算のオーバーヘッド
- 偽陽性による早期終了リスク

### Neutral

- 既存のmax_iterationsは維持（最終安全弁）
- 設定可能なため、プロジェクトごとに調整可能

## Implementation

### Phase 1: 基本検出
1. `LoopDetector` クラス実装
2. step_iteration_exceeded 検出
3. Orchestratorへの統合

### Phase 2: 高度な検出
1. 類似度検出（Jaccard）
2. 状態遷移パターン検出

### Phase 3: アクション
1. エスカレーションロジック
2. ヒント付きリトライ
3. Leader統合

## References

- [ADR-009: Judge Replanning Strategy](./009-judge-replanning-strategy.md)
- [ADR-023: Agent Swarm Team Development](./023-agent-swarm-team-development.md)
- [ADR-024: Worker Feedback & Dynamic Task Generation](./024-worker-feedback-dynamic-task-generation.md)
