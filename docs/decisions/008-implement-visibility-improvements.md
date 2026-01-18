# ADR 008: Implement Visibility and Agent Integration Improvements

**Date**: 2026-01-19
**Status**: Accepted
**Context**: Issue with execution visibility and agent integration

## Context

Agent Orchestratorの実行時に以下の問題が発見された：

1. **実行ログが保存されない**: Worker実行時にRunnerEffectsのログ機能を使用していないため、`runs/`ディレクトリが空のまま
2. **Plannerがダミー実装**: タスク分解がダミー関数で行われており、エージェント統合がされていない
3. **途中経過が不可視**: ユーザーが実行状況を確認できない

これらの問題により、ユーザー体験が著しく低下し、デバッグも困難な状態となっている。

詳細な分析は以下を参照：
- [docs/plans/current-issues.md](../plans/current-issues.md)
- [docs/plans/improvement-plan.md](../plans/improvement-plan.md)

## Decision

段階的な改善を4つのフェーズで実施することを決定：

### Phase 1: Worker実行ログの保存（優先度: 高）

**実装内容**:
- `worker-operations.ts`の`executeTask`関数を修正
- RunnerEffectsを使用してログとメタデータを保存
- runsディレクトリに`.log`と`.json`ファイルを出力

**理由**:
- 即座にUXが改善される
- 既存のRunnerEffectsを活用するだけで実装可能
- デバッグが容易になる

### Phase 2: Plannerのエージェント統合（優先度: 中）

**実装内容**:
- `planner-operations.ts`のダミー実装を置き換え
- Claude/Codexエージェントで実際にタスク分解を実行
- プロンプト構築とJSONパーサーを実装

**理由**:
- システムの本来の価値を発揮
- 複雑な指示への対応が可能になる
- タスク分解の品質が向上

### Phase 3: CLI出力の改善（優先度: 中）

**実装内容**:
- 実行時にログファイルパスを表示
- `agent status`コマンドの拡張
- `agent logs`コマンドの追加（オプション）

**理由**:
- Phase 1で保存したログをユーザーが確認しやすくなる
- より良いユーザー体験を提供

### Phase 4: Judge判定の強化（別Epic）

**実装内容**:
- CI統合とテスト結果に基づく判定
- より厳密な受け入れ基準の検証

**理由**:
- 品質保証の向上
- ただしCI統合が必要なため、別Epicとして扱う

## Implementation Order

推奨実装順序：

1. Phase 1（2-3時間） - クイックウィン
2. Phase 3（2-3時間） - Phase 1のログを活用
3. Phase 2（4-6時間） - エージェント統合
4. Phase 4（別Epic） - CI統合後

この順序により、早期にUX改善効果を得つつ、段階的に機能を強化できる。

## Consequences

### Positive

- ✅ ユーザーが実行状況を確認できるようになる
- ✅ デバッグとトラブルシューティングが容易になる
- ✅ タスク分解の品質が向上する
- ✅ システムの本来の価値が発揮される
- ✅ 実行履歴の追跡が可能になる

### Negative

- ⚠️ 実装に合計8-12時間程度必要
- ⚠️ ログファイルの管理が必要（将来的にローテーション機能が必要かも）
- ⚠️ エージェント実行コストが増加（Planner統合により）

### Risks

- **Phase 2リスク**: エージェントが不正なJSONを返す可能性
  - **対策**: パーサーのエラーハンドリング強化、フォールバック機能
- **Phase 1リスク**: ログファイルが大きくなる可能性
  - **対策**: 将来的にローテーション機能を追加

## Alternatives Considered

### Alternative 1: Phase 1のみ実装

**メリット**: 最小の工数でUX改善
**デメリット**: エージェント統合の価値が発揮されない
**判断**: Phase 1は必須だが、これだけでは不十分

### Alternative 2: Phase 2を先に実装

**メリット**: システムの本来の価値を優先
**デメリット**: ログがないため、デバッグが困難
**判断**: Phase 1のログ機能がないと、Phase 2のデバッグが困難

### Alternative 3: すべてを1つのPRで実装

**メリット**: 一度に完成
**デメリット**: レビューが困難、リスクが高い
**判断**: 段階的な実装の方が安全で、フィードバックを得やすい

## References

- [docs/plans/current-issues.md](../plans/current-issues.md) - 問題点の詳細分析
- [docs/plans/improvement-plan.md](../plans/improvement-plan.md) - 改善計画の詳細
- [src/core/runner/runner-effects-impl.ts](../../src/core/runner/runner-effects-impl.ts) - RunnerEffects実装
- [src/core/orchestrator/worker-operations.ts](../../src/core/orchestrator/worker-operations.ts) - Worker実装
- [src/core/orchestrator/planner-operations.ts](../../src/core/orchestrator/planner-operations.ts) - Planner実装
