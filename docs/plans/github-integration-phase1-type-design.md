# GitHub連携 型定義設計（詳細版）

## 概要

本ドキュメントは、既存コードのスタイルに合わせたGitHub連携の型定義詳細を記述する。

- 既存パターン:
  - 設定: **Zod スキーマ**で定義
  - エラー: **`readonly type`パターン**のタグ付きユニオン型
  - エラーコンストラクタ: 各エラー型に対応する関数を定義

---

## 設定型（Zodスキーマ）

### `src/types/config.ts` への追加

```typescript
import { z } from 'zod';

/**
 * GitHub認証設定のスキーマ（フェーズ1: PATのみ）
 */
const GitHubAuthConfigSchema = z.object({
  /** 認証タイプ */
  type: z.literal('pat'),
  /** 環境変数名（例: GITHUB_TOKEN） */
  tokenEnvName: z.string(),
});

/**
 * GitHub設定のスキーマ
 */
const GitHubConfigSchema = z.object({
  /** APIベースURL（デフォルト: https://api.github.com） */
  apiBaseUrl: z.string().default('https://api.github.com'),
  /** リポジトリ所有者（org or user） */
  owner: z.string(),
  /** リポジトリ名 */
  repo: z.string(),
  /** 認証設定 */
  auth: GitHubAuthConfigSchema,
});

/**
 * プロジェクト設定のスキーマ定義（拡張版）
 */
export const ConfigSchema = z.object({
  // ... 既存フィールド

  /** GitHub連携設定（オプショナル） */
  github: GitHubConfigSchema.optional(),
});

/**
 * GitHub設定の型
 */
export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;

/**
 * GitHub認証設定の型
 */
export type GitHubAuthConfig = z.infer<typeof GitHubAuthConfigSchema>;
```

### 設定例（`.agent/config.json`）

```json
{
  "appRepoPath": "/path/to/app-repo",
  "agentCoordPath": "/path/to/agent-coord",
  "maxWorkers": 3,
  "integration": {
    "method": "pr"
  },
  "github": {
    "apiBaseUrl": "https://api.github.com",
    "owner": "your-org",
    "repo": "your-repo",
    "auth": {
      "type": "pat",
      "tokenEnvName": "GITHUB_TOKEN"
    }
  }
}
```

---

## エラー型（タグ付きユニオン型）

### `src/types/errors.ts` への追加

```typescript
// ===== GitHub Errors =====

/**
 * GitHubエラーの型（タグ付きユニオン型）
 */
export type GitHubError =
  | GitHubAuthFailedError
  | GitHubRateLimitedError
  | GitHubNotFoundError
  | GitHubValidationError
  | GitHubUnknownError;

/**
 * 認証失敗（トークン未設定、無効なトークン）
 */
export interface GitHubAuthFailedError {
  readonly type: 'GitHubAuthFailedError';
  /** 環境変数名が未設定の場合に記録 */
  readonly missingEnvName?: string;
  readonly message: string;
}

/**
 * レート制限到達
 */
export interface GitHubRateLimitedError {
  readonly type: 'GitHubRateLimitedError';
  /** リセット時刻（UNIX timestamp秒） */
  readonly resetAt?: number;
  /** 残りリクエスト数 */
  readonly remaining?: number;
  readonly message: string;
}

/**
 * リソース未存在（リポジトリ、ブランチ、PRなど）
 */
export interface GitHubNotFoundError {
  readonly type: 'GitHubNotFoundError';
  /** 見つからなかったリソース種別 */
  readonly resourceType: 'repository' | 'branch' | 'pullRequest';
  readonly message: string;
}

/**
 * 入力検証エラー（PR作成パラメータ不正など）
 */
export interface GitHubValidationError {
  readonly type: 'GitHubValidationError';
  /** 検証失敗したフィールド */
  readonly field?: string;
  readonly message: string;
}

/**
 * 予期しないGitHubエラー
 */
export interface GitHubUnknownError {
  readonly type: 'GitHubUnknownError';
  /** HTTPステータスコード */
  readonly statusCode?: number;
  /** 元のエラーメッセージ */
  readonly originalError?: string;
  readonly message: string;
}

// ===== GitHubError コンストラクタ =====

/**
 * 認証失敗エラーを生成
 */
export const githubAuthFailed = (
  message: string,
  missingEnvName?: string,
): GitHubAuthFailedError => ({
  type: 'GitHubAuthFailedError',
  missingEnvName,
  message,
});

/**
 * レート制限エラーを生成
 */
export const githubRateLimited = (
  message: string,
  resetAt?: number,
  remaining?: number,
): GitHubRateLimitedError => ({
  type: 'GitHubRateLimitedError',
  resetAt,
  remaining,
  message,
});

/**
 * リソース未存在エラーを生成
 */
export const githubNotFound = (
  resourceType: 'repository' | 'branch' | 'pullRequest',
  message: string,
): GitHubNotFoundError => ({
  type: 'GitHubNotFoundError',
  resourceType,
  message,
});

/**
 * 入力検証エラーを生成
 */
export const githubValidationError = (message: string, field?: string): GitHubValidationError => ({
  type: 'GitHubValidationError',
  field,
  message,
});

/**
 * 予期しないGitHubエラーを生成
 */
export const githubUnknownError = (
  message: string,
  statusCode?: number,
  originalError?: string,
): GitHubUnknownError => ({
  type: 'GitHubUnknownError',
  statusCode,
  originalError,
  message,
});
```

