# ADR-022: Learning機能 - 失敗パターンの学習と改善提案

## ステータス

**Accepted** ✅

## 提案日時

2026-01-27

## 背景

Worker実行時に同じエラーが繰り返し発生するケースがある。現状では：

- **過去の失敗が活かされない**: 同じタイプエラーで何度も失敗しても、Workerは過去の失敗を知らない
- **改善提案がない**: 類似するエラーで過去に成功した修正方法があっても、それが共有されない
- **デバッグ時間の増加**: 同じエラーパターンを毎回調査・修正する必要がある

これにより、特に以下のような反復可能なエラーで効率が悪化している：

- TypeScriptの型エラー（import漏れ、型定義不足）
- ビルドエラー（設定ミス、依存関係の問題）
- テスト失敗（特定パターンのアサーション失敗）

## 決定

Worker実行時の失敗パターンを記録・学習し、類似エラー発生時に過去の成功例を提案する機能を実装する。

### 設計方針

- **Phase 1**: Judge拡張として実装
- **将来**: 独立したLearning Moduleに分離可能
- インターフェースを先に定義し、依存注入で切り替え可能に
- **学習機能の失敗はWorker実行をブロックしない**（best-effort）

### 1. アーキテクチャ

#### Phase 1: Judge拡張として実装

```
[Worker実行前] dynamic-scheduler.ts executeTaskAsync()
  └─ findSimilarFailures() → suggestImprovement() → プロンプト強化

[Judge判定後] dynamic-scheduler.ts
  ├─ 失敗時: recordFailure() → パターン記録、patternIdをTask.pendingPatternIdに保存
  └─ 成功時（pendingPatternIdあり）: recordResolution() → 有効な修正を学習
```

#### 将来: 独立Learning Module

インターフェースを先に定義し、依存注入で切り替え可能にすることで、将来的に独立したLearning Moduleへ分離可能。

### 2. ストレージ構造

```
agent-coord/
  learnings/
    patterns/{patternId}.json  # 失敗パターン
    index.json                 # カテゴリ別インデックス（検索高速化）
```

#### パターンファイル構造

```json
{
  "patternId": "pattern-uuid",
  "errorCategory": "TYPE_ERROR",
  "normalizedError": "error TS<NUM>: Cannot find module '<VAR>'",
  "keywords": ["TS2307", "Cannot find module"],
  "occurrences": [
    {
      "taskId": "task-001",
      "runId": "run-001",
      "errorMessage": "error TS2307: Cannot find module '@/types'",
      "relatedFiles": ["src/index.ts"],
      "command": "pnpm typecheck",
      "exitCode": 1,
      "occurredAt": "2026-01-27T10:30:00Z"
    }
  ],
  "successfulFixes": [
    {
      "taskId": "task-002",
      "runId": "run-002",
      "fixDescription": "Added missing type definition file",
      "resolvedAt": "2026-01-27T11:00:00Z"
    }
  ],
  "createdAt": "2026-01-27T10:30:00Z",
  "updatedAt": "2026-01-27T11:00:00Z"
}
```

#### インデックスファイル構造

```json
{
  "categories": {
    "TYPE_ERROR": ["pattern-uuid-1", "pattern-uuid-2"],
    "TEST_FAILURE": ["pattern-uuid-3"],
    "BUILD_ERROR": ["pattern-uuid-4", "pattern-uuid-5"]
  },
  "updatedAt": "2026-01-27T11:00:00Z"
}
```

### 3. 主要インターフェース

