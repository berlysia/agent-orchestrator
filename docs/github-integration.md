# GitHub Integration

Agent OrchestratorのGitHub統合機能について説明します。

## 概要

タスク完了後の統合フェーズで、GitHub Pull Requestを自動作成できます。

## 前提条件

- GitHubリポジトリがリモートに存在すること
- Personal Access Token (PAT) が発行されていること

## セットアップ

### 1. Personal Access Tokenの発行

GitHub Settings > Developer settings > Personal access tokens から、以下の権限を持つトークンを発行してください：

- `repo` (Full control of private repositories)

### 2. 環境変数の設定

発行したトークンを環境変数に設定します：

```bash
export GITHUB_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"
```

### 3. 設定ファイルの編集

`.agent/config.json` に以下を追加します：

```json
{
  "integration": {
    "method": "pr"
  },
  "github": {
    "owner": "your-org",
    "repo": "your-repo",
    "auth": {
      "type": "pat",
      "tokenEnvName": "GITHUB_TOKEN"
    }
  }
}
```

## 設定オプション

### integration.method

統合方法を指定します：

| 値 | 動作 |
|----|------|
| `auto` | ローカルでrebase + fast-forward merge（デフォルト） |
| `command` | マージコマンドを出力（手動実行用） |
| `pr` | GitHub PRを作成 |

### github

| 項目 | 必須 | 説明 |
|------|------|------|
| `apiBaseUrl` | No | GitHub API URL（デフォルト: `https://api.github.com`） |
| `owner` | Yes | リポジトリオーナー（組織名またはユーザー名） |
| `repo` | Yes | リポジトリ名 |
| `auth.type` | Yes | 認証タイプ（現在は `pat` のみ） |
| `auth.tokenEnvName` | Yes | トークンを格納する環境変数名 |

## 使用例

```bash
# タスクを実行（完了後に自動でPRが作成される）
agent run "Add user authentication feature"
```

統合フェーズで以下が実行されます：

1. 統合ブランチをリモートにpush
2. GitHub APIでPull Requestを作成
3. 作成されたPRのURLを表示

## トラブルシューティング

### 認証エラー

```
GitHubEffects is not configured
```

→ `github` 設定が `.agent/config.json` に存在するか確認してください。

```
GitHub authentication failed
```

→ 環境変数 `GITHUB_TOKEN` が正しく設定されているか確認してください。

### 権限エラー

```
GitHub permission denied
```

→ トークンに `repo` 権限があるか確認してください。

### リモートが見つからない

```
PR creation requires a remote repository
```

→ `git remote -v` でリモートが設定されているか確認してください。
