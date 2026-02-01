# ADR-029: GitHub Issue連携（Issue駆動タスク実行）

## Status

Implemented

## Context

現在、タスクはCLI引数またはインタラクティブ入力で指定する：

```bash
agent run "認証機能を追加する"
agent plan  # インタラクティブ
```

GitHub Issueをタスクソースとして直接使用できれば、以下のメリットがある：

1. **トレーサビリティ**: Issue→実装→PRの追跡が容易
2. **チーム連携**: Issue管理ワークフローとの統合
3. **自動化**: GitHub ActionsからIssueベースでタスク実行

## Decision

GitHub Issueを直接タスクソースとして使用できる機能を追加する。

### コマンド

```bash
# Issue番号指定
agent run "#123"
agent plan "#123"

# URL指定
agent run "https://github.com/owner/repo/issues/123"

# 複数Issue（将来）
agent run "#123" "#124" "#125"
```

### Issue解析

```typescript
interface ParsedIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  milestone?: string;
  linkedPRs: number[];
  comments: IssueComment[];
}
```

### タスク変換ルール

```
Issue Title: [feat] ログイン機能の実装
Issue Body:
  ## 要件
  - メールアドレス認証
  - パスワードリセット

  ## 受け入れ条件
  - ログインできること
  - ログアウトできること

↓ 変換

Task: "[feat] ログイン機能の実装

## 要件
- メールアドレス認証
- パスワードリセット

## 受け入れ条件
- ログインできること
- ログアウトできること"
```

### ラベルマッピング（オプション）

```yaml
# .agent/config.yaml
github:
  label_mapping:
    "priority: high": { priority: high }
    "type: bug": { workflow: bugfix }
    "type: feature": { workflow: default }
```

### 完了時アクション

タスク完了時に以下を実行（設定可能）：

1. **PR作成**: Issue参照付きでPR作成（既存機能）
2. **Issueコメント**: 進捗・結果をコメント投稿
3. **Issue更新**: ラベル追加（`in-progress` → `ready-for-review`）

```yaml
# .agent/config.yaml
github:
  on_complete:
    create_pr: true
    comment_on_issue: true
    update_labels:
      remove: ["in-progress"]
      add: ["ready-for-review"]
```

### API

```typescript
interface GitHubIssueSource {
  parseIssueRef(ref: string): Result<IssueRef, ParseError>;
  fetchIssue(ref: IssueRef): Promise<Result<ParsedIssue, GitHubError>>;
  convertToTask(issue: ParsedIssue): Task;
}

type IssueRef =
  | { type: 'number'; number: number }
  | { type: 'url'; owner: string; repo: string; number: number };
```

### gh CLI依存

GitHub APIアクセスには`gh` CLIを使用（認証管理を委譲）：

```bash
gh issue view 123 --json title,body,labels,comments
```

## Consequences

### Positive

- **トレーサビリティ**: Issue→タスク→PR→Mergeの追跡が容易
- **既存ワークフロー統合**: GitHub Projects/Actions連携
- **コンテキスト共有**: Issueのコメント・議論を参照可能

### Negative

- `gh` CLI依存（インストール必須）
- GitHub以外のプラットフォーム非対応（GitLab等は別ADR）
- Issue形式の標準化が必要（曖昧なIssueは実行困難）

### Neutral

- 既存のテキストベースタスク指定は維持

## Implementation

### Phase 1: 基本機能
1. Issue参照パーサー（`#N`、URL形式）
2. `gh issue view`によるIssue取得
3. `agent run "#N"`対応

### Phase 2: コンテキスト強化
1. コメント取得・統合
2. リンクされたPR/Issue参照
3. ラベルマッピング

### Phase 3: 完了時アクション
1. Issueへのコメント投稿
2. ラベル自動更新
3. PR作成時のIssue参照（`Closes #N`）

### Phase 4: 自動化
1. GitHub Actions連携
2. Issue作成時の自動トリガー（Webhook/Workflow）

## Security Considerations

- `gh` CLIの認証スコープに依存
- Private リポジトリアクセスには適切なトークン権限が必要
- Issue内容のサニタイズ（コードインジェクション防止）

## References

- [GitHub CLI - issue view](https://cli.github.com/manual/gh_issue_view)