```typescript
/**
 * Learning機能のインターフェース
 *
 * WHY: Judge拡張として実装するが、将来的に独立モジュールへ分離可能にする
 */
interface LearningCapability {
  /**
   * 失敗パターンを記録
   *
   * @param failure 失敗情報
   * @returns パターンID（既存パターンに追加した場合は既存ID）
   */
  recordFailure(failure: FailureInfo): Promise<Result<PatternId, LearningError>>;

  /**
   * 類似する過去の失敗パターンを検索
   *
   * @param failure 現在の失敗情報
   * @returns 類似パターン配列（類似度降順）
   */
  findSimilarFailures(failure: FailureInfo): Promise<Result<FailurePattern[], LearningError>>;

  /**
   * パターンに基づいて改善提案を生成
   *
   * @param pattern 過去の失敗パターン
   * @param current 現在の失敗情報
   * @returns プロンプトに追加する改善提案テキスト
   */
  suggestImprovement(pattern: FailurePattern, current: FailureInfo): Promise<Result<string, LearningError>>;

  /**
   * パターンの解決を記録（成功時）
   *
   * @param patternId パターンID
   * @param taskId 成功したタスクID
   * @param fix 修正内容の説明
   */
  recordResolution(patternId: PatternId, taskId: TaskId, fix: string): Promise<Result<void, LearningError>>;
}

/**
 * 失敗情報
 */
interface FailureInfo {
  /** タスクID */
  taskId: TaskId;
  /** 実行ID */
  runId: RunId;
  /** エラーカテゴリ */
  errorCategory: ErrorCategory;
  /** エラーメッセージ（正規化前） */
  errorMessage: string;
  /** 関連ファイルパス配列 */
  relatedFiles: string[];
  /** 実行コマンド（オプショナル） */
  command?: string;
  /** 終了コード（オプショナル） */
  exitCode?: number;
  /** 発生日時 */
  occurredAt: string;
}

/**
 * エラーカテゴリ
 *
 * WHY: カテゴリでフィルタリングすることで検索範囲を限定し、パフォーマンスを向上
 */
type ErrorCategory =
  | 'TYPE_ERROR'        // TypeScriptコンパイルエラー
  | 'TEST_FAILURE'      // テスト失敗
  | 'BUILD_ERROR'       // ビルドエラー
  | 'LINT_ERROR'        // Lintエラー
  | 'RUNTIME_ERROR'     // 実行時エラー
  | 'UNKNOWN';          // 未分類

/**
 * 失敗パターン
 */
interface FailurePattern {
  /** パターンID */
  patternId: PatternId;
  /** エラーカテゴリ */
  errorCategory: ErrorCategory;
  /** 正規化されたエラーメッセージ */
  normalizedError: string;
  /** 抽出されたキーワード */
  keywords: string[];
  /** 発生記録 */
  occurrences: FailureOccurrence[];
  /** 成功した修正記録 */
  successfulFixes: SuccessfulFix[];
  /** 作成日時 */
  createdAt: string;
  /** 更新日時 */
  updatedAt: string;
}

/**
 * 失敗発生記録
 */
interface FailureOccurrence {
  taskId: TaskId;
  runId: RunId;
  errorMessage: string;
  relatedFiles: string[];
  command?: string;
  exitCode?: number;
  occurredAt: string;
}

/**
 * 成功した修正記録
 */
interface SuccessfulFix {
  taskId: TaskId;
  runId: RunId;
  fixDescription: string;
  resolvedAt: string;
}
```

### 4. 類似度判定

#### 正規化対象

エラーメッセージから可変部分を除去して、パターンマッチングしやすくする：

- **ファイルパス** → `<FILE>`
- **行番号・列番号** → `<LINE>`
- **変数名（クォート内）** → `<VAR>`
- **数値** → `<NUM>`
- **タイムスタンプ** → `<TIME>`
- **UUID** → `<UUID>`
- **ハッシュ値** → `<HASH>`

#### 正規化例

```
Before: error TS2307: Cannot find module '@/types' at src/index.ts:15:24
After:  error TS<NUM>: Cannot find module '<VAR>' at <FILE>:<LINE>:<LINE>
```

#### アルゴリズム

