# 統合worktree内コミットの署名制御

## ステータス

**Accepted** ✅

## 選定日時

2026-01-23

## 選定結果

**統合worktree内のコミットは `autoSignature` を参照するよう修正**

`integrationSignature` はfinalizeコマンドのみに適用し、統合worktree内の自動コミットは `autoSignature` に従う。

## 背景・課題

### 問題点

オーケストレーション実行時に1Passwordエラーが発生し、統合worktree内のマージコミットが失敗した。

```
⚠️  Failed to merge tasks: Git command failed: commit (exit code -1)
error: 1Password: agent returned an error
fatal: failed to write commit object
```

### 根本原因

`integration-operations.ts` 内の5箇所で、統合worktree内のコミットが誤って `integrationSignature` を参照していた。

| 行 | コード | 問題 |
|---|---|---|
| 119 | `deps.config.commit.integrationSignature ? [] : ['--no-gpg-sign']` | マージオプション |
| 234 | `{ gpgSign: deps.config.commit.integrationSignature }` | コンフリクト解決コミット |
| 553-555 | `if (!deps.config.commit.integrationSignature) { ... '--no-gpg-sign' }` | worktreeマージ |
| 582 | `{ gpgSign: deps.config.commit.integrationSignature }` | worktree内コミット |
| 666 | `{ gpgSign: deps.config.commit.integrationSignature }` | 自動解決コミット |

### 設計意図との乖離

`config.ts` での設計意図：

| 設定 | 用途 | デフォルト |
|---|---|---|
| `autoSignature` | Worker/統合時の自動コミット | `false` |
| `integrationSignature` | Finalizeコマンドのみ | `true` |

`integrationSignature: true`（デフォルト）の場合、統合worktree内のマージコミットでもGPG署名が要求され、長時間実行中にユーザーが不在だと認証タイムアウトで失敗する。

## 修正内容

### 1. 署名制御の修正

5箇所すべてで `integrationSignature` → `autoSignature` に変更。

```typescript
// 変更前
const mergeOptions: string[] = deps.config.commit.integrationSignature ? [] : ['--no-gpg-sign'];

// 変更後
// NOTE: グローバルgit設定に依存しないよう、明示的に指定
const mergeOptions: string[] = deps.config.commit.autoSignature ? ['--gpg-sign'] : ['--no-gpg-sign'];
```

```typescript
// 変更前
const commitResult = await gitEffects.commit(repo, msg, { gpgSign: deps.config.commit.integrationSignature });

// 変更後
const commitResult = await gitEffects.commit(repo, msg, { gpgSign: deps.config.commit.autoSignature });
```

### 2. マージオプションの明示化

グローバルgit設定に依存しないよう、`--gpg-sign` / `--no-gpg-sign` を常に明示的に指定。

```typescript
// 変更前（グローバル設定依存）
if (!deps.config.commit.integrationSignature) {
  worktreeMergeOptions.push('--no-gpg-sign');
}

// 変更後（明示的指定）
worktreeMergeOptions.push(deps.config.commit.autoSignature ? '--gpg-sign' : '--no-gpg-sign');
```

### 3. 設定ドキュメントの明確化

`config.ts` のコメントで役割分担を明確化：

```typescript
/**
 * Worker実行時・統合worktree内の自動コミットでGPG署名を有効化
 *
 * - true: 自動コミットに署名を付与（ユーザーの常時監視が必要）
 * - false (default): 自動コミットは署名なし
 *
 * NOTE: 統合worktree内のマージコミットもこの設定に従う。
 */
autoSignature: z.boolean().default(false),

/**
 * Integration完了時（finalizeコマンド）の署名を有効化
 *
 * NOTE: このフラグはfinalizeコマンドのみに影響する。
 *       統合worktree内のコミットはautoSignatureを参照する。
 */
integrationSignature: z.boolean().default(true),
```

## 変更対象ファイル

| ファイル | 変更内容 |
|---|---|
| `src/core/orchestrator/integration-operations.ts` | 5箇所の署名制御修正 |
| `src/types/config.ts` | ドキュメント明確化 |

## 後方互換性

- 設定ファイルの変更は不要
- `autoSignature: false`（デフォルト）の環境では動作変更なし
- `autoSignature: true` かつ `integrationSignature: true` の場合のみ動作が変わる（稀なケース）

## 実装確認

`simple-git-effects.ts` の `commit` 関数は既にグローバル設定に依存しない実装：

```typescript
if (options?.gpgSign === true) {
  commitOptions = { '--gpg-sign': null };
} else if (options?.gpgSign === false || options?.noGpgSign) {
  commitOptions = { '--no-gpg-sign': null };
}
```

## 関連ADR

- [ADR-016: マージ失敗時のエラーリカバリ](016-merge-failure-error-recovery.md)
- [ADR-017: 統合結果の可視化](017-integration-result-visibility.md)
