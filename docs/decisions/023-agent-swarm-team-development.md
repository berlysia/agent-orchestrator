# エージェントスウォームによる擬似チーム開発機能

## ステータス

**Implementing** 🟡 (Phase 1 進行中)

## 提案日時

2026-01-27

## 概要

ユーザーとプランニングを協調し、開発リーダーエージェントがメンバーエージェントを指揮して開発を進める機能を実装する。既存の Planner/Worker/Judge アーキテクチャを拡張し、Leader による動的な協調管理を実現する。

## 背景

### 現在の課題

現在の Agent Orchestrator は静的な計画に基づく実行モデル：

1. **静的計画**: Planner がタスク分解を行い、Worker が順次実行
2. **限定的フィードバック**: Judge の判定は継続/完了のみ
3. **再計画の閾値**: 3回失敗で自動的に再計画
4. **ユーザー介入の欠如**: 実行中の動的な判断ができない

### 目指すべき姿

**Leader-Member パターン**により、より柔軟で適応的な開発を実現：

- Leader が Worker のフィードバックを解釈し、次アクションを動的に決定
- 実装中の困難に対して、適切なエスカレーション先を選択（User / Planner / LogicValidator / ExternalAdvisor）
- Worker は詳細なフィードバックを提供（成功/失敗だけでなく、探索結果、困難の理由など）

## 設計決定

### アーキテクチャ

```
Claude Code（フロントエンド）
├── team-orchestrator Skill
│   └── Agent Orchestrator CLI 呼び出し
└── team-member Subagent[]

Agent Orchestrator（バックエンド）
├── LeaderOps（新規追加）
├── Planner/Worker/Judge（既存）
├── worktree 並列実行（既存）
└── MCP Server（Phase 3）
```

### Leader-Planner 責務境界

**Leader は Planner を協調して使用する（置き換えではない）**:

| 役割 | 責務 |
|------|------|
| **Leader** | 計画の実行管理、メンバー指揮、フィードバック解釈、エスカレーション判断 |
| **Planner** | タスク分解、再計画、最終完了判定 |
| **Worker** | タスク実行、フィードバック報告 |
| **Judge** | 個別タスク完了判定 |

### Worker フィードバック拡張

既存の `judgementFeedback` に加えて、`workerFeedback` を追加：

```typescript
type WorkerFeedback =
  | {
      type: 'implementation';
      result: 'success' | 'partial' | 'failed';
      changes: string[];
      notes?: string;
    }
  | {
      type: 'exploration';
      findings: string;
      recommendations: string[];
      confidence: 'high' | 'medium' | 'low';
    }
  | {
      type: 'difficulty';
      issue: string;
      attempts: string[];
      impediment: {
        category: 'technical' | 'ambiguity' | 'scope' | 'dependency';
        requestedAction: 'clarification' | 'replan' | 'escalate' | 'continue';
      };
      suggestion?: string;
    }
```

### LeaderSession 状態管理

新しいセッション型を定義：

- **状態遷移**: `PLANNING → EXECUTING → REVIEWING → ESCALATING → COMPLETED`
- **保存先**: `.agent/leader-sessions/<sessionId>.json`
- **内容**:
  - 計画文書への参照
  - メンバータスク履歴
  - 判断エスカレーション記録

### エスカレーション戦略

| トリガー条件 | エスカレーション先 | アクション |
|--------------|-------------------|-----------|
| Worker が同一タスクで 3 回失敗 | Planner | `shouldReplan: true` で再分解要求 |
| `impediment.category === 'scope'` | User | スコープ拡大の承認を求める |
| `impediment.category === 'ambiguity'` | User | 要件の明確化を求める |
| `impediment.category === 'technical'` | LogicValidator → ExternalAdvisor | 技術的助言を求める |
| `impediment.category === 'dependency'` | Planner | 依存関係の再評価 |
| 矛盾する要件を発見 | User | 優先順位の決定を求める |
| 3 タスク以上が連続失敗 | User + Planner | 計画全体の見直し |
| LogicValidator が矛盾を検出 | User | 判断を求める |

**エスカレーション優先度**:
1. User（要件・方針に関わる判断）
2. Planner（タスク構造の問題）
3. LogicValidator（論理整合性）
4. ExternalAdvisor（技術的助言）

