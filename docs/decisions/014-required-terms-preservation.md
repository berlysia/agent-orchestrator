# 必須キーワード保持検証

## 選定日時

2026-01-23

## 選定結果

**ユーザー入力由来の必須キーワードが再計画後も保持されているかを検証する仕組み** を採用

## 背景・課題

### 問題点

再計画（replan）により生成されたタスク群が、元のユーザー要求から重要な要素を欠落させる可能性がある。

例：
```
ユーザー入力: 「認証機能とバリデーションを実装して」

元のタスク:
1. JWT認証の実装
2. 入力バリデーションの実装
3. エラーハンドリング

再計画後のタスク:
1. ユーザー管理機能の実装  ← 「認証」「バリデーション」が消えている
2. API実装
```

このような「質劣化」は既存の構造検証（タスク数変化率、依存関係チェック）では検出不可能。

### 関連ADR

- [ADR-010: Task Refinement Design](010-task-refinement-design.md) の制限事項として記載

## 採用した設計

### 1. 必須キーワード抽出

ユーザー入力から重要なキーワードを抽出：

```typescript
interface RequiredTerms {
  terms: string[];           // 抽出されたキーワード
  source: 'user-input' | 'original-tasks';  // 抽出元
}

function extractRequiredTerms(userInput: string): RequiredTerms {
  // Phase 1: シンプルなトークン化（LLM不要）
  // - 名詞・動詞の抽出
  // - ストップワードの除去
  // - 技術用語の優先

  // Phase 2（将来拡張）: LLMによる高精度抽出
}
```

### 2. 保持検証ロジック

```typescript
interface TermPreservationResult {
  preserved: string[];    // 保持されているキーワード
  missing: string[];      // 欠落しているキーワード
  preservationRate: number;  // 保持率（0-1）
}

function validateTermPreservation(
  requiredTerms: RequiredTerms,
  tasks: Task[],
  config: TermPreservationConfig
): TermPreservationResult {
  const allTaskText = tasks
    .map(t => `${t.acceptance} ${t.context || ''}`)
    .join(' ')
    .toLowerCase();

  const preserved: string[] = [];
  const missing: string[] = [];

  for (const term of requiredTerms.terms) {
    if (allTaskText.includes(term.toLowerCase())) {
      preserved.push(term);
    } else {
      missing.push(term);
    }
  }

  return {
    preserved,
    missing,
    preservationRate: preserved.length / requiredTerms.terms.length,
  };
}
```

### 3. 構造検証への統合

既存の `validateStructure` に追加：

```typescript
interface StructureValidation {
  // 既存
  isValid: boolean;
  taskCountChange: number;
  hasCircularDependency: boolean;
  hasDanglingDependency: boolean;

  // 新規
  termPreservation?: TermPreservationResult;
  hasTermLoss: boolean;  // 欠落キーワードがあるか
}

function validateStructure(
  originalTasks: Task[],
  newTasks: Task[],
  config: RefinementConfig,
  requiredTerms?: RequiredTerms  // 新規パラメータ
): StructureValidation {
  // 既存の検証...

  // 新規: キーワード保持検証
  let termPreservation: TermPreservationResult | undefined;
  let hasTermLoss = false;

  if (requiredTerms && config.enableTermPreservationCheck) {
    termPreservation = validateTermPreservation(requiredTerms, newTasks, config);
    hasTermLoss = termPreservation.missing.length > 0;
  }

  return {
    // ...既存フィールド
    termPreservation,
    hasTermLoss,
  };
}
```

### 4. 欠落時の対応

```typescript
if (structureValidation.hasTermLoss) {
  const { missing } = structureValidation.termPreservation!;

  // オプション1: 警告のみ（デフォルト）
  logger.warn(`Required terms missing after replan: ${missing.join(', ')}`);

  // オプション2: 構造破壊として扱う（設定で有効化）
  if (config.treatTermLossAsStructureBreak) {
    return { decision: 'reject', reason: `Missing required terms: ${missing.join(', ')}` };
  }
}
```

## 設定項目

| 設定 | デフォルト | 説明 |
|------|-----------|------|
| enableTermPreservationCheck | true | キーワード保持検証を有効化 |
| treatTermLossAsStructureBreak | false | 欠落時に構造破壊として扱うか |
| minPreservationRate | 0.8 | 最低保持率（これ未満で警告/reject） |
| customRequiredTerms | [] | ユーザー指定の必須キーワード |

## 影響範囲

### 変更対象ファイル

1. **types/planner-session.ts**: `RequiredTerms`, `TermPreservationResult`, 設定追加
2. **src/core/orchestrator/planner-operations.ts**:
   - `extractRequiredTerms()` 新規
   - `validateTermPreservation()` 新規
   - `validateStructure()` 拡張
