# Agent Orchestrator - 現在の問題点

**作成日**: 2026-01-19
**ステータス**: 調査中

## 概要

`agent run` コマンドを実行した際、以下の問題が発生しています：

1. 途中経過が表示されない
2. 実行結果がどこにも保存されない
3. ダミーのタスク分解が使用されている

## 発見された問題

### 1. Plannerがダミー実装のまま

**ファイル**: `src/core/orchestrator/planner-operations.ts:72`

```typescript
// 現時点ではダミーのタスク分解を使用
const taskBreakdowns = createDummyTaskBreakdown(userInstruction);
```

**問題点**:
- 実際のエージェント（Claude/Codex）を実行していない
- 常に1つのダミータスクしか生成されない
- ユーザーの指示が適切にタスク分解されない

**影響範囲**:
- タスク分解の品質が低い
- 複雑な指示に対応できない
- エージェント統合の価値が発揮されない

**コード箇所**:
```typescript
// src/core/orchestrator/planner-operations.ts:127-138
function createDummyTaskBreakdown(userInstruction: string): TaskBreakdown[] {
  console.warn('Using dummy task breakdown (agent integration not yet implemented)');

  return [
    {
      description: `Implement: ${userInstruction}`,
      branch: 'feature/main-implementation',
      scopePaths: ['src/'],
      acceptance: 'Feature is implemented and tested',
    },
  ];
}
```

### 2. Workerが実行ログを保存していない

**ファイル**: `src/core/orchestrator/worker-operations.ts:104-132`

`executeTask` 関数でエージェントを実行していますが、以下の処理が欠落：

**欠落している処理**:
1. `runnerEffects.ensureRunsDir()` - runsディレクトリの作成
2. `runnerEffects.saveRunMetadata()` - 実行メタデータの保存
3. `runnerEffects.appendLog()` - 実行ログの記録

**問題点**:
- 実行結果が `runs/` ディレクトリに保存されない
- ユーザーが途中経過を確認できない
- デバッグ時に実行内容を追跡できない

**影響範囲**:
- ユーザー体験の低下（何が起きているか分からない）
- トラブルシューティングが困難
- 実行履歴の追跡不可能

**現在の実装**:
```typescript
// src/core/orchestrator/worker-operations.ts:104-132
const executeTask = async (
  task: Task,
  worktreePath: WorktreePath,
  agentType: AgentType,
): Promise<Result<WorkerResult, OrchestratorError>> => {
  // エージェントを実行
  const agentPrompt = `Execute task: ${task.acceptance}`;
  const agentResult =
    agentType === 'claude'
      ? await deps.runnerEffects.runClaudeAgent(
          agentPrompt,
          worktreePath as string,
          'claude-sonnet-4-5-20250929',
        )
      : await deps.runnerEffects.runCodexAgent(agentPrompt, worktreePath as string);

  // ログ保存処理がない！

  if (isErr(agentResult)) {
    return createOk({
      runId: `error-${task.id}`,
      success: false,
      error: agentResult.err.message,
    });
  }

  return createOk({
    runId: task.id, // TODO: 実際のRunIDを使用
    success: true,
  });
};
```

### 3. Judge判定がシンプルすぎる

**ファイル**: `src/core/orchestrator/judge-operations.ts:46-81`

**問題点**:
- RUNNING状態のタスクを無条件で成功とみなす（74-80行目）
- CI実行結果の確認がない（TODOコメント）
- 実際の完了条件をチェックしていない

**コード箇所**:
```typescript
// src/core/orchestrator/judge-operations.ts:74-80
// 簡易判定: RUNNING状態のタスクは成功とみなす
return createOk({
  taskId: tid,
  success: true,
  shouldContinue: false, // MVP版では1サイクルで終了
  reason: 'Task completed successfully (simplified judgement)',
});
```

**影響範囲**:
- タスク失敗を検出できない
- 品質保証が不十分
- 誤った完了判定による問題の見逃し

## 検証結果

### 実行時のログ

```
🚀 Starting orchestration...
📝 Instruction: "GitHub統合の諸機能を計画して文書化して。"
🔍 Planning tasks...
Using dummy task breakdown (agent integration not yet implemented)
📋 Generated 1 tasks

🔨 Processing task: task-6becb7c2-1ebc-4842-84fb-e22ca9dc363e
  🚀 Executing task...
  ⚖️  Judging task...
  ✅ Task completed: Task completed successfully (simplified judgement)

🎉 Orchestration completed
  Completed: 1
  Failed: 0
```

### ファイルシステムの状態

**タスクは保存されている**:
```json
// agent-orchestorator-coord/tasks/task-6becb7c2-1ebc-4842-84fb-e22ca9dc363e.json
{
  "id": "task-6becb7c2-1ebc-4842-84fb-e22ca9dc363e",
  "state": "DONE",
  "version": 2,
  "owner": null,
  "repo": "/home/berlysia/workspace/agent-orchestorator",
  "branch": "feature/main-implementation",
  "scopePaths": ["src/"],
  "acceptance": "Feature is implemented and tested",
  "check": null,
  "createdAt": "2026-01-18T19:23:05.392Z",
  "updatedAt": "2026-01-18T19:23:48.962Z"
}
```

**実行ログは空**:
```bash
$ ls -la agent-orchestorator-coord/runs/
total 8
drwxr-xr-x 2 berlysia berlysia 4096 Jan 19 04:14 .
drwxr-xr-x 7 berlysia berlysia 4096 Jan 19 04:23 ..
-rw-r--r-- 1 berlysia berlysia    0 Jan 19 04:14 .gitkeep
```

## 実装済みだが使用されていない機能

### RunnerEffects

`src/core/runner/runner-effects-impl.ts` には以下が実装済み：

- ✅ `ensureRunsDir()` - runsディレクトリ作成
- ✅ `appendLog()` - ログ追記
- ✅ `saveRunMetadata()` - メタデータ保存
- ✅ `loadRunMetadata()` - メタデータ読み込み
- ✅ `readLog()` - ログ読み込み
- ✅ `runClaudeAgent()` - Claudeエージェント実行
- ✅ `runCodexAgent()` - Codexエージェント実行

**これらの機能は実装されているが、Workerから呼ばれていない**。

## 優先順位

### 高: Worker実行ログの保存

**理由**:
- ユーザーが途中経過を確認できないため、UXが非常に悪い
- デバッグが困難
- 既に実装されているRunnerEffectsを利用するだけで解決可能

**推定工数**: 2-3時間

### 中: Plannerのエージェント統合

**理由**:
- タスク分解の品質向上
- 複雑な指示への対応
- システムの本来の価値を発揮するために必要

**推定工数**: 4-6時間

### 低: Judge判定の強化

**理由**:
- CI統合が必要（別Epic）
- 現状でも基本的な動作は可能
- Worker実行が安定してから実装すべき

**推定工数**: 6-8時間（CI統合含む）

## 次のステップ

このドキュメントをベースに、改善計画書（improvement-plan.md）を作成します。

## 関連ファイル

- `src/core/orchestrator/planner-operations.ts` - Planner実装
- `src/core/orchestrator/worker-operations.ts` - Worker実装
- `src/core/orchestrator/judge-operations.ts` - Judge実装
- `src/core/runner/runner-effects-impl.ts` - RunnerEffects実装
- `src/core/runner/runner-effects.ts` - RunnerEffectsインターフェース