```typescript
function calculateSimilarity(current: FailureInfo, pattern: FailurePattern): number {
  // 1. カテゴリが異なれば類似度0（高速フィルタ）
  if (current.errorCategory !== pattern.errorCategory) {
    return 0;
  }

  // 2. エラーメッセージを正規化
  const normalizedCurrent = normalizeError(current.errorMessage);

  // 3. キーワード抽出
  const currentKeywords = extractKeywords(normalizedCurrent);
  const patternKeywords = pattern.keywords;

  // 4. Jaccard係数で類似度計算
  const intersection = new Set(
    currentKeywords.filter(k => patternKeywords.includes(k))
  );
  const union = new Set([...currentKeywords, ...patternKeywords]);

  return intersection.size / union.size;
}
```

#### 閾値設定

- **類似度閾値**: 0.6（調整可能、将来的にConfigに追加検討）
- **最大パターン数**: 1000（超えた場合は警告ログ出力）

#### パフォーマンス考慮

1. **カテゴリ別インデックス**: `index.json`で検索範囲を限定
2. **早期リターン**: カテゴリが異なれば即座に類似度0を返す
3. **パターン数制限**: 1000パターン超過で警告

### 5. 失敗→成功の追跡

#### Task型への追加

```typescript
interface Task {
  // ... 既存フィールド

  /**
   * 失敗記録時のパターンID（成功時にクリア）
   *
   * WHY: 失敗パターンに対して成功した修正を記録するため
   */
  pendingPatternId?: PatternId;
}
```

#### フロー

```
1. Judge判定: 失敗
   ↓
2. recordFailure() → PatternId取得
   ↓
3. Task.pendingPatternIdに保存
   ↓
4. 継続実行 → Worker実行 → Judge判定: 成功
   ↓
5. Task.pendingPatternIdがある？
   ↓ YES
6. recordResolution() → 修正内容を記録
   ↓
7. Task.pendingPatternIdクリア
```

#### 実装例

```typescript
// Judge判定後（失敗時）
if (!judgement.success && judgement.shouldContinue) {
  // 失敗パターンを記録
  const failureInfo: FailureInfo = {
    taskId: tid,
    runId: result.runId,
    errorCategory: extractErrorCategory(judgement.reason),
    errorMessage: judgement.reason,
    relatedFiles: task.scopePaths,
    occurredAt: new Date().toISOString(),
  };

  const recordResult = await learningCapability.recordFailure(failureInfo);
  if (recordResult.ok) {
    // PatternIdをTaskに保存
    await taskStore.updateTaskCAS(tid, task.version, (t) => ({
      ...t,
      pendingPatternId: recordResult.val,
    }));
  }
}

// Judge判定後（成功時）
if (judgement.success && task.pendingPatternId) {
  // 成功した修正を記録
  await learningCapability.recordResolution(
    task.pendingPatternId,
    tid,
    judgement.reason
  );

  // pendingPatternIdをクリア
  await taskStore.updateTaskCAS(tid, task.version, (t) => ({
    ...t,
    pendingPatternId: undefined,
  }));
}
```

### 6. Worker実行時のプロンプト強化

#### 統合ポイント

`dynamic-scheduler.ts`の`executeTaskAsync()`内、Worker実行前に類似パターンを検索：

```typescript
async function executeTaskAsync(...) {
  // ... claimTask, resolveBaseBranch

  // Learning: 類似する過去の失敗を検索
  let improvementSuggestion = '';
  if (config.learning?.enabled) {
    const taskResult = await taskStore.readTask(tid);
    if (taskResult.ok && taskResult.val.judgementFeedback) {
      // 継続実行の場合、前回の失敗情報から類似パターンを検索
      const failureInfo: FailureInfo = {
        taskId: tid,
        runId: taskResult.val.latestRunId!,
        errorCategory: 'UNKNOWN', // 実際はログから抽出
        errorMessage: taskResult.val.judgementFeedback.lastJudgement.reason,
        relatedFiles: taskResult.val.scopePaths,
        occurredAt: taskResult.val.judgementFeedback.lastJudgement.evaluatedAt,
      };

      const similarResult = await learningCapability.findSimilarFailures(failureInfo);
      if (similarResult.ok && similarResult.val.length > 0) {
        const topPattern = similarResult.val[0];
        const suggestionResult = await learningCapability.suggestImprovement(
          topPattern,
          failureInfo
        );
        if (suggestionResult.ok) {
          improvementSuggestion = suggestionResult.val;
          console.log(`  💡 [${rawTaskId}] Found similar past failure, adding improvement suggestion`);
        }
      }
    }
  }

  // Worker実行（improvementSuggestionをコンテキストに追加）
  const workerResult = await workerOps.executeTaskWithWorktree(
    claimedTask,
    resolution,
    improvementSuggestion // 新しいパラメータ
  );

  // ... Judge判定
}
```

