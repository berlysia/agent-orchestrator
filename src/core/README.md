# Core Logic

このディレクトリには、エージェントオーケストレーションのコアロジックが含まれます。

## サブディレクトリ構成

- `task-store/` - タスク状態管理（JSON/SQLiteストア）
- `runner/` - エージェント実行エンジン（Claude、Codex）
- `orchestrator/` - Planner/Worker/Judge状態機械
