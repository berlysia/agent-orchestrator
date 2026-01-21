# GitHub連携実装計画（フェーズ1: PR作成）

## 決定事項

| 項目       | 決定                                         |
| ---------- | -------------------------------------------- |
| スコープ   | フェーズ1のみ（PR作成）                      |
| 認証       | PAT（環境変数から読み込み）                  |
| API        | REST API（Octokit使用）                      |
| 既存PR検出 | なし（新規作成のみ）                         |
| レート制限 | エラーとして返す（リトライなし）             |
| 設定       | `.agent/config.json`に`github`セクション追加 |

## 実装順序

### Step 1: 型定義の追加

**ファイル: `src/types/errors.ts`**

GitHubError型をタグ付きユニオンとして追加:

- `GitHubAuthFailedError` - 認証失敗
- `GitHubRateLimitedError` - レート制限
- `GitHubNotFoundError` - リソース未存在
- `GitHubValidationError` - 入力検証失敗
- `GitHubUnknownError` - その他

各エラーのコンストラクタ関数も追加。

**ファイル: `src/types/config.ts`**

Zodスキーマに追加:

- `GitHubAuthConfigSchema` - `{ type: 'pat', tokenEnvName: string }`
- `GitHubConfigSchema` - `{ apiBaseUrl, owner, repo, auth }`
- `ConfigSchema`に`github?: GitHubConfig`を追加

**ファイル: `src/types/github.ts`（新規）**

- `CreatePullRequestInput` - PR作成入力
- `PullRequest` - PR情報（API応答）
- `GitHubEffects` - インターフェース（createPullRequestメソッド）

### Step 2: GitHubアダプタの実装

**ファイル構成:**

```
src/adapters/github/
├── index.ts           # エクスポート、GitHubEffects生成
├── client.ts          # Octokitクライアント生成
├── pull-request.ts    # PR作成実装
└── error.ts           # エラー分類ロジック
```

**error.ts**: HTTPステータスからエラー種別を判定

- 401/403 → `GitHubAuthFailedError`
- 429 → `GitHubRateLimitedError`
- 404 → `GitHubNotFoundError`
- 422 → `GitHubValidationError`
- その他 → `GitHubUnknownError`

**client.ts**: 環境変数からトークン取得、Octokitインスタンス生成

**pull-request.ts**: `octokit.rest.pulls.create()`を呼び出し、Result型で返却

**index.ts**: `createGitHubEffects()`関数でGitHubEffects実装を提供

### Step 3: Orchestrator統合

**ファイル: `src/types/errors.ts`**

- `OrchestratorError`のユニオンに`GitHubError`を追加

**ファイル: `src/core/orchestrator/integration-operations.ts`**

修正箇所（行728付近）:

1. `IntegrationDeps`に`githubEffects?: GitHubEffects`を追加
2. `PullRequestInfo`型を追加（title, body を渡すため）
3. `finalizeIntegration`の処理フロー:
   - リモートプッシュ（`gitEffects.push`）
   - PR作成（`githubEffects.createPullRequest`）
   - 成功時のみ`{ method: 'pr', prUrl }`を返却
   - エラー時は`Result.Err`（`GitHubError`）を返却

**重要**: `IntegrationFinalResult`の`method: 'pr'`は`prUrl`が必須フィールドのため、
PR作成失敗時は`Result.Err`で返す（nullableにしない）

**ファイル: `src/core/orchestrator/orchestrate.ts`**

修正箇所:

1. **早期設定検証**: `method: 'pr'`なのに`config.github`未設定の場合、即座にエラー
2. GitHubEffectsのインスタンス生成（configにgithubがある場合のみ）
3. `IntegrationDeps`にgithubEffectsを渡す
4. **PullRequestInfo生成**: 統合結果からPRタイトル・本文を構築する`buildPullRequestInfo()`を追加

### Step 4: パッケージ追加

```bash
pnpm add @octokit/rest
```

## 修正対象ファイル一覧

| ファイル                                          | 操作                                        |
| ------------------------------------------------- | ------------------------------------------- |
| `src/types/errors.ts`                             | 追記（GitHubError型、OrchestratorError拡張）|
| `src/types/config.ts`                             | 追記（GitHubConfigスキーマ）                |
| `src/types/github.ts`                             | 新規作成                                    |
| `src/adapters/github/index.ts`                    | 新規作成                                    |
| `src/adapters/github/client.ts`                   | 新規作成                                    |
| `src/adapters/github/pull-request.ts`             | 新規作成                                    |
| `src/adapters/github/error.ts`                    | 新規作成                                    |
| `src/core/orchestrator/integration-operations.ts` | 修正（IntegrationDeps拡張、PR作成実装）     |
| `src/core/orchestrator/orchestrate.ts`            | 修正（GitHubEffects初期化）                 |
| `package.json`                                    | 追記（@octokit/rest）                       |

## 検証方法

### 1. 型チェック

```bash
pnpm typecheck
```

### 2. ビルド確認

```bash
pnpm build
```

### 3. ユニットテスト

`src/adapters/github/error.ts`のエラー分類ロジックをテスト:

```bash
pnpm test -- src/adapters/github/error.test.ts
```

### 4. 統合テスト（手動）

1. `.agent/config.json`に設定追加:

```json
{
  "github": {
    "owner": "test-org",
    "repo": "test-repo",
    "auth": { "type": "pat", "tokenEnvName": "GITHUB_TOKEN" }
  }
}
```

2. 環境変数設定:

```bash
export GITHUB_TOKEN="ghp_..."
```

3. Orchestrator実行し、PR作成を確認

### 5. エラーケース確認

- トークン未設定 → `GitHubAuthFailedError`
- 存在しないリポジトリ → `GitHubNotFoundError`
- 不正なブランチ名 → `GitHubValidationError`

## 詳細設計ドキュメント

以下のドキュメントに詳細設計を記載済み:

- `docs/plans/github-integration-phase1-implementation-plan.md` - 全体計画
- `docs/plans/github-integration-phase1-type-design.md` - 型定義詳細
