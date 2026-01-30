# Worker フィードバック収集と動的タスク生成

## ステータス

**Proposed** ⏳

## 提案日時

2026-01-31

## 概要

Worker エージェントの実行結果から構造化フィードバックを収集し、Leader が動的にタスクを生成できるようにする。これにより、開発中に発見された問題やパターンに基づいて、能動的なタスク探索・実行が可能になる。

## 背景

### 現在の状態

ADR-023 で Worker フィードバック型が定義済み：

```typescript
type WorkerFeedback =
  | { type: 'implementation'; result: 'success' | 'partial' | 'failed'; changes: string[]; notes?: string; }
  | { type: 'exploration'; findings: string; recommendations: string[]; confidence: 'high' | 'medium' | 'low'; }
  | { type: 'difficulty'; issue: string; attempts: string[]; impediment: {...}; suggestion?: string; }
```

しかし、以下が未実装：
- Worker 実行ログからのフィードバック抽出
- `MemberTaskHistory.workerFeedback` の活用
- フィードバックに基づく動的タスク生成

### 課題

1. **受動的なタスク実行**: Planner が生成したタスクを順次実行するのみ
2. **発見事項の活用不足**: Worker が発見したパターンや問題が次のタスクに反映されない
3. **スキル発見機会の損失**: 繰り返しパターンを検出してスキル化する仕組みがない

### 参考: multi-agent-shogun のアプローチ

> Ashigaru notices a repeatable pattern during work → Candidate appears in dashboard.md → You (the Lord) review the candidate → If approved, Karo creates the skill

## 設計決定

### 1. Worker プロンプト拡張

Worker 実行プロンプトに構造化フィードバック出力を追加：

```
After completing the task, provide structured feedback in the following JSON format:

## Feedback
```json
{
  "type": "implementation" | "exploration" | "difficulty",
  "result": "success" | "partial" | "failed",
  "findings": ["発見事項1", "発見事項2"],
  "recommendations": ["推奨アクション1", "推奨アクション2"],
  "patterns": ["発見したパターン1", "発見したパターン2"],
  "notes": "補足情報"
}
```
```

**フィードバック項目の説明**:

| フィールド | 説明 | 例 |
|-----------|------|-----|
| `findings` | 作業中に発見した事実 | "src/auth/ に重複したバリデーションロジックがある" |
| `recommendations` | 推奨する追加アクション | "共通のバリデーション関数を作成する" |
| `patterns` | 繰り返し検出したパターン | "全ての API ハンドラで同じエラーハンドリングコード" |
| `notes` | 補足情報、懸念事項 | "変更がセキュリティに影響する可能性" |

### 2. フィードバック抽出

**新規ファイル**: `src/core/orchestrator/worker-feedback-extractor.ts`

```typescript
import type { WorkerFeedback } from '../../types/task.ts';

/**
 * Worker 実行ログから構造化フィードバックを抽出
 *
 * WHY: Worker エージェントの出力から JSON フィードバックを抽出し、
 *      Leader が動的タスク生成に活用できる形にする
 */
export function extractWorkerFeedback(runLog: string): WorkerFeedback | null {
  // ## Feedback セクション内の JSON を抽出
  const feedbackMatch = runLog.match(/## Feedback[\s\S]*?```json\s*([\s\S]*?)```/);
  if (!feedbackMatch) {
    return null;
  }

  try {
    const feedback = JSON.parse(feedbackMatch[1]);
    // WorkerFeedback スキーマでバリデーション
    return validateWorkerFeedback(feedback);
  } catch {
    return null;
  }
}

/**
 * フィードバックから推奨アクションを抽出
 */
export function extractRecommendations(feedback: WorkerFeedback): string[] {
  if (feedback.type === 'exploration') {
    return feedback.recommendations;
  }
  return [];
}

/**
 * フィードバックから発見パターンを抽出
 */
export function extractPatterns(feedback: WorkerFeedback): string[] {
  if ('patterns' in feedback && Array.isArray(feedback.patterns)) {
    return feedback.patterns;
  }
  return [];
}
```

### 3. タスク候補の型定義

**拡張**: `src/types/leader-session.ts`

```typescript
/**
 * タスク候補
 *
 * Worker のフィードバックから生成された、潜在的なタスク
 */
export const TaskCandidateSchema = z.object({
  /** 候補 ID */
  id: z.string(),
  /** 生成元 */
  source: z.enum(['worker-recommendation', 'pattern-discovery', 'exploration-finding']),
  /** 関連タスク ID */
  relatedTaskId: z.string().transform(taskId),
  /** 候補の説明 */
  description: z.string(),
  /** 優先度 */
  priority: z.enum(['low', 'medium', 'high']),
  /** 自動実行可能か（ユーザー承認不要） */
  autoExecutable: z.boolean(),
  /** カテゴリ */
  category: z.enum([
    'code-quality',
    'security',
    'performance',
    'maintainability',
    'architecture',
    'refactoring',
    'documentation',
  ]),
  /** 生成日時 */
  createdAt: z.string().datetime(),
  /** ステータス */
  status: z.enum(['pending', 'approved', 'rejected', 'executed']),
});

export type TaskCandidate = z.infer<typeof TaskCandidateSchema>;
```

