# Team Orchestrator Subagents

Agent Orchestrator の Worker として使用できる特化型サブエージェントの定義です。

## Subagent 定義

### implementation

実装タスク用のサブエージェント。

**用途**:
- 新機能の実装
- コード修正
- リファクタリング

**設定例**:
```yaml
# .agent/config.yaml
agents:
  worker:
    type: claude
    model: claude-sonnet-4-20250514
```

**プロンプト特性**:
- コードを書くことに集中
- テストを含める
- 既存パターンに従う

---

### investigation

調査・探索タスク用のサブエージェント。

**用途**:
- コードベースの調査
- バグの原因究明
- 設計パターンの分析

**設定例**:
```yaml
agents:
  worker:
    type: claude
    model: claude-sonnet-4-20250514
```

**プロンプト特性**:
- 読み取り中心
- 詳細なレポート生成
- 仮説と検証

---

### review

レビュー・検証タスク用のサブエージェント。

**用途**:
- コードレビュー
- テスト検証
- 品質チェック

**設定例**:
```yaml
agents:
  judge:
    type: claude
    model: claude-sonnet-4-20250514
```

**プロンプト特性**:
- 批判的視点
- 問題点の指摘
- 改善提案

---

## 使用方法

### Claude Code からの使用

Task ツールで `subagent_type` を指定してサブエージェントを起動できます（将来拡張）。

```
Task tool:
  subagent_type: implementation
  prompt: "認証機能を実装してください"
```

### Agent Orchestrator からの使用

Worker タスクは自動的に適切なサブエージェントタイプを選択します。

```bash
# タスクタイプに基づいて自動選択
agent run --task <taskId>
```

## タスクタイプとサブエージェントのマッピング

| タスクタイプ | サブエージェント | 説明 |
|--------------|------------------|------|
| implementation | implementation | コード実装 |
| exploration | investigation | 調査・探索 |
| review | review | レビュー・検証 |
| bug_fix | implementation | バグ修正 |
| refactoring | implementation | リファクタリング |
| documentation | implementation | ドキュメント作成 |

## カスタムサブエージェントの追加

将来的に、独自のサブエージェントを定義できるようになる予定です。

```yaml
# .agent/subagents/security-review.yaml
name: security-review
type: review
systemPrompt: |
  You are a security reviewer. Focus on:
  - OWASP Top 10 vulnerabilities
  - Authentication/authorization issues
  - Input validation
  - Secure coding practices
```

## 制限事項

1. **現在の実装**: サブエージェントタイプは Worker の動作をヒントとして提供するのみ
2. **将来拡張**: タスクタイプに基づくプロンプトカスタマイズ
3. **モデル選択**: サブエージェントタイプごとのモデル選択（将来拡張）
