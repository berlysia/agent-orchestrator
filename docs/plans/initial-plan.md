# マルチエージェント協働開発ツール - タスク分解計画

## 前提情報

### プロジェクト状況

- **現状**: Epic 1-2完了（2026-01-18時点）
- **設計状況**: アーキテクチャ設計完了（[.tmp/chatgpt-tasks-summary.md](.tmp/chatgpt-tasks-summary.md)）
- **アプローチ**: Cursor流（Planner/Worker/Judge分離、worktree並列、CAS楽観的並行制御）

### 実装進捗（2026-01-18更新）

**✅ Epic 1: プロジェクト基盤構築** - 完了

- Story 1.1: TypeScript開発環境セットアップ
- Story 1.2: 基本型定義とスキーマ設計

**✅ Epic 2: Task Store** - 完了

- Story 2.1: JSONファイルストア基本実装（CAS実装含む）
- Story 2.2: TaskStoreインターフェース抽象化

**✅ Epic 3: VCS Adapter** - 完了

- Story 3.1: Git基本操作ラッパー（simple-git採用）
- Story 3.2: Worktree管理（child_process経由）

**✅ Epic 4: Runner** - 完了

- Story 4.1: プロセス実行基盤（ProcessRunner、LogWriter）
- Story 4.2: エージェント実行インターフェース（ClaudeRunner、CodexRunner、Runner統合）
- Story 4.3: CI/Lint実行（P1、後回し）

**✅ Epic 5: Orchestrator** - 完了（2026-01-18）

- Story 5.1: タスクスケジューラ（Scheduler実装、並列度制御、タスク完了処理）
- Story 5.2: Planner/Worker/Judge遷移
  - Planner実行フロー（簡易実装、実際のエージェント統合は後回し）
  - Worker実行フロー（worktree作成→Worker起動→コミット→push）
  - Judge実行フロー（簡易判定、CI統合は後回し）
  - Orchestrator統合（Planner→Worker→Judgeの1サイクル実行）

**🚧 Epic 6: CLI基本コマンド** - 未着手
**🚧 Epic 7: 統合テストとドキュメント** - 未着手

### 実装方針

- **言語**: TypeScript
- **パッケージマネージャー**: pnpm
- **リポジトリ構成**: 2リポジトリ方式
  - `app-repo`: 実コード（開発対象）
  - `agent-coord`: タスク状態・ログ管理（Git JSON管理）

---

## タスク分解の観点

### 階層構造

1. **フェーズ**: 大きな実装段階（CLI/GitHub/GUI）
2. **エピック**: 機能領域（Task Store、VCS、Orchestrator等）
3. **ストーリー**: 実装可能単位（1-3日）
4. **タスク**: 実装最小単位（1-8時間）

### 依存関係の原則

- **垂直依存**: 基盤 → 応用（Core → CLI → GitHub → GUI）
- **水平依存**: 同一フェーズ内は並列可能
- **クリティカルパス**: Task Store → Orchestrator → CLI基本実装

---

## 実装タスク分解（Phase 1: CLIコア）

### 全体方針

- **目標**: 4週間でTier 2 MVP（実用レベル）を完成
- **優先**: 動作優先、完璧より実装スピード
- **テスト**: 手動テストでOK、自動テストは後回し
- **開発者**: 1名想定

### MVP定義（2段階）

#### Tier 1: P0のみ（約3週間、最低限動く）

- `agent init`で設定ファイル生成
- `agent run "指示文"`でPlanner→Worker→Judgeの1サイクル実行
- タスクがJSONで管理され、worktreeで並列実行
- **デモシナリオ**: 「`agent run "計算機CLIを作る"`で3タスクに分解し、並列実行して完成」

#### Tier 2: P0+P1（約4週間、実用レベル）← **本計画のゴール**

- Tier 1の機能に加えて:
  - `agent status`でタスク一覧・進捗確認
  - `agent stop`でタスク中断
  - E2Eテストで基本フロー検証
  - README/アーキテクチャドキュメント完備
- **デモシナリオ**:
  1. `agent init`
  2. `agent run "TODOアプリを作る"`
  3. `agent status`で進捗確認
  4. エラー発生時は`agent stop`で中断、ログ確認
  5. 再実行して完成

### 技術的前提の検証結果

#### ✅ **SDK経由を推奨（CLI経由より容易）**

