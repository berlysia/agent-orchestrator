# CLI進捗表示機能の設計

## ステータス

**Proposed** ⏳

ProgressEmitter、TTYRendererは未実装。

## 決定日時

2026-01-23

## 背景

現在のCLIは全て`console.log()`/`console.error()`で出力しており、進捗表示機能が存在しない。長時間実行されるタスクの進捗状況が把握しづらい。

**要件**:
- 標準出力(stdout)には影響を与えない（パイプ処理との互換性維持）
- タスク総数、完了数、残り数、実行中タスクを表示
- リアルタイム更新

## 決定

### アーキテクチャ: Event Emitter + ProgressEmitter パターン

```
┌─────────────────┐     ┌──────────────────┐     ┌────────────────┐
│  Orchestrator   │────▶│ ProgressEmitter  │────▶│  TTYRenderer   │
│  (emit events)  │     │  (state + emit)  │     │  (display)     │
└─────────────────┘     └──────────────────┘     └────────────────┘
```

### 主要な設計決定

| 項目 | 決定 | 理由 |
|------|------|------|
| **命名** | `ProgressEmitter` | 既存の`*Effects`パターン（非同期I/O抽象化）との混同回避 |
| **配置** | `src/adapters/progress/` | Core層を純粋なビジネスロジックに保つ |
| **出力先** | stderr | stdout汚染を避け、パイプ処理を阻害しない |
| **外部ライブラリ** | 使用しない | 依存関係最小化、exact requirementsへの最適化 |
| **TTY検出** | `process.stderr.isTTY` | 標準的なNode.jsアプローチ |
| **スロットリング** | 100ms | 高頻度更新時のパフォーマンス確保 |

### ProgressEmitter インターフェース

```typescript
export interface ProgressEmitter {
  emit(event: ProgressEvent): void;
  getState(): ProgressState;
  subscribe(handler: ProgressEventHandler): () => void;
  reset(): void;
}
```

**注**: `RunnerEffects`等の既存Effectsパターンは`Result<T, E>`を返す非同期I/O抽象化だが、`ProgressEmitter`は同期的なイベント通知機構。目的が異なるため別概念として設計。

### イベント種別

```typescript
export const ProgressEventType = {
  ORCHESTRATION_START: 'ORCHESTRATION_START',
  PLANNING_START: 'PLANNING_START',
  PLANNING_COMPLETE: 'PLANNING_COMPLETE',
  TASK_START: 'TASK_START',
  TASK_JUDGING: 'TASK_JUDGING',
  TASK_COMPLETE: 'TASK_COMPLETE',
  TASK_FAILED: 'TASK_FAILED',
  TASK_BLOCKED: 'TASK_BLOCKED',
  TASK_CONTINUATION: 'TASK_CONTINUATION',
  INTEGRATION_START: 'INTEGRATION_START',
  INTEGRATION_COMPLETE: 'INTEGRATION_COMPLETE',
  ORCHESTRATION_COMPLETE: 'ORCHESTRATION_COMPLETE',
} as const;
```

### 表示形式

**TTYモード (インタラクティブ)**:
```
⠙ Executing [2/5] ████░░░░░░ 40%
  Running: task-abc (Add auth), task-xyz (Update config)
```

**非TTYモード (CI/パイプ)**:
```
[10:00:05] Generated 5 tasks
[10:00:06] Starting task-001: Setup project
[10:00:30] Completed task-001
```

## 新規ファイル

- `src/types/progress.ts` - イベント型・状態型定義
- `src/adapters/progress/progress-emitter.ts` - インターフェース
- `src/adapters/progress/progress-emitter-impl.ts` - EventEmitter実装
- `src/cli/progress/ansi-utils.ts` - ANSIエスケープシーケンス
- `src/cli/progress/tty-renderer.ts` - TTY表示ロジック

## 変更ファイル

- `src/core/orchestrator/orchestrate.ts` - `OrchestrateDeps`に`progressEmitter?`追加
- `src/core/orchestrator/task-execution-pipeline.ts` - `progressEmitter`受け渡し
- `src/core/orchestrator/dynamic-scheduler.ts` - タスクイベント発火
- `src/core/orchestrator/serial-executor.ts` - シリアルチェーンイベント発火
- `src/cli/commands/run.ts`, `resume.ts`, `continue.ts` - レンダラー統合

## 代替案と却下理由

### 案A: 外部ライブラリ使用 (ora, cli-progress)
- **却下理由**: 依存関係最小化の方針、exact requirementsへの最適化が難しい

### 案B: 既存console.logの置き換え
- **却下理由**: 破壊的変更が大きい、既存ログとの共存を優先

### 案C: ProgressEffects命名
- **却下理由**: 既存の`*Effects`パターン（RunnerEffects等）は非同期I/O抽象化。イベント通知機構は別概念のため`ProgressEmitter`に変更

## 検証方法

```bash
# TTYモード - 進捗バーが表示される
pnpm dev run "Create a simple hello world function"

# 非TTYモード - 簡易ログが表示される
pnpm dev run "..." 2>&1 | cat

# stdout汚染なし確認
pnpm dev run "..." > output.txt  # output.txtに進捗が含まれない
```

## teeコマンドとの互換性

### 挙動

| コマンド | stderr状態 | 進捗表示 | ファイル内容 |
|----------|-----------|----------|-------------|
| `cmd \| tee file` | TTY接続 | 進捗バー（ターミナル） | stdoutのみ |
| `cmd 2>&1 \| tee file` | パイプ | 簡易ログ | stdout + 進捗ログ |

### 詳細

**`command | tee file.txt`**:
- stdoutだけがteeに流れる
- stderrはTTYに直接接続されたまま → `process.stderr.isTTY = true`
- 進捗バーはターミナルに表示される（意図通りの動作）

**`command 2>&1 | tee file.txt`**:
- stderrがstdoutにリダイレクトされてパイプに流れる
- `process.stderr.isTTY = false` になる
- 非TTYモードにフォールバック（簡易ログ形式）

### 実装上の注意

非TTYモードでは**ANSIエスケープシーケンスを完全に無効化**する必要がある。`2>&1 | tee`でファイルにANSI制御文字が混入するのを防ぐため。

```typescript
// tty-renderer.ts での実装例
const useAnsi = stream.isTTY && !process.env.NO_COLOR;
```

## レビューフィードバック

本設計は以下のレビューを経て決定:

### logic-validator
- 依存注入チェーンの型定義を明確化
- 命名を`ProgressEffects`から`ProgressEmitter`に変更

### Codex Review
- ファイル配置を`src/core/`から`src/adapters/`に変更
- スロットリング機構の追加
- 既存console.logとの共存方針を明確化

## 参考

- 計画ファイル: `.claude/plans/eventual-beaming-squid.md`
- Codexレビュー: `.claude/plans/eventual-beaming-squid-agent-ad23406.md`
