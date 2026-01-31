# ブランチクリーンアップ機能の設計

## ステータス

**Implemented** ✅

## 提案日時

2026-01-23

## 背景

オーケストレーション実行中に作成される統合ブランチ（`integration/*`）とタスクブランチは、ワークツリーが削除された後もローカル/リモートに残り続ける。これにより：

- リポジトリにゴミブランチが蓄積
- `git branch`の出力が煩雑になる
- 手動での掃除が必要

### 現状分析

| モード | 統合ブランチ | タスクブランチ | ワークツリー |
|--------|------------|--------------|-------------|
| PR | リモートに残る | 残る | 削除される |
| Command | ローカルに残る | 残る | 削除される |
| Auto | ff-merge後も残る | 残る | 削除される |
| finalize | ff-merge後も残る | 残る | - |

## 決定

2つのアプローチでブランチクリーンアップ機能を実装する：

### 1. `finalize` コマンドの拡張

正常完了時のブランチ削除。

```
--execute         ブランチ削除を実行（デフォルトはdry-run表示のみ）
--delete-remote   リモートブランチも削除
```

**削除対象**:
- 統合ブランチ（targetBranch）
- マージされたタスクブランチ（git履歴から検出）

### 2. `cleanup-branches` コマンドの新設

中断時や手動掃除用の専用コマンド。

```
agent cleanup-branches [options]

Options:
  --execute           実際に削除を実行（デフォルトはdry-run）
  --pattern <glob>    追加のパターンを指定
  --integration-only  統合ブランチのみ対象
  --task-only         タスクブランチのみ対象
  --delete-remote     リモートブランチも削除
```

**デフォルトパターン（自動適用）**:
- `integration/*`: 統合ブランチ
- タスクID形式: オーケストレーターが生成するタスクブランチ

## 設計決定

| 項目 | 決定 | 理由 |
|------|------|------|
| オプションパターン | `--execute`（dry-runがデフォルト） | 安全性重視、誤削除防止 |
| finalizeスコープ | 統合ブランチ + タスクブランチ | 完全なクリーンアップ |
| worktree | 残っていれば先に削除 | ブランチ削除の前提条件 |
| 保護ブランチ | main, master, develop, release/*, production | 重要ブランチの誤削除防止 |

## 検証方法

```bash
# dry-run（デフォルト）で確認
pnpm dev finalize --base main
pnpm dev cleanup-branches

# 実際に削除
pnpm dev finalize --base main --execute
pnpm dev cleanup-branches --execute
```

## 影響

- `finalize.ts`: オプション追加、削除ロジック統合
- `cleanup-branches.ts`: 新規作成
- `branch-cleanup.ts`: 共通ロジック新規作成
- `index.ts`: コマンド登録

## 代替案

1. **常に自動削除**: 安全性の懸念から却下
2. **PR/Commandモードにも統合**: スコープが大きくなるため将来対応
3. **専用コマンドのみ**: finalizeの一貫したワークフローを維持するため両方実装