## 実装フェーズ

### Phase 1: Agent Orchestrator に Leader 機能追加

**目標**: 既存アーキテクチャを拡張し、Leader-Member パターンを実現

**主要タスク**:

1. **LeaderSession 型定義** (`src/types/leader-session.ts`)
2. **Worker フィードバック拡張** (`src/types/task.ts`)
3. **LeaderOperations 実装** (`src/core/orchestrator/leader-operations.ts`)
4. **CLI コマンド追加** (`src/cli/commands/lead.ts`)

**変更ファイル**:
- `src/types/leader-session.ts` (新規)
- `src/types/task.ts` (フィードバック型追加)
- `src/core/orchestrator/leader-operations.ts` (新規)
- `src/core/orchestrator/orchestrate.ts` (Leader フロー統合)
- `src/cli/commands/lead.ts` (新規)
- `src/cli/index.ts` (コマンド登録)

### Phase 2: Claude Code Skill 作成

**目標**: Claude Code からシームレスに Agent Orchestrator を操作

**主要タスク**:

1. **team-orchestrator Skill** (`~/.claude/skills/team-orchestrator/SKILL.md`)
2. **Subagent 定義** (implementation/investigation/review)
3. **ワークフロー統合**

### Phase 3: MCP Server によるリアルタイム通信（オプション）

**目標**: リアルタイム双方向通信でより高度な協調を実現

**主要タスク**:

1. **MCP Server 実装** (`src/mcp-server/`)
2. **リアルタイムフィードバック**

## Leader の自律性レベル

```
Level 1: タスク完了時に判断（Phase 1 で実装）
  - Worker 完了 → Judge 評価 → Leader 次アクション決定

Level 2: リアルタイム介入（Phase 3 で実装）
  - Worker 実行中にフィードバック → Leader 即時対応
```

## 検証方法

### Phase 1 検証

1. **ユニットテスト**
   ```bash
   node --test tests/unit/leader-operations.test.ts
   ```

2. **E2E テスト**
   ```bash
   node --test tests/e2e/lead-command.test.ts
   ```

3. **テストシナリオ**

   | シナリオ | 検証内容 |
   |---------|---------|
   | Happy Path | 計画 → 実行 → 完了の正常フロー |
   | Escalation to User | `impediment.category === 'ambiguity'` 時のユーザーエスカレーション |
   | Escalation to Planner | 3 回失敗時の再計画フロー |
   | Exploration Feedback | 探索タスクの findings が Leader に正しく伝達 |
   | Multiple Task Failure | 3 タスク連続失敗時の計画見直しフロー |

4. **手動テスト**
   ```bash
   # 計画文書作成
   cat > .tmp/test-plan.md << 'EOF'
   # テスト計画
   1. ファイル探索
   2. 簡単な実装
   EOF

   # リーダーセッション開始
   agent lead .tmp/test-plan.md

   # 状態確認
   agent lead status
   ```

## リスクと対策

| リスク | 対策 |
|--------|------|
| 既存機能との競合 | LeaderSession を独立した概念として実装、既存フローに影響なし |
| 複雑性の増加 | Phase 分割で段階的に検証 |
| LLM コスト増加 | Leader 判断にはキャッシュ・batching を検討 |
| エスカレーションループ | 各エスカレーション先での試行回数制限を設定 |

## 依存関係

- Phase 1 は独立して実装可能
- Phase 2 は Phase 1 完了後
- Phase 3 は Phase 2 完了後（オプション）

## 既存コンポーネントとの関係

- **PlanningSession (ADR-021)**: 計画フェーズで使用、完了後 LeaderSession に引き継ぎ
- **PlannerSession**: Leader からの再計画要求時に使用
- **Worker/Judge**: 既存のまま、フィードバック形式を拡張

## 将来の拡張

1. **リアルタイム通信**: MCP Server による双方向通信
2. **複数 Leader**: 大規模プロジェクトでの階層的管理
3. **学習機能**: Leader の判断履歴を学習し、エスカレーション判断を最適化

## 参考

- [Architecture](../architecture.md)
- [ADR-021: Interactive Planning Mode](./021-interactive-planning-mode.md)
- [ADR-009: Judge Replanning Strategy](./009-judge-replanning-strategy.md)
