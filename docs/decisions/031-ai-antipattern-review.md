# ADR-031: AI Antipattern Review（AI生成コード品質ゲート）

## Status

Implemented

## Context

AI（LLM）によるコード生成は高速だが、人間のレビュー速度を超える量のコードを生成する。AIが生成するコードには、人間が書くコードとは異なる特有のアンチパターンが存在する：

1. **Plausible-but-Wrong**: 構文的に正しいが意味的に間違っているコード
2. **Hallucinated APIs**: 存在しないAPIやメソッドの呼び出し
3. **Over-engineering**: 要求以上の抽象化や機能追加
4. **Fallback乱用**: 不確実性を隠すためのデフォルト値やtry-catch
5. **不要な後方互換性コード**: 「将来のため」に残された未使用コード

## Decision

Judge評価に「AI Antipattern Review」の観点を追加し、AI生成コード特有の問題を検出する品質ゲートを設ける。

### 検出対象パターン

#### 1. 仮定の妥当性検証（Assumption Validation）

| チェック項目 | 質問 |
|-------------|------|
| 要件理解 | 実装は実際に要求されたものと一致しているか？ |
| コンテキスト | 既存コードベースの慣習に従っているか？ |
| ドメイン | ビジネスルールを正しく理解しているか？ |
| エッジケース | 現実的なエッジケースを考慮しているか？ |

**レッドフラグ**:
- 別の質問に答えているような実装
- コードベースの他の場所にないパターンの使用
- 特定の問題に対して過度に汎用的な解決策

#### 2. Plausible-but-Wrong検出

| パターン | 例 |
|---------|-----|
| 構文的に正しいが意味的に誤り | フォーマットはチェックするがビジネスルールを見落とすバリデーション |
| Hallucinated API | 使用中のライブラリバージョンに存在しないメソッド呼び出し |
| 古いパターン | トレーニングデータ由来の非推奨アプローチ |
| Over-engineering | タスクに不要な抽象化レイヤー追加 |
| Under-engineering | 現実的なシナリオのエラーハンドリング欠落 |

#### 3. フォールバック禁止ルール（REJECT基準）

**AIは不確実性を隠すためにフォールバックを多用する。これはデフォルトでREJECT。**

| パターン | 例 | 判定 |
|---------|-----|------|
| デフォルト値で握りつぶし | `?? 'unknown'`, `|| 'default'`, `?? []` | **REJECT** |
| 空を返すtry-catch | `catch { return ''; }` | **REJECT** |
| 条件分岐でサイレントスキップ | `if (!x) return;`（エラーにすべき箇所） | **REJECT** |
| 多段フォールバックチェーン | `a ?? b ?? c ?? d` | **REJECT** |

**例外（REJECTしない）**:
- 外部入力（ユーザー入力、API応答）のバリデーション時のデフォルト値
- 理由を説明する明示的なコメント付きのフォールバック
- 設定ファイルのオプション値のデフォルト

#### 4. 未使用コード検出

**AIは「将来の拡張性」「対称性」「念のため」で不要なコードを生成しがち。**

| 判定 | 基準 |
|------|------|
| **REJECT** | どこからも呼ばれていないpublic関数/メソッド |
| **REJECT** | 「対称性のため」に作られたが使われていないsetter/getter |
| **REJECT** | 将来の拡張用に準備されたインターフェースやオプション |
| **REJECT** | exportされているがgrepで使用箇所がない |
| OK | フレームワークが暗黙的に呼び出す（ライフサイクルフック等） |
| OK | 公開パッケージAPIとして意図的に公開 |

#### 5. 不要な後方互換性コード検出

| パターン | 例 | 判定 |
|---------|-----|------|
| deprecated + 未使用 | `@deprecated`アノテーション付きで呼び出し元なし | **即削除** |
| 新旧API並存 | 新関数があるのに旧関数が残存 | **旧を削除** |
| マイグレーション済みラッパー | 互換性のために作成されたがマイグレーション完了 | **削除** |
| 「後で削除」コメント | `// TODO: remove after migration`が放置 | **今削除** |

#### 6. スコープクリープ検出

| チェック | 問題 |
|---------|------|
| 追加機能 | 要求されていない機能 |
| 早すぎる抽象化 | 単一実装に対するインターフェース/抽象化 |
| 過剰な設定化 | 必要のない設定可能化 |
| ゴールドプレーティング | 要求されていない「あると便利」な追加 |

### 実装方式

#### Option A: Judge拡張（推奨）

既存のJudge評価にAI Antipattern観点を追加：

```typescript
interface JudgeEvaluation {
  verdict: 'done' | 'needs_continuation' | 'blocked';
  // 既存フィールド...

  // AI Antipattern Review
  aiAntipatterns?: {
    fallbackViolations: FallbackViolation[];
    unusedCode: UnusedCodeIssue[];
    scopeCreep: ScopeCreepIssue[];
    plausibleButWrong: PlausibleButWrongIssue[];
  };
}
```

#### Option B: 独立エージェント

独立したAI Antipattern Reviewerエージェントを追加：

```
Worker実行 → AI Antipattern Review → Architecture Review → Judge
```

### Boy Scoutルール

**「機能的に無害」は免罪符にならない。**

| 状況 | 判定 |
|------|------|
| 冗長な式（より短い等価形式が存在） | **REJECT** |
| 不要な分岐/条件（到達不能または常に同じ結果） | **REJECT** |
| 数秒〜数分で修正可能 | **REJECT**（non-blockingに分類しない） |
| 大規模なリファクタリングが必要 | 記録のみ（技術的負債） |

