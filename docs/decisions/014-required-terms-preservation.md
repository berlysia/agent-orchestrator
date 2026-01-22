# 要件カバレッジ検証

## 選定日時

2026-01-23

## 選定結果

**QualityJudge の評価項目に「要件カバレッジ」を追加** する方式を採用

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

### 却下したアプローチ

**キーワードベースの検証** は以下の理由で却下：

- 日本語のトークン化が形態素解析なしでは困難
- 同義語・言い換えの検出ができない
- シンプルな実装では実用的な精度が出ない

### 関連ADR

- [ADR-010: Task Refinement Design](010-task-refinement-design.md) の制限事項として記載

## 採用した設計

### 1. QualityJudge の評価項目拡張

既存の QualityJudge プロンプトに「要件カバレッジ」の評価観点を追加：

```markdown
## 評価観点

### 既存
- タスクの粒度は適切か
- 依存関係は明確か
- 受け入れ基準は具体的か

### 追加
- **要件カバレッジ**: ユーザーの元の指示に含まれる全ての要件が、
  生成されたタスク群でカバーされているか
  - 欠落している要件があれば `issues` に記載
  - 例: "ユーザー入力に含まれる「バリデーション」の要件がタスクに反映されていません"
```

### 2. 評価結果の活用

```typescript
interface TaskQualityJudgement {
  isAcceptable: boolean;
  issues: string[];        // ← 要件欠落もここに含まれる
  suggestions: string[];
  overallScore?: number;
}
```

要件欠落が検出された場合：
- `issues` に欠落内容が記載される
- `isAcceptable` が `false` になる可能性
- 既存の refinement フローで `replan` が発生

### 3. プロンプト変更

`buildQualityJudgePrompt` に以下を追加：

```typescript
const qualityJudgePrompt = `
...既存の評価観点...

## 要件カバレッジ評価

以下のユーザー指示に含まれる要件が、全てタスクとしてカバーされているか評価してください：

<user-instruction>
${userInstruction}
</user-instruction>

欠落している要件があれば、issues に以下の形式で記載してください：
- "要件欠落: [欠落している要件の説明]"
`;
```

## 設定項目

| 設定 | デフォルト | 説明 |
|------|-----------|------|
| enableRequirementCoverageCheck | true | 要件カバレッジ評価を有効化 |

## 影響範囲

### 変更対象ファイル

1. **src/core/orchestrator/planner-operations.ts**:
   - `buildQualityJudgePrompt()` にユーザー指示と評価観点を追加
2. **src/types/config.ts**: `enableRequirementCoverageCheck` 設定追加
3. **.agent/config-schema.json**: 設定追加

### 後方互換性

- `enableRequirementCoverageCheck: false` で従来動作
- 設定が存在しない場合はデフォルト（true）で動作

## 利点

1. **日本語対応**: LLM が自然言語で判定するため、トークン化不要
2. **追加コストほぼゼロ**: 既存の QualityJudge 呼び出しに相乗り
3. **既存フローとの統合**: `issues` → `replan` の既存フローで対処
4. **柔軟な検出**: 同義語・言い換えも LLM が理解可能

## 制約・考慮事項

| リスク | 対策 |
|--------|------|
| LLM の判定が不安定 | ADR-013 のノイズ耐性と組み合わせ |
| プロンプトが長くなる | ユーザー指示が長い場合は要約を検討 |
| 過剰検出（実際にはカバーされている） | Judge の判定を信頼、必要なら閾値調整 |

## テスト戦略

### 単体テスト

- `buildQualityJudgePrompt()` にユーザー指示が含まれることを確認
- 設定による有効/無効の切り替え

### E2E テスト（手動検証）

検証シナリオ：
1. 要件が欠落した計画に対して `issues` に欠落が記載される
2. 全要件がカバーされた計画は `issues` に要件欠落がない
3. `enableRequirementCoverageCheck: false` で評価がスキップされる

## ステータス

**設計中**

---

## 次回セッション用情報

### 参照すべきファイル

| ファイル | 内容 |
|----------|------|
| `src/core/orchestrator/planner-operations.ts` | `buildQualityJudgePrompt` 実装箇所 |
| `src/core/orchestrator/planner-operations.ts:128-137` | `TaskQualityJudgement` 型定義 |
| `src/types/config.ts` | 設定型定義 |
| `.agent/config-schema.json` | 設定スキーマ |

### 実装タスク

1. `buildQualityJudgePrompt()` を特定
2. プロンプトに「要件カバレッジ評価」セクションを追加
3. ユーザー指示（instruction）をプロンプトに渡す導線を確認
4. `enableRequirementCoverageCheck` 設定を追加
5. E2E テストで動作確認

### 確認ポイント

- `buildQualityJudgePrompt` の現在のシグネチャ
- ユーザー指示（`PlannerSession.instruction`）へのアクセス経路
- プロンプトの長さ制限（ユーザー指示が長い場合の対処）
