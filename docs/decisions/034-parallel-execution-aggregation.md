# ADR-034: 並列Worker実行とアグリゲーション評価

## Status

Proposed

## Context

ADR-023（Agent Swarm Team Development）で複数Workerの並列実行を採用したが、以下が未定義：

1. **並列度の制御方法**: 同時に実行するWorker数の上限
2. **Worker結果の集約方法**: 全成功が必要？部分成功で可？
3. **失敗時のリトライ戦略**: 1つ失敗した場合の継続/中断判断

### 要件

- 複数タスクを並列実行してスループット向上
- Worker間の独立性を維持しつつ、結果を適切に集約
- 失敗時の柔軟な対応（全停止 vs. 継続）

## Decision

並列実行の制御とアグリゲーション評価の仕組みを導入する。

### 並列度制御

```typescript
interface ParallelConfig {
  maxConcurrency: number;  // 同時実行Worker数（デフォルト: 3）
  queueStrategy: 'fifo' | 'priority';  // キュー戦略
}
```

**デフォルト設定**:
- `maxConcurrency`: 3（CPUコア数やAPIレート制限を考慮）
- `queueStrategy`: 'fifo'（先入先出）

### アグリゲーション評価

複数Workerの結果を集約して次のアクションを決定する。

```typescript
type AggregationStrategy =
  | { type: 'all'; condition: string }   // すべてが条件を満たす
  | { type: 'any'; condition: string }   // 少なくとも1つが条件を満たす
  | { type: 'majority'; condition: string }  // 過半数が条件を満たす
  | { type: 'custom'; evaluator: AggregationEvaluator };

interface AggregationResult {
  strategy: AggregationStrategy;
  matched: boolean;
  details: {
    total: number;
    succeeded: number;
    failed: number;
    conditions: Map<string, number>;  // 条件ごとのマッチ数
  };
}
```

### 評価パターン

#### `all(condition)`: すべて成功

```typescript
// すべてのWorkerがテストに成功した場合のみ次へ
const allTestsPassed = evaluateAggregation(results, {
  type: 'all',
  condition: 'tests_passed'
});
```

**使用場面**:
- 統合フェーズ前の品質ゲート
- 全タスク完了の確認

#### `any(condition)`: 少なくとも1つ成功

```typescript
// 少なくとも1つのWorkerが助けを求めている場合
const needsHelp = evaluateAggregation(results, {
  type: 'any',
  condition: 'needs_help'
});
```

**使用場面**:
- エスカレーション判断
- 問題検出

#### `majority(condition)`: 過半数成功

```typescript
// 過半数のWorkerがレビュー承認した場合
const majorityApproved = evaluateAggregation(results, {
  type: 'majority',
  condition: 'approved'
});
```

**使用場面**:
- 投票ベースの判断（MAGIスタイル）
- コンセンサス形成

### Leaderとの統合

ADR-023/024のLeaderパターンでは、アグリゲーション結果をLeaderの判断材料として使用：

```typescript
interface LeaderContext {
  aggregation: {
    results: WorkerResult[];
    evaluation: AggregationResult;
    recommendation: LeaderAction;
  };
}

// Leader判断時
function determineNextAction(ctx: LeaderContext): LeaderAction {
  const { evaluation } = ctx.aggregation;

  if (evaluation.strategy.type === 'all' && !evaluation.matched) {
    // 全成功が必要だが失敗がある → リトライまたはエスカレート
    return { type: 'retry', targets: getFailedTasks(ctx) };
  }

  if (evaluation.strategy.type === 'any' && evaluation.matched) {
    // 問題検出 → エスカレート
    return { type: 'escalate', reason: 'Worker reported issue' };
  }

  return { type: 'continue' };
}
```

### 失敗時の戦略

```typescript
interface FailureStrategy {
  onSingleFailure: 'continue' | 'pause' | 'abort';
  onMajorityFailure: 'continue' | 'abort';
  maxRetries: number;
  retryDelay: number;  // ms
}

const defaultFailureStrategy: FailureStrategy = {
  onSingleFailure: 'continue',  // 1つ失敗しても継続
  onMajorityFailure: 'abort',   // 過半数失敗なら中断
  maxRetries: 2,
  retryDelay: 1000,
};
```

### 設定

```yaml
# .agent/config.yaml
execution:
  parallel:
    maxConcurrency: 3
    queueStrategy: fifo
  aggregation:
    default: all("done")
  failure:
    onSingleFailure: continue
    onMajorityFailure: abort
    maxRetries: 2
```

## Consequences

### Positive

- **スループット向上**: 並列実行により処理時間短縮
- **柔軟な判断**: `all`/`any`/`majority`で多様な判断パターンに対応
- **障害耐性**: 部分的失敗時も継続可能

### Negative

- 並列実行によるリソース消費増加
- アグリゲーションロジックの複雑性
- デバッグの困難さ（並列実行のタイミング依存）

### Neutral

- 既存の逐次実行モードは維持（`maxConcurrency: 1`で実現）

## Implementation

### Phase 1: 基本並列実行
1. `ParallelExecutor` クラス実装
2. 並列度制御（セマフォ）
3. 結果収集

### Phase 2: アグリゲーション
1. `AggregationEvaluator` 実装
2. `all`/`any`/`majority` 評価
3. Leader統合

### Phase 3: 失敗戦略
1. リトライロジック
2. 部分失敗時の継続判断

## References

- [ADR-023: Agent Swarm Team Development](./023-agent-swarm-team-development.md)
- [ADR-024: Worker Feedback & Dynamic Task Generation](./024-worker-feedback-dynamic-task-generation.md)
- [ADR-033: ループ検出と無限ループ防止](./033-loop-detection-prevention.md)