**Claude Agent SDK** ([公式リポジトリ](https://github.com/anthropics/claude-agent-sdk-typescript)):

- パッケージ: `@anthropic-ai/claude-agent-sdk`（旧: `@anthropic-ai/claude-code`）
- ストリーミングメッセージ取得、MCP tool統合対応
- TypeScript型安全、構造化出力対応
- Node.js 18+ 必須、Zod ^3.24.1 必要
- 使用例:
  ```typescript
  import { Agent } from '@anthropic-ai/claude-agent-sdk';
  const agent = new Agent();
  const result = await agent.run({
    prompt: 'プロンプト',
    // tools, context等を指定
  });
  ```

**OpenAI Codex SDK** ([npm](https://www.npmjs.com/package/@openai/codex-sdk)):

- パッケージ: `@openai/codex-sdk`
- 最新版: 0.87.0（2026-01-16リリース）
- デフォルトモデル: gpt-5.2-codex（2026-01-14以降）
- Thread永続化、ストリーミング実行、構造化JSON出力対応
- メタデータのラウンドトリップ、複数ID待機（collaboration wait）対応
- 使用例:
  ```typescript
  import { Codex } from '@openai/codex-sdk';
  const codex = new Codex();
  const thread = await codex.threads.create();
  const result = await thread.run({
    prompt: 'プロンプト',
    // environment, workingDirectory等を指定
  });
  ```

#### **CLI経由は代替案として保持** ⚠️

CLI経由でもプログラム起動可能（検証済み）:

- Claude Code: `claude --print "プロンプト"`
- Codex: `codex exec "プロンプト"`

**実装方針**: SDK優先、SDK未対応の場合のみCLI経由を実装

**検証日時**: 2026-01-18
**参考**:

- [Claude Agent SDK on npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [Claude Agent SDK Quickstart](https://platform.claude.com/docs/en/agent-sdk/quickstart)
- [Codex SDK on npm](https://www.npmjs.com/package/@openai/codex-sdk)
- [Codex SDK Docs](https://developers.openai.com/codex/sdk/)

---

## Epic一覧とクリティカルパス

### 実装順序（依存関係順）

```
Week 1: 基盤構築
├─ Epic 1: プロジェクト基盤（2 stories、6-10h）
│   ├─ Story 1.1: TypeScript開発環境セットアップ [P0/M]
│   └─ Story 1.2: 基本型定義とスキーマ設計 [P0/M]
│
├─ Epic 2: Task Store（2 stories、7-10h）
│   ├─ Story 2.1: JSONファイルストア基本実装 [P0/L]
│   └─ Story 2.2: TaskStoreインターフェース抽象化 [P1/S]
│
└─ Epic 3: VCS Adapter（2 stories、12-16h）
    ├─ Story 3.1: Git基本操作ラッパー [P0/L]
    └─ Story 3.2: Worktree管理 [P0/L]

Week 2: 実行エンジン
├─ Epic 4: Runner（3 stories、12-18h）
│   ├─ Story 4.1: プロセス実行基盤 [P0/M]
│   ├─ Story 4.2: エージェント実行インターフェース [P0/L]
│   └─ Story 4.3: CI/Lint実行 [P1/M] ※初期スキップ可
│
└─ Epic 5: Orchestrator（2 stories、1-4日）⚠️最難関
    ├─ Story 5.1: タスクスケジューラ [P0/L]
    └─ Story 5.2: Planner/Worker/Judge遷移 [P0/XL]

Week 3: CLI統合
├─ Epic 6: CLI基本コマンド（5 stories、10-16h）
│   ├─ Story 6.1: CLIフレームワーク構築 [P0/M]
│   ├─ Story 6.2: `agent init` コマンド [P0/M]
│   ├─ Story 6.3: `agent run` コマンド [P0/M]
│   ├─ Story 6.4: `agent status` コマンド [P1/S]
│   └─ Story 6.5: `agent stop` コマンド [P1/S]
│
└─ Epic 7: 統合テストとドキュメント（2 stories、6-10h）
    ├─ Story 7.1: E2Eテストシナリオ [P1/M]
    └─ Story 7.2: READMEとドキュメント [P1/M]
```

---

## タスク詳細

### Epic 1: プロジェクト基盤構築

#### Story 1.1: TypeScript開発環境セットアップ [P0/M]

**依存**: なし
**見積もり**: 3-5h
**技術**: TypeScript、pnpm、tsconfig、oxlint、prettier

**タスク**:

1. **[E1-S1-T1]** pnpmプロジェクト初期化 (S)
   - `package.json`作成（name: `agent-orchestrator`、type: `module`）
   - TypeScript、型定義インストール
   - 受け入れ: `pnpm install`成功

2. **[E1-S1-T2]** tsconfig.json設定 (S)
   - strict: true、module: `NodeNext`、target: `ESNext`
   - moduleResolution: `NodeNext`
   - esModuleInterop: true、skipLibCheck: true
   - verbatimModuleSyntax: true
   - **実験的機能** (TypeScript 5.7+):
     - erasableSyntaxOnly: true (型のみimport/exportを自動判定)
     - allowImportingTsExtensions: true (.ts拡張子付きimport許可)
     - rewriteRelativeImportExtensions: true (出力時に.js等に書き換え)
   - baseUrl/pathsの利用は禁止、遠いモジュールの依存が多数必要になるならパッケージ分割してmonorepo化を検討する
   - **Note**: TypeScriptのネイティブ実装版`tsgo`（`@typescript/native-preview`）を使用
   - 受け入れ: `pnpm tsgo --noEmit`成功

3. **[E1-S1-T3]** Linter/Formatter設定 (S)
   - oxlintまたはeslint設定
   - prettier設定
   - pnpmスクリプト追加（`lint`, `format`）
   - 受け入れ: `pnpm lint`成功

4. **[E1-S1-T4]** ディレクトリ構造作成 (S)

   ```
   src/
     core/          # コアロジック
     cli/           # CLIエントリーポイント
     adapters/      # VCS、GitHub等の外部I/F
     types/         # 型定義
   tests/           # テストコード
   ```

   - 受け入れ: ディレクトリ作成、各README.md配置

---

#### Story 1.2: 基本型定義とスキーマ設計 [P0/M]

**依存**: Story 1.1
**見積もり**: 3-5h
**技術**: TypeScript、zod

**タスク**:

1. **[E1-S2-T1]** Task型定義 (M)
   - `src/types/task.ts`作成
   - Task interface（id、state、version、owner、repo、branch、scopePaths、acceptance、check）
   - TaskState enum（READY/RUNNING/DONE/BLOCKED/CANCELLED）
   - zodスキーマでvalidation
   - 受け入れ: 型定義完成、zodスキーマ動作確認

2. **[E1-S2-T2]** Run/Check型定義 (S)
   - `src/types/run.ts`: Worker実行結果
   - `src/types/check.ts`: CI/lint実行結果
   - 受け入れ: 型定義完成

3. **[E1-S2-T3]** Config型定義 (S)
   - `src/types/config.ts`: プロジェクト設定（app-repo path、agent-coord path、並列数）
   - 受け入れ: 型定義完成

---

### Epic 2: Task Store（タスク状態管理）

#### Story 2.1: JSONファイルストア基本実装 [P0/L]

**依存**: Story 1.2
**見積もり**: 6-8h
**技術**: fs/promises、JSON操作、CAS（Compare-And-Swap）
**リスク**: 並行制御の複雑度（CAS理解が必要）

**タスク**: 0. **[E2-S1-T0]** CAS実装方式の選定 (S) ⚠️**事前タスク**

- JSONファイルベースのCAS実装方式を検証
- 方式候補:
  - (1) Git commit方式（推奨）: versionフィールド+push競合検出、2リポジトリ方式と整合
  - (2) mkdirベースロック: シンプルだがGit管理外、並列度3以下なら十分
- **推奨**: Git commit方式（agent-coord repoにコミット→push→競合時リトライ）
- 受け入れ: 実装方式決定、プロトタイプ動作確認

1. **[E2-S1-T1]** ファイルストア基盤 (M)
   - `src/core/task-store/file-store.ts`作成
   - `tasks/<taskId>.json`読み書き（agent-coord repo内）
   - 受け入れ: readTask/writeTask関数動作

2. **[E2-S1-T2]** CRUD操作実装 (M)
   - createTask: 新規タスクJSON作成（state=READY、version=0）
   - getTask: タスク取得
   - listTasks: 全タスク一覧
   - deleteTask: タスク削除
   - 受け入れ: 各関数のnode:testテスト通過

3. **[E2-S1-T3]** CAS更新実装 (M) ⚠️重要
   - T0で決定した方式でupdateTaskCAS実装
   - updateTaskCAS: version比較→更新→version++
   - 並行更新検出（version不一致時エラー）
   - 受け入れ: 並行更新テストケース通過

4. **[E2-S1-T4]** Run/Check管理 (S)
   - `runs/<runId>.json`書き込み
   - `checks/<taskId>.json`書き込み
   - 受け入れ: 各関数動作確認

---

#### Story 2.2: TaskStoreインターフェース抽象化 [P1/S]

**依存**: Story 2.1
**見積もり**: 1-2h
**技術**: TypeScript interface

**タスク**:

1. **[E2-S2-T1]** TaskStore interface定義 (S)
   - `src/core/task-store/interface.ts`作成
   - CRUD+CAS操作をinterfaceで定義
   - 将来のSQLite移行を考慮
   - 受け入れ: interfaceとFileStore実装の一致確認

---

### Epic 3: VCS Adapter（Git操作抽象化）

#### Story 3.1: Git基本操作ラッパー [P0/L]

**依存**: Story 1.2
**見積もり**: 6-8h
**技術**: simple-git or isomorphic-git
**リスク**: Git操作の複雑度、エラーハンドリング

**タスク**:

1. **[E3-S1-T1]** Gitライブラリ選定とセットアップ (S)
   - simple-git vs isomorphic-git検証
   - インストールと基本動作確認
   - 受け入れ: branch操作のサンプルコード動作

2. **[E3-S1-T2]** Branch操作実装 (M)
   - `src/adapters/vcs/git-adapter.ts`作成
   - createBranch、switchBranch、deleteBranch
   - getCurrentBranch
   - 受け入れ: テストケース通過

3. **[E3-S1-T3]** Commit/Push操作実装 (M)
   - commit、push、pull
   - リモート存在確認
   - 受け入れ: テストケース通過

4. **[E3-S1-T4]** Status/Diff操作実装 (S)
   - getStatus、getDiff
   - 受け入れ: 動作確認

---

#### Story 3.2: Worktree管理 [P0/L]

**依存**: Story 3.1
**見積もり**: 6-8h
**技術**: git worktree CLI、child_process
**リスク**: worktreeはgitコマンド直接実行が必要（ライブラリサポート薄い）

**タスク**:

1. **[E3-S2-T1]** Worktree CLI実行基盤 (M)
   - `src/adapters/vcs/worktree-adapter.ts`作成
   - child_processでgit worktreeコマンド実行
   - stdout/stderrキャプチャ
   - 受け入れ: `git worktree list`実行成功

2. **[E3-S2-T2]** Worktree CRUD操作 (M)
   - createWorktree: `git worktree add .git/worktree/<name> <branch>`
   - listWorktrees: 一覧取得（parse `git worktree list`）
   - removeWorktree: 削除
   - 受け入れ: テストケース通過

3. **[E3-S2-T3]** Worktree運用ルール実装 (S)
   - 1タスク=1ブランチ=1worktreeの検証
   - worktreeパス生成（`impl/<taskId>/`、`planner/`等）
   - 受け入れ: ルール検証テスト通過

---

### Epic 4: Runner（エージェント実行）

#### Story 4.1: プロセス実行基盤 [P0/M]

**依存**: Story 1.2
**見積もり**: 3-5h
**技術**: child_process、stdio capture、タイムアウト制御
**リスク**: プロセス制御の複雑度

**タスク**:

1. **[E4-S1-T1]** プロセス実行ラッパー (M)
   - `src/core/runner/process-runner.ts`作成
   - spawn/execでプロセス起動
   - stdout/stderr streaming capture
   - タイムアウト制御（AbortController）
   - 受け入れ: 任意コマンド実行テスト通過

2. **[E4-S1-T2]** ログ保存機能 (S)
   - 実行ログをファイル保存（`runs/<runId>.log`）
   - 受け入れ: ログファイル生成確認

---

#### Story 4.2: エージェント実行インターフェース [P0/L]

**依存**: Story 4.1
**見積もり**: 6-8h → **4-6h（SDK利用で簡素化）**
**技術**: ~~Claude Code CLI、Codex CLI~~ → **Claude Agent SDK、Codex SDK**
**リスク**: ~~各CLIの起動方法・引数の理解が必要~~ → **解決済み（SDK利用）**

**タスク**:

1. **[E4-S2-T1]** Claude Agent SDK実行 (M)
   - `src/core/runner/claude-runner.ts`作成
   - `@anthropic-ai/claude-agent-sdk`インストール（Zod ^3.24.1も必要）
   - Task情報からプロンプトを構築
   - `Agent.run()`でエージェント実行、ストリーミング結果取得
   - worktree内でのコンテキスト制御（tools、workingDirectory等）
   - 受け入れ: **SDK経由でエージェント実行成功、Task受け取り可能**

2. **[E4-S2-T2]** Codex SDK実行 (M)
   - `src/core/runner/codex-runner.ts`作成
   - `@openai/codex-sdk`インストール（最新: 0.87.0）
   - Task情報からプロンプトを構築
   - `threads.create()` + `run()`でエージェント実行
   - Thread永続化とメタデータ管理
   - 受け入れ: **SDK経由でエージェント実行成功、Thread永続化確認**

3. **[E4-S2-T3]** Runner統合インターフェース (S)
   - `src/core/runner/index.ts`: Runner interface定義
   - runAgent(type: 'claude' | 'codex', task: Task)
   - 受け入れ: interfaceと実装の一致確認

---

#### Story 4.3: CI/Lint実行 [P1/M]

**依存**: Story 4.1
**見積もり**: 3-5h
**技術**: package.json scripts実行
**備考**: 初期はスキップ可、後で実装

**タスク**:

1. **[E4-S3-T1]** CI実行 (M)
   - `src/core/runner/ci-runner.ts`作成
   - `pnpm test`, `pnpm lint`等のスクリプト実行
   - 結果を`checks/<taskId>.json`に保存
   - 受け入れ: チェック実行とログ保存確認

---

### Epic 5: Orchestrator（状態機械）⚠️最難関

#### Story 5.1: タスクスケジューラ [P0/L]

**依存**: Story 2.1、Story 3.2
**見積もり**: 6-8h
**技術**: 状態機械、タスクキュー
**リスク**: 並列制御の複雑度（Workerの最大並列数管理）

**タスク**:

1. **[E5-S1-T1]** タスクキュー基本実装 (M)
   - `src/core/orchestrator/scheduler.ts`作成
   - READY状態タスクの取得
   - Worker割り当て（CAS更新でclaim）
   - 受け入れ: タスク取得テスト通過

2. **[E5-S1-T2]** 並列度制御 (M)
   - 最大Worker数制限（デフォルト3）
   - 空きWorkerスロット管理
   - 受け入れ: 並列数制御テスト通過

3. **[E5-S1-T3]** タスク完了処理 (S)
   - Worker完了時のstate更新（RUNNING→DONE）
   - worktree解放
   - 受け入れ: 完了フロー動作確認

---

#### Story 5.2: Planner/Worker/Judge遷移 [P0/XL]

**依存**: Story 5.1、Story 4.2
**見積もり**: 1-3日
**技術**: 状態機械、イベント駆動
**リスク**: 複雑度高（全体統合の中核）

**タスク**:

1. **[E5-S2-T1]** Planner実行フロー (L)
   - `src/core/orchestrator/planner.ts`作成
   - Plannerエージェント起動（mainブランチでコードベース探索）
   - タスク分解結果をTaskとして保存
   - 受け入れ: Planner→タスク生成テスト（手動）

2. **[E5-S2-T2]** Worker実行フロー (L)
   - `src/core/orchestrator/worker.ts`作成
   - worktree作成→Worker起動→コミット→push
   - 受け入れ: Worker実行完了テスト（手動）

3. **[E5-S2-T3]** Judge実行フロー (M)
   - `src/core/orchestrator/judge.ts`作成
   - CI結果確認→継続/停止判断
   - 次イテレーション準備（worktree再生成）
   - 受け入れ: Judge判断ロジック動作確認

4. **[E5-S2-T4]** Orchestrator統合 (L)
   - `src/core/orchestrator/index.ts`
   - Planner→Worker→Judgeの1サイクル実行
   - エラーハンドリング（タスク失敗時の再試行/BLOCKED）
   - 受け入れ: 1サイクル完走テスト（E2Eレベル）

---

### Epic 6: CLI基本コマンド

#### Story 6.1: CLIフレームワーク構築 [P0/M]

**依存**: Story 1.1
**見積もり**: 3-5h
**技術**: commander or yargs

**タスク**:

1. **[E6-S1-T1]** CLIフレームワーク選定 (S)
   - commander vs yargs検証
   - インストールと基本動作確認
   - 受け入れ: サンプルコマンド動作

2. **[E6-S1-T2]** CLIエントリーポイント (S)
   - `src/cli/index.ts`作成
   - shebang追加（`#!/usr/bin/env node`）
   - package.json bin設定
   - 受け入れ: `pnpm agent --help`動作

---

#### Story 6.2: `agent init` コマンド [P0/M]

**依存**: Story 6.1、Story 2.1
**見積もり**: 3-5h
**技術**: fs/promises、設定ファイル生成

**タスク**:

1. **[E6-S2-T1]** 設定ファイル生成 (M)
   - `src/cli/commands/init.ts`作成
   - `.agent/config.json`生成（app-repo path、agent-coord path）
   - agent-coord repoディレクトリ構造作成（tasks/、runs/、checks/）
   - 受け入れ: `agent init`実行成功、設定ファイル確認

2. **[E6-S2-T2]** 初期化検証 (S)
   - 既存設定ファイルチェック
   - 上書き確認プロンプト
   - 受け入れ: 再実行時の動作確認

---

#### Story 6.3: `agent run` コマンド [P0/M]

**依存**: Story 6.1、Story 5.2
**見積もり**: 3-5h
**技術**: Orchestrator統合

**タスク**:

1. **[E6-S3-T1]** runコマンド実装 (M)
   - `src/cli/commands/run.ts`作成
   - 引数: `agent run "指示文"`
   - Orchestrator起動
   - 受け入れ: `agent run "Hello World"`実行成功

2. **[E6-S3-T2]** 進捗表示 (S)
   - 実行中のタスク状態をリアルタイム表示
   - 受け入れ: ログ出力確認

---

#### Story 6.4: `agent status` コマンド [P1/S]

**依存**: Story 6.1、Story 2.1
**見積もり**: 1-2h
**技術**: Task Store読み取り

**タスク**:

1. **[E6-S4-T1]** status表示 (S)
   - `src/cli/commands/status.ts`作成
   - 全タスク一覧表示（state、owner、branch）
   - worktree一覧表示
   - 受け入れ: `agent status`実行、一覧表示確認

---

#### Story 6.5: `agent stop` コマンド [P1/S]

**依存**: Story 6.1、Story 5.1
**見積もり**: 1-2h
**技術**: プロセス制御、タスク中断

**タスク**:

1. **[E6-S5-T1]** stop実装 (S)
   - `src/cli/commands/stop.ts`作成
   - 実行中タスクの中断（プロセスkill）
   - タスクstate更新（RUNNING→BLOCKED）
   - 受け入れ: `agent stop`実行、プロセス停止確認

---

### Epic 7: 統合テストとドキュメント

#### Story 7.1: E2Eテストシナリオ [P1/M]

**依存**: Story 6.3
**見積もり**: 3-5h
**技術**: node:test、サンプルプロジェクト

**タスク**:

1. **[E7-S1-T1]** サンプルプロジェクト作成 (S)
   - 簡単なTypeScriptプロジェクト（Hello World）
   - tests/fixtures/に配置
   - 受け入れ: サンプルプロジェクト動作確認

2. **[E7-S1-T2]** E2Eテスト実装 (M)
   - `agent init` → `agent run` → 結果確認
   - タスク生成→実行→完了の全フロー
   - 受け入れ: E2Eテスト通過

---

#### Story 7.2: READMEとドキュメント [P1/M]

**依存**: Story 6.3
**見積もり**: 3-5h
**技術**: Markdown

**タスク**:

1. **[E7-S2-T1]** README.md作成 (M)
   - プロジェクト概要
   - インストール手順
   - 使い方（agent init/run/status/stop）
   - アーキテクチャ概要
   - 受け入れ: README完成

2. **[E7-S2-T2]** アーキテクチャドキュメント (S)
   - docs/architecture.md作成
   - Planner/Worker/Judge説明
   - worktree運用説明
   - 受け入れ: ドキュメント完成

---

## 技術的リスク

| リスク                             | 優先度 | 影響度 | 対策                                                                      | ステータス    |
| ---------------------------------- | ------ | ------ | ------------------------------------------------------------------------- | ------------- |
| **CAS並行制御の理解不足**          | ~~P0~~ | ~~高~~ | **mkdirベースロック実装完了（2026-01-18）**                               | ✅ **解決**   |
| **Worktree操作の複雑度**           | P0     | 高     | git worktreeコマンド手動実験                                              | 🟡 要対策     |
| **Orchestrator状態機械の複雑度**   | P0     | 高     | シンプルな状態遷移から開始、段階的拡張                                    | 🟡 要対策     |
| **SDK利用方法の理解**              | ~~P0~~ | ~~高~~ | ~~各CLI手動実行で引数確認~~ **SDK利用に変更、検証完了（2026-01-18）**     | ✅ **解決**   |
| **Git操作のコンフリクト**          | P0     | 高     | Epic 5.2 T4でrebase戦略定義、リトライロジック実装                         | 🟡 要対策     |
| **エラーハンドリングの網羅性不足** | P1     | 中     | 初期は基本的なエラーのみ対応、Epic 5.2 T4で分類表作成                     | 🟡 要対策     |
| **依存パッケージの互換性**         | P1     | 中     | README.mdにSDK最小バージョン要件を明記（Claude: Node 18+、Codex: 0.87.0） | 🟡 要対策     |
| **ディスク容量**                   | P2     | 中     | worktree数の上限設定（デフォルト3、設定可能）                             | 🟢 許容       |
| **テストの不足**                   | ~~P2~~ | ~~低~~ | **ユニットテスト実装開始（2026-01-18、Epic 1-2カバー）**                  | ✅ **対応中** |

---

## 実装戦略

### 1. 動くMVP優先

- 完璧な設計より、まず動くものを作る
- エラーハンドリングは最小限でOK
- テストは手動で十分

### 2. 段階的実装

- 各Epicを完全に終わらせてから次へ
- 並列実装は避ける（開発者1名）
- デバッグ時間を十分確保

### 3. プロトタイプ先行

- CAS更新、worktree操作は小規模検証を先に実施
- Orchestratorは簡単な状態遷移から開始

### 4. ドキュメント後回し

- README.mdは最小限でOK
- 詳細ドキュメントはPhase 1完了後

---

## タスクサマリー

| Epic                 | Story数 | 総見積もり  | 優先度P0 Story数 |
| -------------------- | ------- | ----------- | ---------------- |
| Epic 1: 基盤         | 2       | 6-10h       | 2                |
| Epic 2: Task Store   | 2       | 7-10h       | 1                |
| Epic 3: VCS          | 2       | 12-16h      | 2                |
| Epic 4: Runner       | 3       | 10-16h      | 2                |
| Epic 5: Orchestrator | 2       | 1-4日       | 2                |
| Epic 6: CLI          | 5       | 10-16h      | 3                |
| Epic 7: 統合         | 2       | 6-10h       | 0                |
| **合計**             | **18**  | **2-4週間** | **12**           |

---

## クリティカルファイル（実装順）

1. [src/types/task.ts](src/types/task.ts) - タスク型定義の中核
2. [src/core/task-store/file-store.ts](src/core/task-store/file-store.ts) - JSONベースのタスク状態管理、CAS並行制御
3. [src/adapters/vcs/worktree-adapter.ts](src/adapters/vcs/worktree-adapter.ts) - worktree管理の中核
4. [src/core/runner/process-runner.ts](src/core/runner/process-runner.ts) - エージェント実行の基盤
5. [src/core/orchestrator/index.ts](src/core/orchestrator/index.ts) - Planner/Worker/Judge統合の中核

---

## 次のアクション

**Epic 3: VCS Adapter** から継続:

1. [E3-S1-T1] Gitライブラリ選定とセットアップ
2. [E3-S1-T2] Branch操作実装
3. [E3-S1-T3] Commit/Push操作実装
4. [E3-S1-T4] Status/Diff操作実装

---

## 実装ワークフロー指示

**重要**: 各エピック、ストーリー、タスク完了時に以下を必ず実施すること

### タスク完了時

- テストを実行して動作確認
- 型チェック（`pnpm build`）を実行

### ストーリー完了時

1. コードフォーマット適用（`pnpm format`）
2. コミット作成（Conventional Commits形式）
   - タイトル: `feat(epic番号): 概要`
   - 本文: Story完了内容の詳細
3. 必要に応じてドキュメント更新

### エピック完了時

1. この文書（initial-plan.md）の実装進捗を更新
2. README.mdの実装ステータスを更新
3. 技術的リスク表を更新
4. 統合テスト実施（可能な範囲で）
5. コミット作成（更新内容を反映）

### コミットメッセージ形式

```
<type>(<scope>): <subject>

<body>

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
```

**type**: feat, fix, refactor, test, docs, chore
**scope**: epic番号（epic1, epic2等）
