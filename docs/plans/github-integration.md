# GitHub統合計画

## 目的

- 開発フローの要所（PR、コメント、チェック、Actions結果）をGitHub上で可視化し、Agent Orchestratorの実行結果を一貫して追跡できるようにする。
- Worker/Judgeの出力をGitHubの標準UIに接続し、開発者の確認コストを下げる。
- 将来の自動化（自動PR作成・再実行）に耐える最小限のAPI連携基盤を用意する。

## 非目標

- 既存のGitHub UI/通知体験の大規模な置き換え。
- マージ/リリース/Issue管理など、PRサイクル外の広範な自動化。
- すべてのGitHub機能の網羅（Projects、Wiki、Discussionsなど）。
- GitHub Actionsの実行制御（今回は参照のみ）。

## 認証方式

### 1. Personal Access Token (PAT)

- 目的: 個人開発・検証環境の最小構成。
- 要求権限の例:
  - `pull_requests: write`（PR作成・更新）
  - `contents: read`（リポジトリ基本情報）
  - `issues: write`（コメント投稿）
  - `checks: write` / `statuses: write`（チェック・ステータス更新）
  - `actions: read`（Workflow実行結果参照）
- 取り扱い: トークンは平文保存を避け、環境変数または`.agent`配下の別ファイルで管理する。

### 2. GitHub App

- 目的: チーム/組織運用、権限の最小化、監査可能性を重視する環境。
- 必要情報:
  - `appId`
  - `installationId`
  - `privateKey`（PEM、ファイルパス指定）
- フロー:
  1) AppのJWTを生成
  2) Installation Tokenを発行
  3) API呼び出しに使用

## 主要ユースケース

### PR作成

- Workerの成果物をPRとして作成し、タイトル・本文・ラベル等を設定する。
- 既存PRがある場合は更新（説明文やラベルの差し替え）。

### コメント

- PR/Issueに対して、実行ログの要約やエラー詳細をコメントで通知する。
- 追加のログはリンクのみを掲載し、本文は簡潔に保つ。

### チェック / ステータス

- Judge結果をGitHub ChecksまたはCommit Statusとして記録する。
- 失敗時は「どのチェックが失敗したか」「再実行の推奨」を明記する。

### Actions参照

- PRに紐づくWorkflow Runの結果を取得し、Judgeが参照できるようにする。
- 実行ID、結論（success/failure）、ログURLを取得する。

## 失敗時の再試行 / レート制限方針

- 再試行対象:
  - 一時的なネットワークエラー
  - 5xx系エラー
  - GitHub APIのSecondary Rate Limit（`Retry-After`が付く場合）
- 再試行しない対象:
  - 4xxの認証・権限エラー
  - リクエスト内容の検証エラー
- バックオフ方針:
  - Exponential backoff + jitter（例: 1s → 2s → 4s → 8s）
  - `Retry-After`がある場合は最優先で尊重
- レート制限時の挙動:
  - リミット残量/リセット時刻をログに記録
  - タスクを`BLOCKED`に遷移し、再実行タイミングを明示する

## 設定項目（案）

`.agent/config.json`でGitHub連携を設定する前提とする。

```json
{
  "github": {
    "apiBaseUrl": "https://api.github.com",
    "owner": "org-or-user",
    "repo": "repo-name",
    "auth": {
      "type": "pat",
      "token": "${GITHUB_TOKEN}"
    }
  }
}
```

GitHub Appを使う場合の例:

```json
{
  "github": {
    "apiBaseUrl": "https://api.github.com",
    "owner": "org-or-user",
    "repo": "repo-name",
    "auth": {
      "type": "app",
      "appId": 12345,
      "installationId": 67890,
      "privateKeyPath": ".agent/github-app.pem"
    }
  }
}
```

## アダプター位置付け

- 実装場所: `src/adapters/github/`
- 役割: GitHub APIの抽象化（認証、API呼び出し、エラー分類、レート制御）
- 利用元: Orchestrator / Judge / CLIから、PR作成やチェック更新のために呼び出す
