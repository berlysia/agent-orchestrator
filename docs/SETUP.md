# Agent Orchestrator セットアップガイド

このガイドでは、Agent Orchestrator を自分自身の開発に使用する（dogfooding）ためのセットアップ方法を説明します。

## 前提条件

- Node.js >= 24.13.0
- pnpm >= 9.15.4
- Git

## 重要な設計原則

Agent Orchestrator を使って自分自身を開発する場合、**実行中のランタイムが編集されないように**ランタイムとapp-repoを分離する必要があります。

### ディレクトリ構成

```
/home/berlysia/workspace/
├── agent-orchestorator/              # app-repo（開発対象）
│   ├── src/                          # Workerがここを編集
│   ├── dist/                         # コンパイル済みランタイム
│   └── .agent/config.json
│
└── agent-orchestorator-coord/        # agent-coord（タスク管理）
    ├── tasks/                        # タスク状態JSON
    ├── runs/                         # 実行ログ
    └── checks/                       # CI/Lint結果
```

## セットアップ手順

### 1. プロジェクトのビルド

```bash
cd /home/berlysia/workspace/agent-orchestorator
pnpm install
pnpm compile
```

### 2. agent-coord リポジトリの作成

```bash
cd /home/berlysia/workspace
mkdir agent-orchestorator-coord
cd agent-orchestorator-coord
git init
```

### 3. Agent Orchestrator の初期化

```bash
cd /home/berlysia/workspace/agent-orchestorator
node dist/cli/index.js init \
  --app-repo . \
  --agent-coord ../agent-orchestorator-coord \
  --force
```

**Note**: パスは相対パスで指定できます。相対パスは`.agent/config.json`が配置されるディレクトリ（app-repoルート）を基準に解決されます。

### GitHub連携の設定（オプション）

GitHub連携は `src/adapters/github/` が担当する想定です（計画中）。設定は `.agent/config.json` に追加します。

PATを使う例:

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

GitHub Appを使う例:

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

### 4. エイリアスの設定（推奨）

`~/.zshrc` または `~/.bashrc` に以下を追加：

```bash
alias agent='node /home/berlysia/workspace/agent-orchestorator/dist/cli/index.js'
```

設定を反映：

```bash
source ~/.zshrc  # または source ~/.bashrc
```

### 5. 動作確認

```bash
agent status
```

以下のような出力が表示されれば成功です：

```
================================================================================
Task Status (0 tasks)
================================================================================

  No tasks found.

Run 'agent run "<instruction>"' to create tasks.
```

## グローバルインストール（オプション）

新しいシェルセッションで以下を実行すると、グローバルにインストールできます：

```bash
cd /home/berlysia/workspace/agent-orchestorator
npm install -g .
```

これにより、どのディレクトリからでも `agent` コマンドが使用できるようになります。

## 使用方法

### タスクの実行

```bash
agent run "指示文"
```

例：

```bash
agent run "src/types/task.ts に新しいフィールド `priority` を追加する"
```

### 進捗確認

```bash
agent status
```

### タスクの中断

```bash
agent stop
```

## ランタイムの更新

開発対象のコードを更新した後、ランタイムを再コンパイルする必要があります：

```bash
cd /home/berlysia/workspace/agent-orchestorator
pnpm compile

# グローバルインストールしている場合は再インストール
npm install -g .
```

## トラブルシューティング

### `agent` コマンドが見つからない

1. エイリアスが設定されているか確認：

   ```bash
   alias | grep agent
   ```

2. `dist/cli/index.js` が存在するか確認：

   ```bash
   ls -la dist/cli/index.js
   ```

3. 直接実行してみる：
   ```bash
   node dist/cli/index.js --version
   ```

### ランタイムが古いコードを実行している

```bash
cd /home/berlysia/workspace/agent-orchestorator
pnpm compile
```

グローバルインストールしている場合は再インストール：

```bash
npm install -g .
```

## 参考資料

- [アーキテクチャドキュメント](architecture.md)
- [初期開発計画](plans/initial-plan.md)
