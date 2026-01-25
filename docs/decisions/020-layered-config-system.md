# ADR-020: 階層化コンフィグシステム

## ステータス

**Accepted** ✅

## 提案日時

2026-01-26

## 背景

現在のAgent Orchestratorは単一の設定ファイル（`.agent/config.json`）のみをサポートしている。これにより以下の課題がある：

- **ユーザー固有のデフォルト設定が持てない**: 複数プロジェクトで共通の設定（例: 好みのモデル、maxWorkers）を毎回設定する必要がある
- **秘匿情報の管理が困難**: GitHub トークンなどをプロジェクト設定に含めるとgit管理の対象になってしまう
- **設定の出所が不透明**: 最終的な設定値がどこから来ているか確認する手段がない

## 決定

4階層の設定ファイル構成と、設定値の出所追跡機能を導入する。

### 1. 4階層構成

| 優先度 | 階層名 | ファイルパス | 用途 |
|--------|--------|-------------|------|
| 4 (最高) | project-local | `<project>/.agent/config.local.json` | プロジェクト固有の上書き（gitignore） |
| 3 | project | `<project>/.agent/config.json` | プロジェクト設定（git管理） |
| 2 | global-local | `~/.agent/config.local.json` | ユーザーローカル上書き（秘匿情報） |
| 1 (最低) | global | `~/.agent/config.json` | ユーザーデフォルト設定 |

### 2. マージ仕様

**深いマージ（Deep Merge）**:
- オブジェクト: 再帰的にマージ
- 配列: 上位階層で完全置換
- プリミティブ: 上位階層が優先

**特殊記法**:

#### `$reset` - 継承のキャンセル

`{ "$reset": true }` でその階層の値を無視し、下位優先度の階層から再計算：

```json
// project-localでchecks.commandsをリセット
// → project → global-local → global の順で最初に見つかった値を使用
{
  "checks": {
    "commands": { "$reset": true }
  }
}
```

**仕様**:
- 値との共存禁止（`{ "$reset": true }` のみ許可）
- マージ時に消費され、Zodバリデーション前に除去

#### `$replace` - 完全置換（マージしない）

`{ "$replace": {...} }` で継承をキャンセルしつつ新しい値を設定：

```json
// globalのchecksを継承せず、プロジェクトで完全に置き換える
{
  "checks": {
    "$replace": {
      "enabled": false,
      "commands": ["pnpm test"]
    }
  }
}
```

**仕様**:
- 値を含む必要あり（`{ "$replace": <value> }` の形式）
- マージ時に消費され、Zodバリデーション前に除去

**パス解決**: 各階層で定義された相対パスは、その設定ファイルの親ディレクトリを基準に解決する。

### 3. CLIコマンド

| コマンド | 説明 |
|---------|------|
| `agent config show [key]` | 設定値の表示（`--with-source`で出所表示） |
| `agent config set <key> [value]` | 設定値の変更（`--layer`で階層指定） |
| `agent config unset <key>` | 設定値の削除 |
| `agent config edit` | エディタで編集 |
| `agent config validate` | 設定の検証 |

### 4. 後方互換性

| API | 動作 |
|-----|------|
| `loadConfig()` | 階層化ロードを内部で使用（戻り値の型は変更なし） |
| `loadConfig(path)` | 明示的パス指定時は**そのファイルのみ**読み込み（従来動作維持） |
| `loadTrackedConfig()` | **新API** - 階層化ロード＋出所追跡 |

## 設計決定

| 項目 | 決定 | 理由 |
|------|------|------|
| 階層数 | 4階層 | グローバル/プロジェクト各レベルでローカル上書きを許容 |
| マージ方式 | 深いマージ | ネストした設定の部分的な上書きを可能にする |
| `$reset`記法 | 継承キャンセル | 下位優先度から再計算、値との共存禁止 |
| `$replace`記法 | 完全置換 | マージせず指定値で置換、値を含む必要あり |
| 配列のマージ | 完全置換 | 配列の部分マージは複雑で予測困難 |
| パス解決 | 各階層のファイル位置基準 | 相対パスの一貫した解釈 |
| loadConfig(path) | 指定ファイルのみ | 従来動作の後方互換維持 |
| 後方互換 | loadConfig()の内部変更 | 既存コードの変更を最小限に |

## 検証方法

```bash
# 階層化読み込み
mkdir -p ~/.agent
echo '{"maxWorkers": 2}' > ~/.agent/config.json
agent config show --with-source

# 設定の変更
agent config set maxWorkers 5
agent config set --layer global "agents.worker.model" "claude-sonnet-4-5"

# 既存コマンドの後方互換
agent run "test task"
agent status
```

## 影響

### 新規ファイル
- `src/types/layered-config.ts` - 型定義
- `src/cli/utils/layered-config.ts` - マージロジック
- `src/cli/commands/config.ts` - CLIコマンド
- `tests/unit/layered-config.test.ts` - ユニットテスト

### 変更ファイル
- `src/cli/utils/load-config.ts` - 内部で階層化ロード呼び出し
- `src/cli/index.ts` - configコマンド登録
- `src/cli/commands/init.ts` - `--global`オプション追加
- `src/types/errors.ts` - ConfigError型追加
- `.gitignore` - `*.local.json`パターン追加

### 後方互換性

既存の`loadConfig()`呼び出しは引き続き動作する：
- 引数なし: 階層化ロードを使用（新動作）
- 引数あり: 指定ファイルのみ読み込み（従来動作）

既存のテストやコードは変更不要。

## 代替案

1. **環境変数のみ**: 構造化された設定には不向き、却下
2. **2階層（グローバル/プロジェクト）**: ローカル上書きの需要があるため4階層を採用
3. **YAMLフォーマット**: 既存のJSONスキーマとの整合性を優先しJSONを継続
4. **配列のマージ戦略を設定可能に**: 複雑性が増すため初期実装では完全置換のみ

## 参考リンク

- [config-schema.json](.agent/config-schema.json)
- [Architecture Document](../architecture.md)

## 実装チェックリスト

- [x] 型定義の作成（layered-config.ts, errors.ts拡張）
- [x] コアロジックの実装（deepMerge, 出所追跡, 特殊記法）
- [x] 後方互換性維持（load-config.ts変更）
- [x] CLIコマンドの実装（config.ts）
- [x] コマンド登録（index.ts）
- [x] init.ts拡張（--globalオプション）
- [x] .gitignore更新（*.local.json）
- [x] ユニットテストの作成
- [x] ADR文書の作成