**LeaderSession 拡張**:

```typescript
// LeaderSessionSchema に追加
taskCandidates: z.array(TaskCandidateSchema).default([]),
```

### 4. 動的タスク生成

**新規ファイル**: `src/core/orchestrator/dynamic-task-generator.ts`

```typescript
/**
 * フィードバックからタスク候補を生成
 *
 * @param feedback Worker フィードバック
 * @param task 元タスク
 * @returns タスク候補配列
 */
export function generateTaskCandidates(
  feedback: WorkerFeedback,
  task: Task,
): TaskCandidate[] {
  const candidates: TaskCandidate[] = [];

  // 推奨アクションからタスク候補を生成
  const recommendations = extractRecommendations(feedback);
  for (const rec of recommendations) {
    candidates.push({
      id: `candidate-${randomUUID()}`,
      source: 'worker-recommendation',
      relatedTaskId: task.id,
      description: rec,
      priority: determinePriority(rec),
      autoExecutable: isAutoExecutable(rec, task),
      category: categorizeRecommendation(rec),
      createdAt: new Date().toISOString(),
      status: 'pending',
    });
  }

  // パターン発見からタスク候補を生成
  const patterns = extractPatterns(feedback);
  for (const pattern of patterns) {
    candidates.push({
      id: `candidate-${randomUUID()}`,
      source: 'pattern-discovery',
      relatedTaskId: task.id,
      description: `Refactor: ${pattern}`,
      priority: 'low', // パターン系は低優先度
      autoExecutable: false, // パターン系は承認必須
      category: 'refactoring',
      createdAt: new Date().toISOString(),
      status: 'pending',
    });
  }

  return candidates;
}

/**
 * 自動実行可能か判定
 *
 * 初期は保守的に、スコープ内の小規模変更のみ自動実行可能とする
 */
function isAutoExecutable(recommendation: string, task: Task): boolean {
  // 初期実装では全て承認必須
  // 将来的に以下のような条件で自動実行を許可:
  // - 元タスクと同じスコープ内
  // - リスク低（命名規則、コメント追加など）
  // - セキュリティ関連でない
  return false;
}
```

### 5. Leader 統合

**修正**: `src/core/orchestrator/leader-operations.ts`

```typescript
// assignTaskToMember() 完了後に追加
const runLogResult = await deps.runnerEffects.readLog(workerResult.runId);
if (runLogResult.ok) {
  const feedback = extractWorkerFeedback(runLogResult.val);
  if (feedback) {
    // フィードバックを履歴に記録
    history.workerFeedback = feedback;

    // タスク候補を生成
    const candidates = generateTaskCandidates(feedback, task);
    if (candidates.length > 0) {
      console.log(`  💡 Generated ${candidates.length} task candidate(s)`);
      session.taskCandidates.push(...candidates);
      await deps.sessionEffects.saveSession(session);
    }
  }
}
```

### 6. CLI コマンド

**追加**: `src/cli/commands/lead.ts`

```bash
# タスク候補一覧表示
agent lead candidates [sessionId] [--status pending|approved|rejected]

# タスク候補承認
agent lead approve <candidateId> [--session <sessionId>]

# 全タスク候補承認（pending のみ）
agent lead approve --all [--session <sessionId>]

# 承認済みタスク実行
agent lead execute-candidates [sessionId]
```

## 実装フェーズ

### Phase 1: 基盤実装

1. Worker プロンプト拡張（`worker-operations.ts`）
2. `extractWorkerFeedback()` 実装
3. `TaskCandidate` 型定義
4. `LeaderSession.taskCandidates` フィールド追加

### Phase 2: 生成ロジック

5. `generateTaskCandidates()` 実装
6. `leader-operations.ts` 統合

### Phase 3: CLI 統合

7. `agent lead candidates` サブコマンド
8. `agent lead approve` サブコマンド
9. `agent lead execute-candidates` サブコマンド

## リスクと対策

| リスク | 対策 |
|--------|------|
| Worker がフィードバック形式に従わない | 抽出失敗時は null を返し、通常フローを継続 |
| 大量のタスク候補が生成される | 優先度フィルタ、バッチ承認機能 |
| 自動実行の誤判定 | 初期は全て承認必須、徐々に緩和 |
| フィードバック解析のオーバーヘッド | 非同期処理、キャッシュ検討 |

## 将来の拡張

1. **スキル自動生成**: パターン検出 → スキル候補 → 承認 → スキル化
2. **学習機能**: 承認/却下履歴から自動実行判定を学習
3. **優先度自動調整**: 重要度・緊急度を文脈から推定

## 依存関係

- ADR-023: Agent Swarm Team Development（Leader Session 基盤）

## 参考

- [ADR-023](023-agent-swarm-team-development.md)
- [multi-agent-shogun](https://github.com/yohey-w/multi-agent-shogun) - Skill 自動発見パターン
