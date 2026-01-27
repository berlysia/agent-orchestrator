---
name: team-orchestrator
description: Use this skill when you need to orchestrate multi-agent team development. Manages Leader sessions for coordinating Worker agents on complex tasks. Start a session from a plan file, monitor progress, handle escalations, and resume paused sessions.
context: fork
---

# Team Orchestrator Skill

Agent Orchestrator の Leader 機能を使用して、複数エージェントによるチーム開発を管理します。

## 使用タイミング

### 自動的に使用を検討すべき場面
1. **複雑なタスクの分割実行**: 複数のサブタスクに分解して並列実行したいとき
2. **計画に基づく開発**: 計画文書からタスクを生成し、順次実行したいとき
3. **チーム開発シミュレーション**: Worker エージェントを協調させて開発を進めたいとき

### ユーザーから明示的に呼ばれる場面
- "チーム開発を開始して"、"この計画を実行して"
- "Leader セッションを開始"
- "エスカレーションを解決して"
- "セッションを再開して"

## 基本コマンド

### セッション開始
```bash
cd /path/to/project && agent lead start <plan-file>
```

### セッション状態確認
```bash
agent lead status [sessionId]
agent lead list
```

### エスカレーション管理
```bash
agent lead escalations [sessionId]     # エスカレーション一覧
agent lead resolve <sessionId>          # エスカレーション解決
agent lead resume <sessionId>           # セッション再開
```

## ワークフロー

### 1. 計画作成
まず、実行したいタスクの計画文書を作成します。

```markdown
# 計画: 認証機能の実装

## タスク一覧
1. ユーザーモデルの作成
2. 認証 API エンドポイントの実装
3. JWT トークン管理
4. フロントエンド認証 UI
```

### 2. Leader セッション開始
```bash
agent lead start ./plan.md
```

### 3. 進捗監視
```bash
agent lead status
```

### 4. エスカレーション対応
Worker が困難に直面した場合、エスカレーションが発生します。

```bash
# エスカレーション一覧を確認
agent lead escalations

# エスカレーションを解決
agent lead resolve <sessionId>

# セッションを再開
agent lead resume <sessionId>
```

## 使用例

### ケース1: 新機能開発

```bash
# 計画文書を作成
cat > .tmp/feature-plan.md << 'EOF'
# 機能: ダッシュボード追加

## タスク
1. データ取得 API の実装
2. ダッシュボードコンポーネントの作成
3. グラフ表示機能の追加
4. テストの作成
EOF

# Leader セッション開始
agent lead start .tmp/feature-plan.md

# 進捗を監視
agent lead status
```

### ケース2: エスカレーション解決

```bash
# エスカレーションが発生した場合
agent lead escalations

# 出力例:
# ⏳ Escalation ID: abc-123
#    Target:     user
#    Reason:     [LogicValidator recommends user decision] ...

# 解決内容を入力
agent lead resolve <sessionId> --resolution "OAuth2 を使用する方針で進めてください"

# セッション再開
agent lead resume <sessionId>
```

## エスカレーション先

| 先 | 説明 | 処理 |
|----|------|------|
| User | 要件・方針に関わる判断 | セッション停止、ユーザー入力待ち |
| Planner | タスク構造の問題 | 自動再計画 |
| LogicValidator | 技術的困難 | LLM 分析、助言生成 |
| ExternalAdvisor | 専門的助言 | 外部システム連携（将来拡張） |

## セッション状態

| 状態 | 説明 |
|------|------|
| planning | 計画フェーズ |
| executing | タスク実行中 |
| reviewing | レビューフェーズ |
| escalating | エスカレーション待ち |
| completed | 完了 |
| failed | 失敗 |

## 注意事項

1. **計画文書の形式**: Markdown 形式で、タスクがリストとして記述されていることを推奨
2. **エスカレーション解決**: 未解決のエスカレーションがある状態では再開できない
3. **並列実行**: 依存関係のないタスクは並列に実行される可能性がある

## 関連コマンド

```bash
# タスク一覧
agent tasks list

# 特定タスクの状態
agent tasks status <taskId>

# ラン実行（単独タスク）
agent run --task <taskId>
```

## トラブルシューティング

### セッションが停止している
```bash
# 状態を確認
agent lead status <sessionId>

# エスカレーションを確認
agent lead escalations <sessionId>

# 必要に応じて解決して再開
agent lead resolve <sessionId>
agent lead resume <sessionId>
```

### タスクが失敗し続ける
```bash
# 詳細ログを確認
agent tasks status <taskId>

# 必要に応じて計画を見直し
```

## 設定ファイル

`.agent/config.yaml` で Leader の動作をカスタマイズできます。

```yaml
agents:
  planner:
    type: claude
    model: claude-sonnet-4-20250514
  worker:
    type: claude
    model: claude-sonnet-4-20250514
  judge:
    type: claude
    model: claude-sonnet-4-20250514

# 再計画戦略
replanStrategy: auto
maxReplanIterations: 3
```