#### プロンプト追加例

```markdown
## Past Failure Analysis

This task has failed before with a similar error pattern.

**Previous Error Pattern:**
```
error TS2307: Cannot find module '<VAR>'
```

**Successful Fixes (2 occurrences):**
1. Added missing type definition file (resolved on 2026-01-20)
2. Updated tsconfig.json paths configuration (resolved on 2026-01-25)

**Recommendation:**
Check if the module path is correctly configured in tsconfig.json or if the type definition file exists.
```

### 7. エラーハンドリング（Best-Effort設計）

学習機能の失敗はWorker実行をブロックしない：

```typescript
// 学習機能の呼び出し例
const suggestionResult = await learningCapability.findSimilarFailures(failure);
if (!suggestionResult.ok) {
  // エラーをログに記録するが、Worker実行は継続
  logger.warn('Learning lookup failed, continuing without suggestion', suggestionResult.err);
  // improvementSuggestionは空文字列のまま
}
```

#### エラーログ出力

```typescript
// Learning機能のエラーは警告レベルで出力
console.warn(`⚠️  Learning: Failed to record failure pattern: ${error.message}`);
console.warn(`    Task execution will continue without learning.`);
```

### 8. 設定

```typescript
interface Config {
  // ... 既存フィールド

  learning?: {
    enabled: boolean;
  };
}
```

## 実装計画

### ファイル構成

#### 新規作成

| ファイル | 内容 |
|---------|------|
| `src/core/learning/interface.ts` | LearningCapability、FailureInfo、FailurePattern型 |
| `src/core/learning/similarity.ts` | 正規化、キーワード抽出、類似度計算 |
| `src/core/learning/file-store.ts` | ファイルストア実装 |
| `src/core/learning/index.ts` | エクスポート |
| `tests/unit/core/learning/similarity.test.ts` | 類似度計算テスト |
| `tests/unit/core/learning/file-store.test.ts` | ストアCRUDテスト |

#### 既存修正

| ファイル | 変更内容 |
|---------|----------|
| `src/types/branded.ts` | PatternId追加 |
| `src/types/errors.ts` | LearningError追加 |
| `src/types/task.ts` | `pendingPatternId?: PatternId` 追加（失敗→成功追跡用）|
| `src/types/config.ts` | `learning.enabled: boolean` 追加 |
| `src/core/orchestrator/dynamic-scheduler.ts` | 統合ポイント（失敗記録・解決記録・プロンプト強化）|

### 実装順序

1. **型定義**: branded.ts、errors.ts、interface.ts、task.ts、config.ts
2. **類似度ロジック**: similarity.ts + テスト
3. **ストレージ**: file-store.ts + テスト
4. **統合**: dynamic-scheduler.ts
5. **エクスポート**: index.ts

### 詳細ステップ

#### Step 1: 型定義

1. `src/types/branded.ts` に `PatternId` を追加
2. `src/types/errors.ts` に `LearningError` を追加
3. `src/types/task.ts` に `pendingPatternId?: PatternId` を追加
4. `src/types/config.ts` に `learning.enabled` を追加
5. `src/core/learning/interface.ts` を作成

#### Step 2: 類似度ロジック

1. `src/core/learning/similarity.ts` を作成
   - `normalizeError()`
   - `extractKeywords()`
   - `calculateSimilarity()`
2. `tests/unit/core/learning/similarity.test.ts` を作成

#### Step 3: ストレージ

1. `src/core/learning/file-store.ts` を作成
   - `recordFailure()`
   - `findSimilarFailures()`
   - `suggestImprovement()`
   - `recordResolution()`
