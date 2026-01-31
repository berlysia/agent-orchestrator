# 自律探索モード

## ステータス

**Implemented** ✅

ExplorationSession型、探索プロンプト、セッション永続化、探索操作、およびCLIコマンドを実装済み。

## 提案日時

2026-01-31

## 概要

明示的なタスク指示なしにコードベースを分析し、改善点を発見・提案・実行する「自律探索モード」を追加する。これにより、agent-orchestrator が受動的なタスク実行ツールから、能動的にコード品質を改善するツールへ進化する。

## 背景

### 現在の制限

1. **常に明示的な指示が必要**: ユーザーが具体的なタスクを与えないと何もしない
2. **探索タスクの限定的活用**: `taskType: 'investigation'` は存在するが、発見事項から動的にタスクを生成する仕組みがない
3. **継続的改善の欠如**: 一度のタスク完了後、次のアクションを提案しない

### 目指す姿

```bash
# 従来: 具体的な指示が必要
agent run "認証機能を実装する"

# 新規: 能動的な探索・改善
agent explore --focus security
# → コードベースを分析
# → 脆弱性や改善点を発見
# → ユーザーに報告・承認を求める
# → 承認されたタスクを実行
```

## 設計決定

### 1. ExplorationSession 型

**新規ファイル**: `src/types/exploration-session.ts`

```typescript
import { z } from 'zod';
import { taskId } from './branded.ts';

/**
 * 探索フォーカス
 */
export const ExplorationFocus = {
  CODE_QUALITY: 'code-quality',
  SECURITY: 'security',
  PERFORMANCE: 'performance',
  MAINTAINABILITY: 'maintainability',
  ARCHITECTURE: 'architecture',
  DOCUMENTATION: 'documentation',
  TEST_COVERAGE: 'test-coverage',
} as const;

export type ExplorationFocus =
  (typeof ExplorationFocus)[keyof typeof ExplorationFocus];

/**
 * 発見事項
 */
export const FindingSchema = z.object({
  id: z.string(),
  category: z.enum([
    ExplorationFocus.CODE_QUALITY,
    ExplorationFocus.SECURITY,
    ExplorationFocus.PERFORMANCE,
    ExplorationFocus.MAINTAINABILITY,
    ExplorationFocus.ARCHITECTURE,
    ExplorationFocus.DOCUMENTATION,
    ExplorationFocus.TEST_COVERAGE,
  ]),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  location: z.object({
    file: z.string(),
    line: z.number().optional(),
    endLine: z.number().optional(),
  }),
  title: z.string(),
  description: z.string(),
  recommendation: z.string(),
  actionable: z.boolean(),
  codeSnippet: z.string().optional(),
});

export type Finding = z.infer<typeof FindingSchema>;

/**
 * 探索セッション
 */
export const ExplorationSessionSchema = z.object({
  sessionId: z.string(),
  focus: z.array(z.nativeEnum(ExplorationFocus)),
  scope: z.array(z.string()), // ディレクトリパス
  status: z.enum([
    'exploring',
    'awaiting-approval',
    'executing',
    'completed',
    'failed',
  ]),
  findings: z.array(FindingSchema),
  taskCandidates: z.array(/* TaskCandidateSchema from ADR-024 */),
  approvedTaskIds: z.array(z.string().transform(taskId)),
  executedTaskIds: z.array(z.string().transform(taskId)),
  explorationTaskId: z.string().transform(taskId).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});

export type ExplorationSession = z.infer<typeof ExplorationSessionSchema>;
```

### 2. 探索プロンプトテンプレート

**新規ファイル**: `src/core/orchestrator/exploration-prompts.ts`

