# マージ失敗時のエラーリカバリ

## ステータス

**Proposed** ⏳

582行目付近のコミット失敗時に `abortMerge()` が呼ばれていない問題が未修正。

## 選定日時

2026-01-23

## 選定結果

**コミット失敗時に `abortMerge()` を呼び出してMERGE_HEADをクリーンアップ**

## 背景・課題

### 問題点

署名失敗でコミットが失敗した後、次のマージで連鎖エラーが発生した。

```
⚠️  Failed to merge additional tasks: Git command failed: merge feature/progress-bar-task-d1f8b399-4 (exit code -1)
fatal: You have not concluded your merge (MERGE_HEAD exists).
Please, commit your changes before you merge.
```

### 根本原因

1. 統合worktreeでマージ実行
2. コミット時に1Passwordエラー（署名失敗）
3. **MERGE_HEADが残ったまま次のイテレーションへ**
4. 次のマージで `You have not concluded your merge` エラー

`mergeTasksInWorktree` 内の582行目付近で、コミット失敗時に `abortMerge()` が呼ばれていなかった。

## 修正内容

### コミット失敗時のMERGE_HEADクリーンアップ

```typescript
// 変更前
const commitResult = await gitEffects.commit(repo, commitMessage, { gpgSign: deps.config.commit.autoSignature });

if (isErr(commitResult)) {
  return createErr(commitResult.err);
}

// 変更後
const commitResult = await gitEffects.commit(repo, commitMessage, { gpgSign: deps.config.commit.autoSignature });

if (isErr(commitResult)) {
  // WHY: コミット失敗時はMERGE_HEADが残る可能性があるため、
  //      クリーンアップして次のマージに備える
  console.log(`  ❌ Commit failed, cleaning up merge state: ${commitResult.err.message}`);
  await gitEffects.abortMerge(repo);
  return createErr(commitResult.err);
}
```

### 既存の適切な実装の確認

以下の箇所は既に `abortMerge()` が呼ばれており、変更不要：

- 234-240行目: `integrateTasks` 内のコンフリクト解決コミット
- 666-680行目: `mergeTasksInWorktree` 内の自動解決コミット

## 変更対象ファイル

| ファイル | 変更内容 |
|---|---|
| `src/core/orchestrator/integration-operations.ts` | 582行目付近にabortMerge追加 |

## テスト計画

1. 582行目のコミット失敗時に `abortMerge()` が呼ばれること
2. `abortMerge()` 後にMERGE_HEADが存在しないこと
3. 次のマージが正常に開始できること

## 関連ADR

- [ADR-015: 統合worktree内コミットの署名制御](015-integration-worktree-signature-control.md) - 根本原因の修正
- [ADR-017: 統合結果の可視化](017-integration-result-visibility.md)