2. `tests/unit/core/learning/file-store.test.ts` を作成

#### Step 4: 統合

1. `src/core/orchestrator/dynamic-scheduler.ts` を修正
   - `executeTaskAsync()` にLearning呼び出しを追加
   - Judge判定後に `recordFailure()` / `recordResolution()` を呼び出し

#### Step 5: エクスポート

1. `src/core/learning/index.ts` を作成

## 検証方法

### ユニットテスト

```bash
# 類似度計算テスト
node --test tests/unit/core/learning/similarity.test.ts

# ファイルストアテスト
node --test tests/unit/core/learning/file-store.test.ts
```

### 手動検証

```bash
# 1. agent run で意図的にtype errorを起こす
cd agent-coord
agent run "Add import statement without installing the package"

# 2. learnings/patterns/ にパターンが記録されることを確認
ls -la learnings/patterns/
cat learnings/patterns/<pattern-id>.json

# 3. 同じタスクを再実行し、プロンプトに改善提案が含まれることを確認
agent continue

# 4. 修正成功後、successfulFixesが記録されることを確認
cat learnings/patterns/<pattern-id>.json | jq '.successfulFixes'
```

### 検証ポイント

1. **パターン記録**: 失敗時に `learnings/patterns/` に JSON ファイルが作成される
2. **類似度検出**: 同じカテゴリのエラーが再発した時に類似パターンを検出
3. **プロンプト強化**: Worker実行時のログに "Found similar past failure" が表示される
4. **解決記録**: 成功時に `successfulFixes` 配列に記録が追加される
5. **Best-effort**: Learning機能のエラーでWorker実行がブロックされない

## 結果

### メリット

1. **効率向上**: 同じエラーパターンでの試行錯誤が減少
2. **学習の蓄積**: プロジェクト全体で失敗から学習
3. **透明性**: 過去の成功例が明示的に提案される
4. **拡張性**: インターフェース定義により、将来的な改善が容易

### デメリット

1. **ストレージ増加**: 失敗パターンがagent-coordに蓄積
2. **類似度判定の精度**: 固定閾値では誤検出の可能性
3. **実装複雑度**: 新しいモジュールの追加

### リスク軽減策

- **Best-Effort設計**: 学習機能の失敗でWorker実行をブロックしない
- **パターン数制限**: 1000パターン超過で警告
- **カテゴリ別インデックス**: 検索範囲を限定してパフォーマンス確保

## 将来の拡張

### 類似判定の自己改善（メタ学習）

Phase 1では固定の閾値（0.6）とキーワードマッチングを使うが、将来的には類似判定自体も学習させる：

```
[フィードバックループ]
1. 類似と判定 → 提案を適用 → 結果を観測
   - 成功: 判定は正しかった → 現在の設定を強化
   - 失敗: 誤判定の可能性 → 閾値/キーワードを調整

2. 類似と判定しなかった → 別アプローチで解決
   - 後から「実は同じ問題だった」と判明 → 閾値を下げる
```

**実装アイデア**:
- `SimilarityFeedback`型: 判定結果と実際の有効性を記録
- 閾値の動的調整（成功率に基づく）
- キーワード辞書の自動拡張

### その他の拡張

- **Embedding類似度**: ベクトル検索による意味的類似度
- **独立Learning Module**: Judgeから分離して独立したモジュールに
- **パターンの有効期限**: 古いパターンの自動削除
- **より高度なパターン分析**: 時系列分析、相関分析
- **推薦システム**: ユーザーの作業履歴に基づいた推薦

## 参考資料

- [ADR-001: CAS Implementation](001-cas-implementation-approach.md)
- [Architecture Documentation](../architecture.md)
- [Task Store Interface](../../src/core/task-store/interface.ts)
- [Dynamic Scheduler](../../src/core/orchestrator/dynamic-scheduler.ts)

## 変更履歴

| 日付 | 変更内容 |
|------|----------|
| 2026-01-27 | 初版作成 |