```typescript
export function buildExplorationPrompt(
  focus: ExplorationFocus[],
  scope: string[],
): string {
  const focusDescriptions: Record<ExplorationFocus, string> = {
    'code-quality': `
      - Type safety issues (any types, missing type annotations)
      - Error handling gaps (unhandled promises, generic catch blocks)
      - Code duplication
      - Unused variables, imports, or exports
      - Inconsistent naming conventions
    `,
    'security': `
      - Input validation issues
      - Potential injection vulnerabilities (SQL, XSS, command injection)
      - Hardcoded secrets or credentials
      - Insecure authentication/authorization patterns
      - Missing rate limiting or access controls
    `,
    'performance': `
      - N+1 query patterns
      - Unnecessary re-renders or computations
      - Memory leaks
      - Inefficient algorithms or data structures
      - Missing caching opportunities
    `,
    'maintainability': `
      - High cyclomatic complexity
      - Missing or outdated documentation
      - Long functions or classes
      - Deep nesting
      - Tight coupling between modules
    `,
    'architecture': `
      - Circular dependencies
      - Layer violations (e.g., UI accessing database directly)
      - Mixed responsibilities in modules
      - Inconsistent patterns across codebase
      - Missing abstractions
    `,
    'documentation': `
      - Missing JSDoc/TSDoc comments on public APIs
      - Outdated README or docs
      - Missing inline comments for complex logic
      - Undocumented configuration options
    `,
    'test-coverage': `
      - Untested functions or modules
      - Missing edge case tests
      - Flaky tests
      - Missing integration tests
    `,
  };

  const focusItems = focus.map(f => focusDescriptions[f]).join('\n');

  return `
# Code Exploration Task

You are analyzing a codebase to identify issues and improvement opportunities.

## Focus Areas
${focusItems}

## Scope
Analyze the following directories:
${scope.map(s => `- ${s}`).join('\n')}

## Instructions

1. **Explore** the codebase thoroughly within the specified scope
2. **Identify** issues based on the focus areas above
3. **Categorize** each finding by severity (low/medium/high/critical)
4. **Provide** actionable recommendations for each finding

## Output Format

For each finding, provide:

### Finding: [Title]
- **Category**: [code-quality|security|performance|maintainability|architecture|documentation|test-coverage]
- **Severity**: [low|medium|high|critical]
- **Location**: [file:line]
- **Description**: [Detailed explanation of the issue]
- **Recommendation**: [Specific actionable fix]
- **Code Snippet** (if applicable):
\`\`\`
[relevant code]
\`\`\`

## Summary

After listing all findings, provide:
- Total findings by category
- Priority recommendations (top 3-5 most impactful changes)
- Estimated effort for improvements

## Feedback

At the end, provide structured feedback:
\`\`\`json
{
  "type": "exploration",
  "findings": ["finding1", "finding2"],
  "recommendations": ["rec1", "rec2"],
  "confidence": "high|medium|low"
}
\`\`\`
`;
}
```

### 3. 探索操作

**新規ファイル**: `src/core/orchestrator/exploration-operations.ts`

```typescript
/**
 * 探索セッションを初期化
 */
export async function initializeExplorationSession(
  deps: ExplorationDeps,
  focus: ExplorationFocus[],
  scope: string[],
): Promise<Result<ExplorationSession, ExplorationError>>;

/**
 * 探索タスクを作成・実行
 */
export async function runExploration(
  deps: ExplorationDeps,
  session: ExplorationSession,
): Promise<Result<ExplorationSession, ExplorationError>>;

/**
 * 探索結果から発見事項を抽出
 */
export function extractFindings(runLog: string): Finding[];

/**
 * 発見事項からタスク候補を生成
 */
export function generateCandidatesFromFindings(
  findings: Finding[],
  session: ExplorationSession,
): TaskCandidate[];

/**
 * タスク候補を承認
 */
export async function approveCandidates(
  deps: ExplorationDeps,
  session: ExplorationSession,
  candidateIds: string[],
): Promise<Result<ExplorationSession, ExplorationError>>;

/**
 * 承認済みタスクを実行
 */
export async function executeApprovedTasks(
  deps: ExplorationDeps,
  session: ExplorationSession,
): Promise<Result<ExplorationSession, ExplorationError>>;
```

### 4. CLI コマンド

**新規ファイル**: `src/cli/commands/explore.ts`

```bash
# 探索開始
agent explore [--scope <directory>] [--focus <area1,area2,...>]

# 例
agent explore --scope src/core --focus security,code-quality
agent explore --focus performance
agent explore  # 全体探索、全フォーカス

# 探索状態確認
agent explore status [sessionId]

# 発見事項一覧
agent explore findings [sessionId] [--severity high,critical] [--category security]

