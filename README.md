# Agent Orchestrator

Multi-agent collaborative development tool with Planner/Worker/Judge architecture.

## Features

- **Multi-agent orchestration**: Planner designs tasks, Workers implement, Judge validates
- **Worktree-based parallelization**: Parallel task execution using Git worktrees
- **CAS concurrency control**: Optimistic concurrency using Compare-And-Swap
- **SDK integration**: Claude Agent SDK and OpenAI Codex SDK support

## Requirements

- Node.js >= 18.0.0
- pnpm >= 9.15.4
- Git with worktree support

## Installation

```bash
pnpm install
```

## Development

```bash
# Type check
pnpm build

# Run tests
node --test tests/unit/**/*.test.ts

# Lint
pnpm lint

# Format
pnpm format
```

## Implementation Status

### ✅ Phase 1 完了 (2026-01-19)

すべての計画済みエピックが完了し、Tier 2 MVPレベルに到達しました：

- **Epic 1: Project Foundation**
  - TypeScript開発環境セットアップ (tsgo, oxlint, prettier)
  - 型定義 (Task, Run, Check, Config)
  - Branded Types による型安全性
- **Epic 2: Task Store**
  - JSONファイルベースのタスクストレージ
  - CRUD操作とCAS (Compare-And-Swap) 並行制御
  - mkdirベースのロック機構
  - Result型による統一的エラーハンドリング
- **Epic 3: VCS Adapter**
  - Git基本操作ラッパー (simple-git)
  - Worktree管理 (child_process)
  - 関数型Effectsパターン
- **Epic 4: Runner**
  - プロセス実行基盤とログ保存機能
  - Claude Agent SDK統合 (`@anthropic-ai/claude-agent-sdk`)
  - OpenAI Codex SDK統合 (`@openai/codex-sdk`)
  - 関数型Runnerアーキテクチャ
- **Epic 5: Orchestrator**
  - 並列度制御付きタスクスケジューラー
  - Planner/Worker/Judge状態機械
  - 完全なオーケストレーションサイクル (Planner→Worker→Judge)
  - 関数型による状態管理と操作分離
  - Result型エラーハンドリング
- **Epic 6: CLI Commands**
  - `agent init` - プロジェクト初期化
  - `agent run` - タスク実行
  - `agent status` - 状態確認
  - `agent stop` - タスク中断
- **Epic 7: Testing & Documentation**
  - ユニットテスト (node:test)
  - E2Eテスト (CLIコマンド統合)
  - アーキテクチャドキュメント完備

### 🎯 Tier 2 MVP達成

初期計画の目標であるTier 2 MVP（実用レベル）が完成しました：

- ✅ `agent init`で設定ファイル生成
- ✅ `agent run`でPlanner→Worker→Judgeの1サイクル実行
- ✅ タスクがJSONで管理され、worktreeで並列実行
- ✅ `agent status`でタスク一覧・進捗確認
- ✅ `agent stop`でタスク中断
- ✅ E2Eテストで基本フロー検証
- ✅ README/アーキテクチャドキュメント完備

## Architecture

See [docs/architecture.md](docs/architecture.md) for detailed architecture documentation.

## Project Structure

```
src/
  core/          # Core logic (Task Store, Runner, Orchestrator)
  cli/           # CLI entry points
  adapters/      # External integrations (VCS, GitHub)
  types/         # Type definitions
tests/           # Test code
```

## License

MIT
