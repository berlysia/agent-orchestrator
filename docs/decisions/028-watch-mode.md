# ADR-028: Watchモード（タスク監視自動実行）

## Status

Proposed

## Context

現在、タスク実行は`agent run`コマンドで明示的に開始する必要がある。以下のユースケースに対応できていない：

1. **CI/CD連携**: 外部プロセスがタスクファイルを生成し、自動実行したい
2. **バッチ処理**: 複数タスクを順次キューイングして処理したい
3. **長時間開発セッション**: 作業中にタスクを追加し、バックグラウンドで実行したい

## Decision

`agent watch`コマンドを追加し、タスクディレクトリを監視して自動実行する。

### コマンド

```bash
# 基本使用
agent watch

# オプション
agent watch --interval 5000    # ポーリング間隔（ms）
agent watch --parallel 3       # 並列度
agent watch --once            # 1回実行して終了（CI用）
```

### タスクファイル形式

#### YAML形式（推奨）

```yaml
# .agent/tasks/001-add-auth.yaml
task: "認証機能を追加する"
priority: high
workflow: default
dependencies: []
```

#### Markdown形式（シンプル）

```markdown
# .agent/tasks/002-fix-bug.md

ログイン画面のバリデーションエラーを修正する。

## Requirements
- メールアドレス形式チェック
- パスワード強度チェック
```

### ディレクトリ構造

```
.agent/
├── tasks/                    # 待機タスク
│   ├── 001-add-auth.yaml
│   └── 002-fix-bug.md
├── processing/               # 実行中タスク
│   └── 001-add-auth.yaml
├── completed/                # 完了タスク
│   └── 001-add-auth.yaml
└── failed/                   # 失敗タスク
    └── 003-broken.yaml
```

### 実行フロー

```
1. .agent/tasks/ をポーリング
2. 新規タスクファイル検出
3. .agent/processing/ へ移動
4. タスク実行（agent run相当）
5. 成功: .agent/completed/ へ移動
   失敗: .agent/failed/ へ移動
6. 1へ戻る
```

### API

```typescript
interface WatchOptions {
  interval: number;      // ポーリング間隔（デフォルト: 5000ms）
  parallel: number;      // 並列度（デフォルト: 1）
  once: boolean;         // 1回実行モード
}

interface TaskWatcher {
  start(options: WatchOptions): Promise<void>;
  stop(): Promise<void>;
}
```

### タスクファイルスキーマ

```typescript
interface TaskFile {
  task: string;                    // タスク内容（必須）
  priority?: 'high' | 'normal' | 'low';
  workflow?: 'default' | 'simple' | 'research';
  dependencies?: string[];         // 他タスクファイル名
  worktree?: boolean;              // 分離実行
  branch?: string;                 // ブランチ名
}
```

## Consequences

### Positive

- **CI/CD統合**: GitHub Actionsからタスクファイル生成→自動実行が可能
- **バッチ処理**: 複数タスクのキューイング実行
- **柔軟性**: 外部ツール連携が容易

### Negative

- プロセス常駐によるリソース消費
- ポーリングによる遅延（イベント駆動より劣る）

### Neutral

- 既存の`agent run`は維持（明示的実行用）

## Implementation

### Phase 1: 基本機能
1. タスクファイルパーサー（YAML/Markdown）
2. ディレクトリ監視ループ
3. `agent watch`コマンド

### Phase 2: 拡張
1. 並列実行サポート
2. 依存関係解決
3. 優先度ソート

### Phase 3: CI/CD
1. `--once`モード
2. 終了コード管理
3. レポート出力

## Alternatives Considered

### inotify/fseventsによるイベント駆動

- **利点**: 即座に検出、CPU効率良い
- **欠点**: プラットフォーム依存、複雑性増加
- **判断**: 初期実装はポーリングでシンプルに。需要あれば後で検討。

## References

- [chokidar](https://github.com/paulmillr/chokidar) - ファイル監視ライブラリ（将来検討）