3. **.agent/config-schema.json**: 設定追加
4. **src/config/agent-config.ts**: デフォルト値設定

### 後方互換性

- `enableTermPreservationCheck: false` で従来動作
- 設定が存在しない場合はデフォルト値で動作

## キーワード抽出の実装段階

### Phase 1: シンプル実装（初期リリース）

```typescript
function extractRequiredTerms(text: string): RequiredTerms {
  // 1. 基本的なトークン化
  const tokens = text
    .toLowerCase()
    .split(/[\s,、。．.]+/)
    .filter(t => t.length >= 2);

  // 2. ストップワード除去
  const stopWords = new Set(['する', 'ある', 'できる', 'the', 'a', 'an', 'is', 'are']);
  const filtered = tokens.filter(t => !stopWords.has(t));

  // 3. 技術用語の優先（簡易パターンマッチ）
  const techPatterns = /^(api|jwt|oauth|sql|http|crud|rest|graphql|auth|valid|test)/i;
  const prioritized = filtered.sort((a, b) => {
    const aIsTech = techPatterns.test(a) ? 0 : 1;
    const bIsTech = techPatterns.test(b) ? 0 : 1;
    return aIsTech - bIsTech;
  });

  return {
    terms: prioritized.slice(0, 10),  // 上位10個
    source: 'user-input',
  };
}
```

### Phase 2: LLM拡張（将来）

- LLMに「この入力から必須要件を抽出して」と依頼
- より高精度な抽出が可能
- コスト増のためオプション化

## 利点

1. **質劣化の早期検出**: 重要な要件の欠落を自動検知
2. **低コスト**: Phase 1ではLLM呼び出し不要
3. **段階的改善**: Phase 2で精度向上可能
4. **透明性**: 欠落キーワードを明示的にログ出力

## 制約・考慮事項

| リスク | 対策 |
|--------|------|
| 同義語・言い換えを検出できない | Phase 2でLLM活用、または同義語辞書 |
| 日本語のトークン化が不完全 | 形態素解析ライブラリの導入を検討 |
| 誤検知（実際には保持されている） | `minPreservationRate` で閾値調整 |

## テスト戦略

### 単体テスト

- `extractRequiredTerms()` の抽出精度
- `validateTermPreservation()` の検証ロジック
- 構造検証との統合

### テストケース例

```typescript
// 抽出テスト
const terms = extractRequiredTerms('認証機能とバリデーションを実装して');
assert(terms.terms.includes('認証'));
assert(terms.terms.includes('バリデーション'));

// 保持検証テスト
const tasks = [
  { acceptance: 'JWT認証を実装する', context: '' },
  { acceptance: '入力バリデーションを追加する', context: '' },
];
const result = validateTermPreservation({ terms: ['認証', 'バリデーション'], source: 'user-input' }, tasks, config);
assert(result.preservationRate === 1.0);
assert(result.missing.length === 0);
```

## ステータス

**設計中**

---

## 次回セッション用情報

### 参照すべきファイル

| ファイル | 内容 |
|----------|------|
| `src/types/planner-session.ts:183-190` | `StructureValidation` 型定義 |
| `src/core/orchestrator/planner-operations.ts` | `validateStructure` 実装箇所 |
| `src/types/task-breakdown.ts` | `TaskBreakdown` 型（acceptance, context フィールド） |
| `tests/unit/core/orchestrator/validate-structure.test.ts` | 既存テスト |
| `tests/e2e/refinement-integration.test.ts` | 統合テスト |

### 実装タスク

1. `RequiredTerms` 型を新規定義
2. `TermPreservationResult` 型を新規定義
3. `TermPreservationConfig` を `RefinementConfig` に追加
4. `extractRequiredTerms()` 関数を新規作成（Phase 1: シンプル実装）
5. `validateTermPreservation()` 関数を新規作成
6. `StructureValidation` に `termPreservation`, `hasTermLoss` を追加
7. `validateStructure()` を拡張
8. `.agent/config-schema.json` に設定追加
9. 単体テスト追加

### 確認ポイント

- ユーザー入力（instruction）へのアクセス方法
  - `PlannerSession.instruction` から取得可能
- 日本語トークン化の精度（形態素解析なしでどこまで実用的か）
- ストップワードリストの初期セット
- `validateStructure` の呼び出し箇所と `requiredTerms` の渡し方

### 日本語対応の検討

Phase 1では以下の簡易アプローチで開始：
- スペース・句読点でのトークン化
- 2文字以上のトークンを抽出
- 英語の技術用語はそのまま抽出可能
- 日本語は「認証」「バリデーション」など長めの単語は抽出可能
- 精度不足が顕著な場合、Phase 2でLLM抽出を検討
