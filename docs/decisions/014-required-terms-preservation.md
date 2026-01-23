# 要件カバレッジ検証

## ステータス

**Partially Implemented** 🔶

- 通常計画・refinement時のCoverage評価: ✅ 実装済み
- 再計画時の元指示追加: ✅ 実装済み
- fail-closedオプション: ⏳ 未実装（Medium優先度）

## 選定日時

2026-01-23

## 選定結果

**既存の QualityJudge の Coverage 評価項目で部分的に対応済み**

通常計画・refinement時は対応済み。再計画（replan）時の対応に課題あり。

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

## 現状の実装（既存）

調査の結果、`buildTaskQualityPrompt()` (planner-operations.ts:1756) に以下が既に実装されていた：

### 1. ユーザー指示の提示

```
USER INSTRUCTION:
${userInstruction}
```

プロンプト冒頭でユーザー指示を明示的に提示（1787-1788行目）。

### 2. Coverage 評価項目

CRITICAL評価基準の5番目として以下が既に含まれている（1809-1813行目）：

```
5. **Coverage**: Do all tasks together fully satisfy the original instruction?
   - All explicit requirements must be addressed by at least one task
   - Implicit requirements (e.g., if adding interface, must also use it) must be considered
   - No aspect of the instruction should be left unaddressed
   - Example: If instruction says "implement authentication and update orchestrate.ts to use it",
     there must be tasks for BOTH implementing auth AND updating orchestrate.ts
```

### 3. 評価結果の型

`TaskQualityJudgement` 型（128-137行目）で既に対応：

```typescript
interface TaskQualityJudgement {
  isAcceptable: boolean;
  issues: string[];        // ← 要件欠落もここに含まれる
  suggestions: string[];
  overallScore?: number;
}
```

## 追加実装の検討と却下

### 検討した追加機能

| 機能 | 理由 | 判断 |
|------|------|------|
| `enableRequirementCoverageCheck` 設定 | Coverage評価のオプトアウト | **却下** |
| `<user-instruction>` タグによる強調 | ユーザー指示の明確化 | **不要** |

### 却下理由

1. **オプトアウト設定**:
   - Coverage評価は品質管理の中核であり、無効化するユースケースが想定できない
   - 評価が厳しすぎる場合は `planning.qualityThreshold` で調整可能
   - 設定項目の増加は認知負荷を高める

2. **タグによる強調**:
   - 現状の `USER INSTRUCTION:` セクションで十分明確
   - プロンプト変更はリグレッションリスクを伴う

## 結論

通常計画・refinement時の要件カバレッジ検証は既存実装で機能している。
ただし、以下の課題が残存しており、完全な対応には追加改善が必要。

## 残存リスク

### High: 再計画時の元指示欠落

`buildReplanningPrompt()` (replanning-operations.ts) は元のユーザー指示を含まない。
再計画はタスク情報・実行ログ・Judge判定のみに依存し、元の要件を参照できない。

```typescript
// 現状: ユーザー指示が含まれていない
export const buildReplanningPrompt = (
  task: Task,              // ← タスク情報のみ
  runLog: string,          // ← 実行ログ
  judgement: JudgementResult, // ← Judge判定
): string => { ... }
```

### High: fail-open動作

品質評価でLLM実行失敗・JSONパース失敗時は `isAcceptable: true` で通過する（planner-operations.ts:1881-1930）。
要件欠落があっても評価自体が失敗すると検出できない。

### Medium: スコア閾値による上書き

`isAcceptable: false` でも `overallScore >= qualityThreshold` なら受理される可能性がある（planner-operations.ts:539）。

### Medium: 再計画プロンプトに Coverage 評価基準がない

`buildReplanningPrompt()` には通常計画時の `buildTaskQualityPrompt()` に含まれる「Coverage」評価基準が含まれていない。元のユーザー指示を追加しても、Coverage 評価の明示的な指示がなければ効果が限定的になる可能性。

## 将来の改善項目

| 優先度 | 項目 | 内容 |
|--------|------|------|
| High | 再計画時の元指示追加 | `buildReplanningPrompt()` にユーザー指示を渡す |
| Medium | fail-closed オプション | 評価失敗時に安全側倒れで拒否する設定 |
| Low | issues フォーマット統一 | `[Coverage] 要件欠落: ...` 形式で検出しやすく |

