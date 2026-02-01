# ADR-032: レポート生成とトレーサビリティ

## Status

Implemented

## Context

現在のagent-orchestratorでは、各フェーズの実行結果はRun/Check JSONとして保存されるが、以下の課題がある：

1. **可読性**: JSON形式は人間が読みにくい
2. **トレーサビリティ**: 計画→実装→レビューの流れを追跡しにくい
3. **後続参照**: 後のフェーズが前のフェーズの成果物を参照しにくい
4. **サマリー欠如**: タスク完了時の全体サマリーがない

## Decision

各フェーズでMarkdownレポートを生成し、タスク完了まで一貫したトレーサビリティを提供する。

### レポートディレクトリ構造

```
agent-coord/
└── reports/
    └── {sessionId}/
        ├── 00-planning.md        # Planning Session結果
        ├── 01-task-breakdown.md  # タスク分解結果
        ├── tasks/
        │   ├── task-001/
        │   │   ├── 00-scope.md       # 変更スコープ宣言
        │   │   ├── 01-execution.md   # Worker実行結果
        │   │   ├── 02-review.md      # Judge評価結果
        │   │   └── 03-decisions.md   # 決定記録（あれば）
        │   └── task-002/
        │       └── ...
        ├── 90-integration.md     # 統合結果
        └── summary.md            # 全体サマリー
```

### レポートタイプと形式

#### 1. Planning Report (`00-planning.md`)

```markdown
# Planning Session Report

## Original Request
{ユーザーの元の要求}

## Clarifications
| Question | Answer |
|----------|--------|
| {質問1} | {回答1} |

## Design Decisions
| Decision | Rationale |
|----------|-----------|
| {決定1} | {理由1} |

## Approved Scope
{承認されたスコープ}
```

#### 2. Task Breakdown Report (`01-task-breakdown.md`)

```markdown
# Task Breakdown

## Session: {sessionId}
## Created: {timestamp}

## Tasks
| # | ID | Title | Dependencies | Priority |
|---|-----|-------|--------------|----------|
| 1 | task-001 | {タイトル} | - | high |
| 2 | task-002 | {タイトル} | task-001 | normal |

## Dependency Graph
```
task-001
  └── task-002
      └── task-003
```
```

#### 3. Task Scope Report (`tasks/{taskId}/00-scope.md`)

```markdown
# Change Scope Declaration

## Task: {taskId}
{タスク概要}

## Planned Changes
| Type | File | Description |
|------|------|-------------|
| Create | `src/auth/service.ts` | 認証サービス |
| Modify | `src/routes.ts` | ルート追加 |

## Estimated Size
Medium (~200 lines)

## Impact Scope
- Authentication module
- Route configuration
```

#### 4. Execution Report (`tasks/{taskId}/01-execution.md`)

```markdown
# Execution Report

## Task: {taskId}
## Worker: {workerId}
## Duration: {duration}

## Changes Made
| Type | File | Lines Changed |
|------|------|---------------|
| Create | `src/auth/service.ts` | +150 |
| Modify | `src/routes.ts` | +10, -2 |

## Commands Executed
```bash
npm test  # ✅ passed
npm run build  # ✅ succeeded
```

## Notes
{実行時の特記事項}
```

#### 5. Review Report (`tasks/{taskId}/02-review.md`)

```markdown
# Judge Review Report

## Task: {taskId}
## Verdict: DONE / NEEDS_CONTINUATION / BLOCKED

## Evaluation Summary
| Aspect | Result | Notes |
|--------|--------|-------|
| Requirements | ✅ | All met |
| Tests | ✅ | 5/5 passed |
| Code Quality | ✅ | - |
| AI Antipatterns | ⚠️ | 1 warning |

## Issues (if any)
| # | Severity | Location | Issue | Action |
|---|----------|----------|-------|--------|
| 1 | Warning | `src/auth.ts:42` | Unused import | Removed |

## Continuation Guidance (if NEEDS_CONTINUATION)
{次回実行時のガイダンス}
```

#### 6. Summary Report (`summary.md`)

```markdown
# Task Completion Summary

## Session: {sessionId}
## Duration: {totalDuration}
## Status: ✅ Complete

## Original Request
{元の要求}

## Deliverables
| Type | File | Summary |
|------|------|---------|
| Create | `src/auth/service.ts` | 認証サービス実装 |
| Create | `tests/auth.test.ts` | テスト追加 |
| Modify | `src/routes.ts` | ルート設定 |

## Task Execution Summary
| Task | Status | Iterations |
|------|--------|------------|
| task-001 | ✅ Done | 1 |
| task-002 | ✅ Done | 2 |

## Review Results
| Review | Result |
|--------|--------|
| Judge | ✅ All tasks approved |
| Integration | ✅ Merged successfully |

## Verification Commands
```bash
npm test
npm run build
```
```

