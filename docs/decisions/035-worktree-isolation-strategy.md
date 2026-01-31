# ADR-035: 作業ディレクトリ分離戦略（worktree選定）

## Status

Accepted

## Context

複数Workerの並列実行には、作業ディレクトリの分離が必要。各Workerが独立してファイルを編集できるようにするため、以下の選択肢を検討した。

### 選択肢

#### Option A: `git worktree`

同一リポジトリの複数ブランチを並列チェックアウト。

```bash
git worktree add ../task-001 -b task-001
git worktree add ../task-002 -b task-002
```

**特徴**:
- `.git`ディレクトリを共有（ディスク節約）
- 同一リポジトリとして管理
- ブランチ管理が容易

**制約**:
- 同一ブランチを複数worktreeで同時チェックアウト不可
- worktree削除には`git worktree remove`が必要

#### Option B: `git clone --shared`

別リポジトリとして扱うが、オブジェクトストアを共有。

```bash
git clone --shared /path/to/repo ../task-001
git clone --shared /path/to/repo ../task-002
```

**特徴**:
- 独立したリポジトリとして動作
- オブジェクトストアのみ共有（ディスク節約）
- `.git`は独立

**制約**:
- 削除時に共有オブジェクトの整合性に注意が必要
- `git gc`の取り扱いが複雑
- Claude Codeが`.git`を認識する際の問題なし（独立した`.git`）

#### Option C: 通常の`git clone`

完全に独立したクローン。

```bash
git clone /path/to/repo ../task-001
git clone /path/to/repo ../task-002
```

**特徴**:
- 完全に独立
- 管理がシンプル

**制約**:
- ディスク使用量が大きい
- クローン時間が長い

## Decision

**`git worktree`を採用する。**

### 選定理由

| 観点 | worktree | clone --shared | clone |
|------|----------|----------------|-------|
| ディスク効率 | ◎ | ○ | × |
| セットアップ速度 | ◎ | ○ | × |
| 管理のシンプルさ | ○ | △ | ◎ |
| 削除の容易さ | ○ | △ | ◎ |
| ブランチ管理 | ◎ | ○ | ○ |

**決定的な理由**:

1. **ディスク効率とセットアップ速度**: worktreeは既存の`.git`を共有するため、瞬時にセットアップ可能
2. **ブランチ管理**: 1タスク=1ブランチの制約（ADR-001）と相性が良い
3. **`git clone --shared`の複雑性回避**: 削除時の整合性管理、`git gc`の問題を回避

### 「同一ブランチ制約」への対応

worktreeは同一ブランチを複数箇所でチェックアウトできないが、以下の理由で問題にならない：

- **1タスク=1ブランチ**: ADR-001のCAS実装で、各タスクは固有のブランチを持つ
- **ブランチ名の一意性**: `task-{taskId}`形式で衝突を回避

### `git clone --shared`を選ばなかった理由

外部ツールの調査で`git clone --shared`の使用例を確認したが、以下の理由で不採用：

1. **Claude Codeの`.git`認識問題**: 外部ツールでは「git worktreeの`.git`ファイルがメインリポジトリを指すため、Claude Codeがメインリポジトリをプロジェクトルートと認識してしまう」問題が報告されていた
2. **当プロジェクトでの検証**: worktree使用時にこの問題は発生していない
3. **削除時の複雑性**: `git clone --shared`は削除時にオブジェクトの参照カウント管理が必要で、誤った削除で共有オブジェクトが破損するリスク

## Consequences

### Positive

- **高速なセットアップ**: worktree作成は瞬時
- **ディスク効率**: オブジェクトストアを共有
- **シンプルなブランチ管理**: 単一リポジトリ内で管理

### Negative

- **同一ブランチ制約**: 同じブランチを複数worktreeで使えない（設計上問題なし）
- **worktree管理コマンドの学習コスト**: `git worktree add/remove/list`

### Neutral

- 将来的に`git clone --shared`への移行も可能（インターフェースは抽象化済み）

## Implementation

実装済み（Epic 3）:

- `src/adapters/vcs/spawn-git-effects.ts`: worktree管理

```typescript
interface WorktreeEffects {
  createWorktree(taskId: TaskId, branch: string): Promise<Result<string, GitError>>;
  removeWorktree(path: string): Promise<Result<void, GitError>>;
  listWorktrees(): Promise<Result<Worktree[], GitError>>;
}
```

## References

- [ADR-001: CAS Implementation Approach](./001-cas-implementation-approach.md) - 1タスク=1ブランチ
- [ADR-015: Integration Worktree Signature Control](./015-integration-worktree-signature-control.md)
- [Git Worktree Documentation](https://git-scm.com/docs/git-worktree)
