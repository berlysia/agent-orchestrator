# ADR-036: エージェント権限モデル

## Status

Proposed

## Context

エージェント（Worker/Judge/Planner/Leader）がファイルを編集する際の権限管理が未定義。以下の懸念がある：

1. **セキュリティリスク**: エージェントが意図しないファイルを編集する可能性
2. **スコープ制御**: タスクに関係ないファイルへのアクセスを制限したい
3. **自動化と確認のバランス**: 完全自動化 vs. 毎回確認のトレードオフ

### 要件

- タスクスコープ外のファイル編集を防止
- 開発効率を損なわない適切な自動化
- セキュリティクリティカルな操作には確認を要求
- テスト環境での柔軟な権限緩和

## Decision

`permission_mode`設定を導入し、エージェントの権限レベルを制御する。

### 権限モード

```typescript
type PermissionMode =
  | 'manual'           // すべての編集を手動承認
  | 'acceptEdits'      // スコープ内の編集を自動承認
  | 'bypassPermissions'; // すべての権限チェックをスキップ（危険）
```

#### `manual`: 手動承認モード

```
すべてのファイル編集に対して確認を要求
```

**使用場面**:
- 本番環境に近い慎重な操作が必要な場合
- セキュリティ監査が必要な場合
- 初回実行時の動作確認

#### `acceptEdits`: 自動承認モード（推奨デフォルト）

```
タスクスコープ内の編集は自動承認
スコープ外の編集は拒否または確認
```

**スコープ判定**:
- タスク作成時に宣言された変更対象ファイル
- 依存関係から自動推論されたファイル
- 設定で許可されたパターン（例: `src/**/*.ts`）

**使用場面**:
- 通常の開発作業
- CI/CD環境での自動実行

#### `bypassPermissions`: 権限スキップモード（危険）

```
すべての権限チェックをスキップ
```

**使用場面**:
- テスト環境でのみ使用
- デバッグ目的

**警告**: 本番環境での使用は推奨しない

### スコープ定義

```typescript
interface TaskScope {
  // 明示的に許可されたファイル/パターン
  allowedPaths: string[];  // 例: ['src/auth/**', 'tests/auth/**']

  // 明示的に禁止されたファイル/パターン
  deniedPaths: string[];   // 例: ['.env', 'secrets/**']

  // 読み取り専用パス
  readOnlyPaths: string[]; // 例: ['node_modules/**', 'dist/**']
}
```

### 権限チェックフロー

```
┌─────────────────────────────────────────────────────────┐
│ エージェントがファイル編集を要求                          │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │ permission_mode確認    │
              └───────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
    ┌─────────┐    ┌───────────┐   ┌──────────────┐
    │ manual  │    │acceptEdits│   │bypassPerms   │
    └─────────┘    └───────────┘   └──────────────┘
          │               │               │
          ▼               ▼               ▼
    ┌─────────┐    ┌───────────┐   ┌──────────────┐
    │確認要求  │    │スコープ    │   │即座に許可    │
    │→承認/拒否│    │チェック    │   │              │
    └─────────┘    └───────────┘   └──────────────┘
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
        ┌──────────┐           ┌──────────┐
        │スコープ内 │           │スコープ外│
        │→自動許可 │           │→拒否     │
        └──────────┘           └──────────┘
```

### 設定

```yaml
# .agent/config.yaml
permissions:
  mode: acceptEdits  # manual | acceptEdits | bypassPermissions

  scope:
    allowed:
      - "src/**"
      - "tests/**"
      - "docs/**"
    denied:
      - ".env*"
      - "secrets/**"
      - "*.pem"
      - "*.key"
    readOnly:
      - "node_modules/**"
      - "dist/**"
      - ".git/**"

  # 特定エージェントの権限オーバーライド
  agents:
    worker:
      mode: acceptEdits
    judge:
      mode: manual  # Judgeは読み取り専用を推奨
    planner:
      mode: manual
```

### エージェント別のデフォルト権限

| エージェント | デフォルトモード | 理由 |
|-------------|-----------------|------|
| Worker | `acceptEdits` | 実装担当、ファイル編集が主務 |
| Judge | `manual` | 評価担当、編集は稀 |
| Planner | `manual` | 計画担当、通常は読み取りのみ |
| Leader | `manual` | 指揮担当、直接編集は避けるべき |

### API

```typescript
interface PermissionChecker {
  checkPermission(
    agent: AgentRole,
    action: 'read' | 'write' | 'delete',
    path: string
  ): Promise<PermissionResult>;
}

type PermissionResult =
  | { type: 'allowed' }
  | { type: 'denied'; reason: string }
  | { type: 'confirmation_required'; message: string };

// 使用例
const result = await permissionChecker.checkPermission(
  'worker',
  'write',
  'src/auth/service.ts'
);

if (result.type === 'denied') {
  throw new PermissionDeniedError(result.reason);
}
```

### セキュリティ考慮事項

#### 常に拒否されるパターン

以下のパターンは`bypassPermissions`モードでも拒否：

```typescript
const ALWAYS_DENIED = [
  '.git/**',           // Gitメタデータ
  '**/.env*',          // 環境変数
  '**/secrets/**',     // シークレット
  '**/*.pem',          // 証明書
  '**/*.key',          // 秘密鍵
  '**/credentials*',   // 認証情報
];
```

#### 監査ログ

すべてのファイル操作を記録：

```typescript
interface AuditLog {
  timestamp: string;
  agent: AgentRole;
  action: 'read' | 'write' | 'delete';
  path: string;
  result: 'allowed' | 'denied';
  permissionMode: PermissionMode;
}
```

## Consequences

### Positive

- **セキュリティ向上**: スコープ外の編集を防止
- **柔軟性**: 環境に応じた権限レベル選択
- **監査対応**: 操作ログによる追跡可能性

### Negative

- 権限チェックによるオーバーヘッド
- 設定の複雑性増加
- 偽陽性による正当な操作のブロックリスク

### Neutral

- デフォルト設定で多くのケースに対応可能
- 段階的に厳格化可能

## Implementation

### Phase 1: 基本権限チェック
1. `PermissionChecker` インターフェース定義
2. スコープベースの許可/拒否判定
3. Runner統合

### Phase 2: エージェント別設定
1. エージェントごとの権限オーバーライド
2. 設定ファイル読み込み

### Phase 3: 監査
1. 監査ログ出力
2. 権限違反アラート

## References

- [ADR-020: Layered Config System](./020-layered-config-system.md) - 設定階層
- [ADR-023: Agent Swarm Team Development](./023-agent-swarm-team-development.md) - エージェント役割
