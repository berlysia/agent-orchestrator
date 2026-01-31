# ADR-030: 宣言的ワークフロー定義（YAML）

## Status

Deferred（将来検討）

## Context

現在、ワークフロー（Planner→Worker→Judge→Leader）はTypeScriptコードで制御されている：

- `orchestrate.ts`: 全体フロー
- `planner-operations.ts`: Planner処理
- `worker-operations.ts`: Worker処理
- `judge-operations.ts`: Judge処理
- `leader-operations.ts`: Leader処理

この方式の課題：

1. **カスタマイズ困難**: ワークフロー変更にはコード修正が必要
2. **可視性**: フロー全体を把握するには複数ファイルを読む必要がある
3. **非開発者排除**: プロンプトエンジニアがワークフローを調整できない

## Decision

**Deferred**: 以下の理由から、現時点では実装を見送る。

### 見送り理由

1. **複雑性**: 現在のLeaderパターン（ADR-023/024）は動的判断を行い、静的ルール定義では表現困難
2. **優先度**: ADR-026（プロンプト外部化）が先決条件
3. **ROI**: 現在のユースケースではコードベースで十分対応可能
4. **移行コスト**: 既存実装の大規模リファクタリングが必要

### 将来実装時の設計案

```yaml
# .agent/workflows/default.yaml
name: default
description: 標準開発ワークフロー
max_iterations: 20

phases:
  - name: planning
    type: interactive  # ADR-021
    steps:
      - agent: planner
        rules:
          - condition: Plan approved
            next: execution

  - name: execution
    type: leader-driven  # ADR-023/024
    config:
      parallel: 3
      escalation:
        requirements: user
        task_structure: planner
        technical: external

  - name: integration
    type: sequential
    steps:
      - agent: integrator
        rules:
          - condition: All merged
            next: COMPLETE
          - condition: Conflict
            next: resolve

  - name: resolve
    type: manual
    on_complete: integration
```

### 段階的導入案

1. **Phase 1**: ADR-026（プロンプト外部化）実装
2. **Phase 2**: 簡易ワークフロー設定（並列度、タイムアウト等）をYAML化
3. **Phase 3**: ステップ定義のYAML化（ルーティングはコードのまま）
4. **Phase 4**: 完全なYAMLワークフロー定義（オプション）

## Consequences

### もし実装する場合

#### Positive
- ワークフローの可視性向上
- 非開発者によるカスタマイズ
- 複数ワークフローの切り替え容易

#### Negative
- 動的判断（Leaderパターン）との統合が複雑
- YAMLパーサー・バリデーション実装コスト
- 既存テストの大規模修正

## Related ADRs

- [ADR-026: プロンプト外部化](./026-prompt-externalization.md) - 先決条件
- [ADR-023: Agent Swarm Team Development](./023-agent-swarm-team-development.md) - Leaderパターン
- [ADR-024: Worker Feedback & Dynamic Task Generation](./024-worker-feedback-dynamic-task-generation.md) - 動的タスク生成
- [ADR-020: Layered Config System](./020-layered-config-system.md) - 設定階層化

## References

- [GitHub Actions Workflow Syntax](https://docs.github.com/en/actions/reference/workflow-syntax-for-github-actions)
- [Temporal Workflow Definition](https://docs.temporal.io/workflows)