---

## 実装計画（High優先度: 再計画時の元指示追加）

### 変更対象ファイル

| ファイル | 変更内容 |
|----------|----------|
| `src/core/orchestrator/planner-operations.ts` | `PlannerDeps` に `userInstruction?: string` 追加 |
| `src/core/orchestrator/replanning-operations.ts` | `buildReplanningPrompt()` に `userInstruction` パラメータ追加 |
| `src/core/orchestrator/task-execution-pipeline.ts` | `TaskExecutionPipelineInput` に `userInstruction` 追加 |
| `src/core/orchestrator/orchestrate.ts` | 4箇所の `executeTaskPipeline` 呼び出しに `userInstruction` を渡す |

### 実装手順

1. **PlannerDeps 型拡張** (planner-operations.ts:109)
   ```typescript
   readonly userInstruction?: string;
   ```

2. **buildReplanningPrompt 修正** (replanning-operations.ts:27)
   ```typescript
   export const buildReplanningPrompt = (
     task: Task,
     runLog: string,
     judgement: JudgementResult,
     userInstruction?: string,  // 追加
   ): string => {
     const userInstructionSection = userInstruction
       ? `## Original User Instruction\n\n${userInstruction}\n\n`
       : '';
     return `...${userInstructionSection}...`;
   };
   ```

3. **replanFailedTask 修正** (replanning-operations.ts:148)
   ```typescript
   const prompt = buildReplanningPrompt(task, runLog, judgement, deps.userInstruction);
   ```

4. **TaskExecutionPipelineInput 拡張** (task-execution-pipeline.ts:74)
   ```typescript
   readonly userInstruction?: string;
   ```

5. **executeTaskPipeline 内の plannerDeps 構築修正** (task-execution-pipeline.ts:145)
   ```typescript
   const plannerDeps = { ...existing, userInstruction };
   ```

6. **orchestrate.ts の4箇所で userInstruction を渡す**
   - 255行目: `executeInstruction` 内（`userInstruction` 利用可能）
   - 474行目: 追加タスク実行（`session.instruction` から取得）
   - 836行目: `resumeFromSession` 内（`session.instruction` 利用可能）
   - 1127行目: `continueFromSession` 内（`session.instruction` 利用可能）

### テスト計画

1. **単体テスト**: `buildReplanningPrompt()` に `userInstruction` が含まれることを確認
2. **統合テスト**: 再計画時に元の指示がプロンプトに反映されることを確認
3. **後方互換性**: `userInstruction` が未指定（`undefined`）でも動作することを確認
4. **境界値テスト**:
   - 空文字列の `userInstruction`
   - 非常に長い `userInstruction`（トークン制限への影響）
   - マルチバイト文字（日本語）を含む `userInstruction`
5. **E2Eテスト**: 実際の再計画フローで元指示が保持され、Coverage評価に反映されることを確認

### 関連ADR

- [ADR-010: Task Refinement Design](010-task-refinement-design.md) - Refinementフローの設計

---

## 参考：既存実装の詳細

### buildTaskQualityPrompt 関数シグネチャ

```typescript
export const buildTaskQualityPrompt = (
  userInstruction: string,
  tasks: TaskBreakdown[],
  strictContextValidation: boolean,
  maxTaskDuration: number = 4,
  previousFeedback?: string,
): string
```

### 評価基準の重み付け（既存）

- **CRITICAL** (70%): Completeness, Clarity, Acceptance criteria, Dependency validity, **Coverage**
- **IMPORTANT** (20%): Context sufficiency, Granularity
- **NICE TO HAVE** (10%): Independence, Best practices

### 関連ファイル

| ファイル | 行番号 | 内容 |
|----------|--------|------|
| `src/core/orchestrator/planner-operations.ts` | 1756-1841 | `buildTaskQualityPrompt()` 定義 |
| `src/core/orchestrator/planner-operations.ts` | 128-137 | `TaskQualityJudgement` 型定義 |
| `src/core/orchestrator/planner-operations.ts` | 246-279 | `judgeTaskQuality()` 呼び出し元 |