---

## GitHub型定義

### `src/types/github.ts` （新規作成）

```typescript
import type { Result } from 'option-t/plain_result';
import type { GitHubConfig } from './config.ts';
import type { GitHubError } from './errors.ts';

/**
 * PR作成入力
 */
export interface CreatePullRequestInput {
  config: GitHubConfig;
  /** PRタイトル */
  title: string;
  /** PR本文 */
  body: string;
  /** ソースブランチ（head） */
  head: string;
  /** ターゲットブランチ（base） */
  base: string;
  /** ドラフトPRとして作成するか */
  draft?: boolean;
}

/**
 * PR情報（GitHub API応答）
 */
export interface PullRequest {
  /** PR ID */
  readonly id: number;
  /** PR番号 */
  readonly number: number;
  /** PR URL（html_url） */
  readonly url: string;
  /** PRの状態 */
  readonly state: 'open' | 'closed';
  /** headブランチ */
  readonly headRef: string;
  /** baseブランチ */
  readonly baseRef: string;
  /** 作成日時（ISO 8601） */
  readonly createdAt: string;
  /** 更新日時（ISO 8601） */
  readonly updatedAt: string;
}

/**
 * GitHubEffectsインターフェース（フェーズ1: PR作成のみ）
 */
export interface GitHubEffects {
  /**
   * Pull Requestを作成する
   *
   * @returns Result<PullRequest, GitHubError>
   */
  createPullRequest(input: CreatePullRequestInput): Promise<Result<PullRequest, GitHubError>>;
}
```

---

## 既存型の変更なし

### `src/types/integration.ts`

既存の`IntegrationFinalResult`型は変更不要。

```typescript
export type IntegrationFinalResult =
  | {
      readonly method: 'pr';
      readonly prUrl: string;
    }
  | {
      readonly method: 'command';
      readonly mergeCommand: string;
    };
```

- `method: 'pr'`のとき、`prUrl`フィールドが存在
- PR作成成功時に`prUrl`を格納する

---

## 型使用例

### 設定読み込み

```typescript
import { ConfigSchema } from './types/config.ts';

const configJson = JSON.parse(await readFile('.agent/config.json', 'utf-8'));
const config = ConfigSchema.parse(configJson);

if (config.github) {
  console.log(`GitHub: ${config.github.owner}/${config.github.repo}`);
  console.log(`Auth: ${config.github.auth.tokenEnvName}`);
}
```

### エラーハンドリング

```typescript
import { githubAuthFailed, githubNotFound } from './types/errors.ts';
import { createErr } from 'option-t/result';

// トークン未設定の場合
const token = process.env['GITHUB_TOKEN'];
if (!token) {
  return createErr(githubAuthFailed('環境変数 GITHUB_TOKEN が設定されていません', 'GITHUB_TOKEN'));
}

// リポジトリ未存在の場合
if (response.status === 404) {
  return createErr(githubNotFound('repository', 'リポジトリが見つかりません'));
}
```

### PR作成とResult型

```typescript
import { githubEffects } from './adapters/github/index.ts';
import { isErr } from 'option-t/plain_result';

const result = await githubEffects.createPullRequest({
  config: githubConfig,
  title: 'Add new feature',
  body: 'This PR adds...',
  head: 'feature-branch',
  base: 'main',
});

if (isErr(result)) {
  console.error(`PR作成失敗: ${result.err.type} - ${result.err.message}`);
} else {
  console.log(`PR作成成功: ${result.val.url}`);
}
```

---

## 型安全性の保証

### 1. 設定の検証

- Zodスキーマによる実行時検証
- JSON読み込み時に型エラーを即座に検出

### 2. エラーの網羅性

- タグ付きユニオン型により、`switch`文で全ケースをカバー
- TypeScriptの exhaustiveness check が機能

```typescript
function handleGitHubError(error: GitHubError): string {
  switch (error.type) {
    case 'GitHubAuthFailedError':
      return `認証失敗: ${error.message}`;
    case 'GitHubRateLimitedError':
      return `レート制限: ${error.message} (reset at ${error.resetAt})`;
    case 'GitHubNotFoundError':
      return `未存在: ${error.resourceType} - ${error.message}`;
    case 'GitHubValidationError':
      return `検証失敗: ${error.message}`;
    case 'GitHubUnknownError':
      return `予期しないエラー: ${error.message}`;
    // TypeScriptがすべてのケースをカバーしていることを保証
  }
}
```

### 3. IntegrationFinalResultの型安全性

- discriminated unionにより、`method`に応じて適切なフィールドのみが存在
- `method: 'pr'`のとき、`prUrl`は必須
- `method: 'command'`のとき、`mergeCommand`は必須

---

## まとめ

- **設定**: Zodスキーマで定義し、実行時検証を実施
- **エラー**: `readonly type`パターンのタグ付きユニオン型、コンストラクタ関数を提供
- **GitHub型**: `option-t`の`Result<T, E>`型と組み合わせて、型安全なエラーハンドリングを実現