### API

```typescript
interface ReportGenerator {
  generatePlanningReport(session: PlanningSession): Promise<void>;
  generateTaskBreakdownReport(session: PlannerSession): Promise<void>;
  generateScopeReport(taskId: TaskId, scope: TaskScope): Promise<void>;
  generateExecutionReport(run: Run): Promise<void>;
  generateReviewReport(taskId: TaskId, evaluation: JudgeEvaluation): Promise<void>;
  generateSummaryReport(sessionId: SessionId): Promise<void>;
}

interface ReportReader {
  readReport(sessionId: SessionId, reportPath: string): Promise<Result<string, ReportError>>;
  listReports(sessionId: SessionId): Promise<Result<string[], ReportError>>;
}
```

### 後続フェーズでの参照

Workerは実行時に前フェーズのレポートを参照可能：

```typescript
// プロンプト構築時
const planningReport = await reportReader.readReport(sessionId, '00-planning.md');
const taskBreakdown = await reportReader.readReport(sessionId, '01-task-breakdown.md');

const prompt = `
## Context from Planning
${planningReport}

## Task Breakdown
${taskBreakdown}

## Your Task
${task.description}
`;
```

### レポート形式の宣言的指定（`report`フィールド）

設定ファイルでレポート形式をカスタマイズ可能にする：

```yaml
# .agent/config.yaml
reports:
  # レポートディレクトリ
  directory: agent-coord/reports

  # レポートタイプごとの設定
  types:
    planning:
      filename: "00-planning.md"
      template: "templates/planning.md"  # カスタムテンプレート
      sections:
        - original_request
        - clarifications
        - design_decisions
        - approved_scope

    execution:
      filename: "01-execution.md"
      format: |
        # Execution Report

        ## Task: {task_id}
        ## Worker: {worker_id}

        ## Changes Made
        {changes_table}

        ## Commands
        {commands_output}

    review:
      filename: "02-review.md"
      # 形式指定なし → デフォルトテンプレート使用

    summary:
      filename: "summary.md"
      cognitiveLoadReduction:
        maxLines: 50  # 認知負荷軽減のための行数制限
        collapseDetails: true  # 詳細は折りたたみ
```

### カスタムテンプレート

プロジェクト固有のレポートテンプレートを配置：

```
.agent/
└── templates/
    ├── planning.md
    ├── execution.md
    ├── review.md
    └── summary.md
```

**テンプレート例（`templates/planning.md`）**:

```markdown
# 計画レポート

## プロジェクト固有ヘッダー
{project_name} - {timestamp}

## 元の要求
{original_request}

## 質問と回答
{clarifications_table}

## 設計決定
{design_decisions_table}

## 承認スコープ
{approved_scope}

---
*このレポートは自動生成されました*
```

### 認知負荷軽減ルール

レポートが長くなりすぎないよう、フェーズごとに行数目安を設定：

| フェーズ | 状況 | 行数目安 |
|---------|------|---------|
| Planning | 正常 | 20行以下 |
| Execution | 正常 | 30行以下 |
| Review | 問題なし | 10行以下 |
| Review | 問題あり | 30行以下 |
| Summary | 正常完了 | 50行以下 |

**実装**:
```typescript
interface CognitiveLoadConfig {
  maxLines: number;
  collapseDetails: boolean;
  prioritySections: string[];  // 優先表示セクション
}
```

## Consequences

### Positive

- **可読性向上**: Markdown形式で人間が読みやすい
- **トレーサビリティ**: 計画→実装→レビューの流れを追跡可能
- **コンテキスト共有**: 後続フェーズが前のフェーズの成果物を参照可能
- **監査対応**: 何がどう決定されたかの記録が残る

### Negative

- ファイル数増加によるストレージ使用量増加
- レポート生成オーバーヘッド
- レポート形式の標準化・メンテナンスコスト

### Neutral

- 既存のRun/Check JSONは詳細データとして維持
- レポートはサマリー・人間向け、JSONは詳細・機械向け

## Implementation

### Phase 1: 基本レポート
1. `ReportGenerator` インターフェース定義
2. Planning/TaskBreakdown レポート生成
3. Summary レポート生成

### Phase 2: タスク単位レポート
1. Scope/Execution/Review レポート生成
2. Worker実行時のコンテキスト参照

### Phase 3: 拡張
1. カスタムレポート形式サポート
2. レポートのHTML/PDF出力（オプション）

## References

- [ADR-011: Monitoring Report Feature](./011-monitoring-report-feature.md)
- [ADR-027: NDJSON Session Logging](./027-ndjson-session-logging.md)
