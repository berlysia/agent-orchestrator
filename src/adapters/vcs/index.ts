/**
 * VCS アダプター統合エクスポート
 *
 * SimpleGitEffects と SpawnGitEffects を組み合わせて、
 * 完全な GitEffects インターフェースを提供する。
 */

import type { GitEffects } from './git-effects.ts';
import { createSimpleGitEffects } from './simple-git-effects.ts';
import { createSpawnGitEffects } from './spawn-git-effects.ts';

/**
 * 完全な GitEffects 実装を生成
 *
 * - simple-git: ブランチ操作、コミット、プッシュなど
 * - spawn: Worktree 操作（simple-git 非対応のため）
 *
 * @returns 完全な GitEffects インターフェース実装
 */
export const createGitEffects = (): GitEffects => {
  const simpleGit = createSimpleGitEffects();
  const spawnGit = createSpawnGitEffects();

  return {
    ...simpleGit,
    ...spawnGit,
  };
};

// 型やインターフェースの再エクスポート
export type {
  GitEffects,
  BranchInfo,
  GitStatus,
  WorktreeInfo,
} from './git-effects.ts';