# タスク候補承認
agent explore approve <candidateId> [--session <sessionId>]
agent explore approve --all [--session <sessionId>]

# 承認済みタスク実行
agent explore execute [sessionId]

# 探索セッション一覧
agent explore list
```

### 5. 探索フロー

```
agent explore 開始
    ↓
ExplorationSession 作成 (status: exploring)
    ↓
探索タスク生成 (taskType: investigation)
    ↓
Worker 実行（コードベース分析）
    ↓
実行ログから発見事項抽出 (extractFindings)
    ↓
発見事項サマリー表示
    ↓
タスク候補生成 (status: awaiting-approval)
    ↓
┌────────────────────┬─────────────────────┐
│ ユーザー承認       │ 情報のみ            │
│ (actionable)       │ (non-actionable)    │
├────────────────────┼─────────────────────┤
│ approve コマンド   │ レポートに記録のみ  │
│ → タスク生成       │                     │
└────────────────────┴─────────────────────┘
    ↓
execute コマンドで承認タスク実行 (status: executing)
    ↓
完了 (status: completed)
```

### 6. 進捗可視化

**`agent explore status` 出力例**:

```
📊 Exploration Session: explore-abc123
   Focus: security, code-quality
   Scope: src/core/
   Status: awaiting-approval

📋 Findings Summary:
   ├── 🔴 Critical: 1
   ├── 🟠 High: 3
   ├── 🟡 Medium: 7
   └── 🟢 Low: 12

🔍 Critical/High Findings:
   1. [security/critical] SQL injection vulnerability
      Location: src/core/db/queries.ts:45
      Recommendation: Use parameterized queries

   2. [code-quality/high] Unhandled promise rejection
      Location: src/core/api/handler.ts:123
      Recommendation: Add try-catch with proper error handling

   3. [security/high] Hardcoded API key
      Location: src/core/config/secrets.ts:10
      Recommendation: Move to environment variable

   4. [performance/high] N+1 query in user list
      Location: src/core/services/user.ts:67
      Recommendation: Use eager loading or batch query

🎯 Task Candidates (pending approval): 4
   Use 'agent explore approve --all' to approve all candidates
   Use 'agent explore findings' to see all findings
```

## 実装フェーズ

### Phase 1: 基盤

1. `ExplorationSession` 型定義
2. `ExplorationSessionEffects` インターフェース・実装
3. 探索プロンプトテンプレート

### Phase 2: 探索実行

4. `initializeExplorationSession()` 実装
5. `runExploration()` 実装
6. `extractFindings()` 実装

### Phase 3: タスク生成・実行

7. `generateCandidatesFromFindings()` 実装
8. `approveCandidates()` / `executeApprovedTasks()` 実装
9. ADR-024 の TaskCandidate 機構との統合

### Phase 4: CLI

10. `agent explore` コマンド実装
11. サブコマンド（status, findings, approve, execute, list）

## リスクと対策

| リスク | 対策 |
|--------|------|
| 探索が広範囲すぎる | スコープ制限、タイムアウト設定 |
| 誤検出（false positives） | 重要度フィルタ、ユーザーレビュー必須 |
| 大量の発見事項 | カテゴリ・重要度でグループ化、上位のみ表示 |
| 探索タスクのコスト | キャッシュ、差分探索（変更ファイルのみ） |
| 改善タスクの品質 | Planner による計画生成、Judge による検証 |

## 将来の拡張

1. **差分探索**: 前回探索からの変更ファイルのみを対象
2. **定期探索**: CI/CD 統合で定期的にコード品質チェック
3. **カスタムルール**: プロジェクト固有のルールセット定義
4. **レポート出力**: 探索結果の Markdown/JSON レポート生成
5. **トレンド分析**: 時系列での改善傾向可視化

## 依存関係

- ADR-023: Agent Swarm Team Development（Leader Session 基盤）
- ADR-024: Worker Feedback Dynamic Task Generation（タスク候補機構）

## 参考

- [ADR-023](023-agent-swarm-team-development.md)
- [ADR-024](024-worker-feedback-dynamic-task-generation.md)
- [multi-agent-shogun](https://github.com/yohey-w/multi-agent-shogun)