## Consequences

### Positive

- AI生成コード特有の品質問題を早期検出
- フォールバック乱用による隠れたバグを防止
- コードベースの肥大化を防止（不要コード排除）
- 技術的負債の蓄積を抑制

### Negative

- Judge評価の複雑性増加
- 偽陽性によるREJECT増加の可能性
- ルールの調整・チューニングが必要

### Neutral

- 既存のJudge機能と統合可能
- 段階的に検出ルールを追加可能

## Implementation

### 実装済みファイル

| ファイル | 役割 |
|---------|------|
| `src/types/ai-antipattern.ts` | 型定義（FallbackViolation, UnusedCodeIssue等） |
| `src/core/orchestrator/ai-antipattern-reviewer.ts` | AIAntipatternReviewer実装 |
| `src/core/orchestrator/judge-ai-antipattern-integration.ts` | Judge統合ヘルパー |
| `tests/unit/ai-antipattern-reviewer.test.ts` | ユニットテスト |

### 実装API

```typescript
// レビュアー作成
const reviewer = createAIAntipatternReviewer(config?: Partial<AIAntipatternConfig>);

// コードレビュー実行
const result = await reviewer.review(files, taskDescription);
// AIAntipatternReviewResult {
//   score: number;           // 0-100
//   shouldReject: boolean;   // rejectThreshold以下でtrue
//   fallbackViolations: FallbackViolation[];
//   unusedCodeIssues: UnusedCodeIssue[];
//   scopeCreepIssues: ScopeCreepIssue[];
// }

// Judge統合（worktree変更レビュー）
import { reviewWorktreeChanges, shouldAffectJudgement } from './judge-ai-antipattern-integration';

const reviewResult = await reviewWorktreeChanges(worktreePath, task, config);
if (shouldAffectJudgement(reviewResult)) {
  // REJECTまたは警告フィードバック生成
}
```

### 検出パターン

| パターン | 実装状態 |
|---------|---------|
| Nullish coalescing (`?? 'unknown'`) | ✅ 実装済み |
| 空catch (`catch { }`) | ✅ 実装済み |
| 多段フォールバック (`a ?? b ?? c`) | ✅ 実装済み |
| スコープクリープ | ✅ 基本実装 |
| 未使用コード | ⏳ 未実装（Phase 2） |

### 設定例

```yaml
# .agent/config.yaml
aiAntipattern:
  enabled: true
  rejectThreshold: 60
  fallbackDetection:
    enabled: true
    exceptions:
      - "*.config.ts"
      - "*.config.js"
  scopeCreepDetection:
    enabled: true
```

### Phase 1: 基本検出 ✅
1. フォールバック禁止ルールの実装
2. Judge評価への統合ヘルパー

### Phase 2: 高度な検出

#### 未使用コード検出の実装手段

| 手法 | ツール | 対象 | 精度 |
|------|--------|------|------|
| 静的解析 | `knip` | exports, dependencies | 高 |
| 静的解析 | `ts-prune` | TypeScript exports | 高 |
| パターンマッチ | `grep`/正規表現 | 関数呼び出し | 中 |
| AST解析 | TypeScript Compiler API | 参照関係 | 高 |

**推奨アプローチ**:

```typescript
interface UnusedCodeDetector {
  // 静的解析ツール連携
  runKnip(projectDir: string): Promise<UnusedExport[]>;

  // grep/正規表現ベース（軽量）
  grepUnusedExports(files: string[]): Promise<UnusedExport[]>;

  // フレームワーク固有の例外ルール
  isFrameworkHook(symbol: string): boolean;
}

// 例外ルール（検出から除外）
const FRAMEWORK_EXCEPTIONS = [
  // React
  /^use[A-Z]/,           // Hooks
  /^on[A-Z]/,            // Event handlers
  // Node.js
  /^(setup|teardown)$/,  // Test lifecycle
  // Express
  /^(get|post|put|delete|patch)$/,
];
```

**検出フロー**:
```
1. 変更されたファイルを特定
2. 新規追加されたexportを抽出
3. grep/静的解析でプロジェクト全体を検索
4. フレームワーク例外をフィルタリング
5. 使用箇所がないものをREJECT候補に
```

#### スコープクリープ検出

タスクの元の要件と実装の差分を検出：

```typescript
interface ScopeCreepDetector {
  // タスク要件から期待される変更を推定
  estimateExpectedScope(task: Task): ExpectedScope;

  // 実際の変更と比較
  compareWithActual(
    expected: ExpectedScope,
    actual: ActualChanges
  ): ScopeCreepReport;
}

interface ScopeCreepReport {
  unexpectedFiles: string[];      // 予期しないファイルの変更
  unexpectedFeatures: string[];   // 予期しない機能の追加
  overEngineering: string[];      // 過剰な抽象化
}
```

### Phase 3: 学習・調整
1. 偽陽性/偽陰性の分析
2. プロジェクト固有ルールのカスタマイズ

### 設定

```yaml
# .agent/config.yaml
aiAntipatternReview:
  enabled: true

  fallbackDetection:
    enabled: true
    exceptions:
      - "*.config.ts"  # 設定ファイルは除外

  unusedCodeDetection:
    enabled: true
    tool: knip  # knip | ts-prune | grep
    frameworkExceptions:
      - react
      - express

  scopeCreepDetection:
    enabled: true
    tolerance: 0.2  # 20%までのスコープ超過を許容
```

## References

- [ADR-009: Judge Replanning Strategy](./009-judge-replanning-strategy.md)
