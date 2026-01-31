# ADR-026: プロンプトの外部化（Markdown分離）

## Status

Implemented

## Context

現在、Planner/Worker/Judge/Leaderの各エージェントプロンプトはTypeScriptコード内に埋め込まれている（`prompt-builder.ts`等）。これにより以下の課題がある：

1. **カスタマイズ性**: プロンプト変更にコード修正・再ビルドが必要
2. **関心の分離**: プロンプトエンジニアリングとアプリケーションロジックが混在
3. **ユーザー拡張**: 非開発者がプロンプトを調整できない
4. **バージョン管理**: プロンプトの変更履歴がコード変更と混在

## Decision

エージェントプロンプトをMarkdownファイルとして外部化する。

### ディレクトリ構造

```
~/.agent/                          # グローバル設定（ユーザー共通）
├── prompts/
│   ├── planner.md
│   ├── worker.md
│   ├── judge.md
│   └── leader.md

.agent/                            # プロジェクト固有
├── prompts/                       # プロジェクト固有プロンプト（オーバーライド）
│   └── worker.md                  # このプロジェクト用のWorkerプロンプト
```

### 解決順序

1. `.agent/prompts/<role>.md` （プロジェクト固有）
2. `~/.agent/prompts/<role>.md` （ユーザーグローバル）
3. ビルトイン（パッケージ埋め込み）

### ファイル形式

```markdown
# Worker Agent

## Role
あなたは実装担当のWorkerエージェントです。

## Guidelines
- 指定されたタスクのみを実装する
- テストを実行して動作を確認する
- 不明点があれば質問する

## Output Format
タスク完了時は以下の形式で報告：
- 実装内容
- 変更ファイル
- テスト結果
```

### API

```typescript
interface PromptLoader {
  loadPrompt(role: AgentRole, projectDir?: string): Promise<Result<string, PromptLoadError>>;
}

type AgentRole = 'planner' | 'worker' | 'judge' | 'leader';
```

### 変数展開（instruction_template）

プロンプトテンプレート内で使用可能な変数：

| 変数 | 説明 | 使用場面 |
|------|------|---------|
| `{task}` | 元のタスク内容 | すべてのエージェント |
| `{task_id}` | タスクID | ログ、トレーサビリティ |
| `{session_id}` | セッションID | セッション追跡 |
| `{context}` | コンテキスト情報 | 背景情報の提供 |
| `{previous_response}` | 前ステップの出力 | ステップ間の情報連携 |
| `{iteration}` | 現在の試行回数（ワークフロー全体） | ループ検出との連携 |
| `{step_iteration}` | 現在のステップの試行回数 | ステップ単位のリトライ追跡 |
| `{max_iterations}` | 最大イテレーション数 | 残り回数の認識 |
| `{report_dir}` | レポートディレクトリパス | レポート出力先 |
| `{user_inputs}` | ユーザー追加入力 | インタラクティブ入力 |

**自動注入**: `{task}`, `{previous_response}`, `{user_inputs}` はテンプレートに明示的に含まれていなくても自動注入される。

```markdown
## Current Task
{task}

## Context
{context}

## Previous Step Output
{previous_response}

## Iteration Info
Attempt {iteration}/{max_iterations} (Step iteration: {step_iteration})
```

### ejectコマンド

ビルトインリソースをユーザーディレクトリにコピーしてカスタマイズ可能にする：

```bash
# プロンプトのみ
agent eject prompts

# 特定のエージェント
agent eject prompts --agent worker

# すべてのビルトインリソース（将来）
agent eject --all
```

**eject対象**:
- プロンプトファイル（`~/.agent/prompts/`）
- 設定テンプレート（`~/.agent/config.yaml`）
- レポートテンプレート（将来）

## Consequences

### Positive

- プロンプトのカスタマイズが容易（コード変更不要）
- プロンプトエンジニアリングとロジックの分離
- プロジェクト固有のプロンプト調整が可能
- プロンプトのバージョン管理が独立

### Negative

- ファイル読み込みオーバーヘッド（キャッシュで軽減可能）
- プロンプトとコードの整合性管理が必要
- 変数展開のエスケープ処理が必要

### Neutral

- 既存のビルトインプロンプトはフォールバックとして維持

## Implementation

### 実装済みファイル

| ファイル | 役割 |
|---------|------|
| `src/types/prompt.ts` | 型定義（AgentRole, PromptVariables, LoadedPrompt等） |
| `src/core/runner/prompt-loader.ts` | PromptLoader実装（階層読み込み、変数展開、自動注入） |
| `src/core/runner/builtin-prompts.ts` | ビルトインプロンプト（planner, worker, judge, leader） |
| `src/cli/commands/eject.ts` | ejectコマンド実装 |
| `tests/unit/prompt-loader.test.ts` | ユニットテスト |

### 実装API

```typescript
// プロンプトローダー作成
const loader = createPromptLoader(config?: Partial<PromptConfig>);

// プロンプト読み込み（階層解決付き）
const result = await loader.loadPrompt(AgentRole.WORKER);
// Result<LoadedPrompt, PromptLoadError>

// 変数展開
const expanded = loader.expandVariables(template, {
  task: 'Implement feature X',
  context: 'React project',
});

// 自動注入付きプロンプト処理（{task}等がなくても自動追加）
const processed = loader.processPrompt(content, variables);

// キャッシュクリア
loader.clearCache();
```

### 設定例

```yaml
# .agent/config.yaml
prompts:
  externalizationEnabled: true
  cacheEnabled: true
  projectDir: ".agent/prompts"
  globalDir: "~/.agent/prompts"
```

### Phase 1: 基盤 ✅
1. `PromptLoader` インターフェース定義
2. Markdown読み込み・変数展開実装
3. ビルトインプロンプトのMarkdown化
4. 自動注入機能（`{task}`, `{previous_response}`, `{user_inputs}`）

### Phase 2: CLI統合 ✅
1. `agent eject prompts` でビルトインをコピー
2. `--global` オプションでユーザーグローバルディレクトリにコピー
3. `--agent` オプションで特定エージェントのみコピー

### Phase 3: 検証（未実装）
1. プロンプト形式のバリデーション
2. 必須セクションの検証

## References

- [ADR-020: Layered Config System](./020-layered-config-system.md) - 設定の階層化パターン
