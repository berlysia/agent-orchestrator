# ADR-027: NDJSONセッションログと継続性管理

## Status

Proposed

## Context

現在、Run/CheckはJSONファイルとして個別に保存される：

```
agent-coord/
  runs/<runId>.json
  checks/<checkId>.json
```

この方式の課題：

1. **クラッシュ耐性**: 処理中にクラッシュすると、途中経過が失われる
2. **リアルタイム監視**: ログを`tail -f`で監視できない
3. **セッション継続**: 前回セッションのコンテキスト引き継ぎが明示的でない
4. **ファイル数増加**: Run/Check毎にファイルが増える

## Decision

セッションログをNDJSON形式で記録し、ポインタファイルで継続性を管理する。

### ディレクトリ構造

```
agent-coord/
├── sessions/
│   ├── latest.json                    # 最新セッションへのポインタ
│   ├── previous.json                  # 前回セッションへのポインタ
│   └── {sessionId}.jsonl              # NDJSONログ
├── tasks/<taskId>.json                # タスク状態（既存）
└── .locks/<taskId>/                   # CASロック（既存）
```

### ポインタファイル形式

```json
{
  "sessionId": "planner-abc123",
  "startedAt": "2024-01-31T10:00:00Z",
  "status": "running"
}
```

### NDJSONレコード形式

```jsonl
{"type":"session_start","sessionId":"planner-abc123","timestamp":"...","task":"..."}
{"type":"phase_start","phase":"planning","timestamp":"..."}
{"type":"task_created","taskId":"task-001","title":"...","timestamp":"..."}
{"type":"phase_complete","phase":"planning","timestamp":"..."}
{"type":"worker_start","taskId":"task-001","workerId":"worker-1","timestamp":"..."}
{"type":"worker_complete","taskId":"task-001","status":"success","timestamp":"..."}
{"type":"judge_start","taskId":"task-001","timestamp":"..."}
{"type":"judge_complete","taskId":"task-001","verdict":"done","timestamp":"..."}
{"type":"session_complete","sessionId":"planner-abc123","timestamp":"...","summary":"..."}
```

### レコードタイプ

| Type | Description |
|------|-------------|
| `session_start` | セッション開始 |
| `session_complete` | セッション正常終了 |
| `session_abort` | セッション異常終了 |
| `phase_start` | フェーズ開始（planning/execution/integration） |
| `phase_complete` | フェーズ完了 |
| `task_created` | タスク作成 |
| `task_updated` | タスク状態更新 |
| `worker_start` | Worker実行開始 |
| `worker_complete` | Worker実行完了 |
| `judge_start` | Judge評価開始 |
| `judge_complete` | Judge評価完了 |
| `leader_decision` | Leader判断（ADR-024関連） |
| `error` | エラー発生 |

### API

```typescript
interface SessionLogger {
  start(sessionId: SessionId, task: string): Promise<void>;
  log(record: SessionLogRecord): Promise<void>;
  complete(summary: string): Promise<void>;
  abort(reason: string): Promise<void>;
}

interface SessionPointer {
  getLatest(): Promise<Result<SessionInfo, SessionError>>;
  getPrevious(): Promise<Result<SessionInfo, SessionError>>;
}
```

## Consequences

### Positive

- **クラッシュ耐性**: 各行がatomicに書き込まれ、途中経過が保持される
- **リアルタイム監視**: `tail -f sessions/*.jsonl` で進捗確認可能
- **セッション継続**: `previous.json` から前回コンテキストを明示的に参照
- **デバッグ容易**: 時系列でイベントを追跡可能

### Negative

- 既存Run/Checkとの互換性対応が必要
- ログサイズが増加する可能性（ローテーション検討）

### Neutral

- 既存のRun/Check JSONは維持（詳細データ用）
- NDJSONはイベントストリーム、JSON は状態スナップショットとして併用

## Implementation

### Phase 1: ログ基盤
1. `SessionLogger` インターフェース定義
2. NDJSONファイル書き込み実装
3. ポインタファイル管理

### Phase 2: 統合
1. Orchestratorにログ出力追加
2. CLIでのログ表示（`agent logs`）

### Phase 3: 継続性
1. セッション再開時の`previous.json`参照
2. 中断からの再開機能強化

## References

- [NDJSON Specification](http://ndjson.org/)
