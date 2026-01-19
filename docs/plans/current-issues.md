# Agent Orchestrator - 現在の問題点

**作成日**: 2026-01-19
**更新日**: 2026-01-19 (Phase 2実装後のバグ発見)
**ステータス**: Phase 2実装後に新規バグ発見

## 概要

Phase 1-3の実装後、`agent run` コマンドで新しい問題が発生：

### 🔴 Phase 2実装後の新規問題（2026-01-19）

**エラー**: `Failed to parse agent output: SyntaxError`

```bash
Failed to parse agent output: SyntaxError: Unexpected token '\', "\n[\n  {\n"... is not valid JSON
Output was: {"type":"result","subtype":"success","is_error":false,"duration_ms":87833,...}
```

**根本原因**: `runClaudeAgent`の実装バグ（後述の「問題4」参照）

### ❌ 当初の問題（Phase 1-3で解決済み）

1. ~~途中経過が表示されない~~ ✅ Phase 1で解決
2. ~~実行結果がどこにも保存されない~~ ✅ Phase 1で解決
3. ~~ダミーのタスク分解が使用されている~~ ✅ Phase 2で解決（ただし新規バグ発生）

## 発見された問題

### 1. Plannerがダミー実装のまま ✅ Phase 2で解決（ただしバグ発見）

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

### 2. Workerが実行ログを保存していない ✅ Phase 1で解決

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

### 3. Judge判定がシンプルすぎる ✅ Phase 4で対応予定

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

### 4. runClaudeAgentの実装バグ 🔴 緊急

**発見日**: 2026-01-19 (Phase 2実装後のテスト実行時)
**ファイル**: `src/core/runner/runner-effects-impl.ts:102-126`

**問題点**:

- `unstable_v2_prompt`の戻り値全体を`JSON.stringify`してしまっている（121行目）
- エージェントの実際の応答テキストは`sdkResult.result`プロパティに含まれている
- しかし、現在の実装は`JSON.stringify(sdkResult)`を返すため、メタデータごとJSON化される

**現在の実装**:

```typescript
// src/core/runner/runner-effects-impl.ts:102-126
const runClaudeAgent = async (
  prompt: string,
  _workingDirectory: string,
  model: string,
): Promise<Result<AgentOutput, RunnerError>> => {
  const result = await tryCatchIntoResultAsync(async () => {
    const { unstable_v2_prompt } = await import('@anthropic-ai/claude-agent-sdk');

    const sdkResult = await unstable_v2_prompt(prompt, {
      model: model || 'claude-sonnet-4-5-20250929',
    });

    // ❌ 問題: sdkResult全体をJSON化している
    return {
      finalResponse: JSON.stringify(sdkResult),
    } satisfies AgentOutput;
  });

  return mapErrForResult(result, (e) => agentExecutionError('claude', e));
};
```

**SDKの実際の戻り値構造**:

````typescript
{
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 87833,
  duration_api_ms: 110675,
  num_turns: 6,
  result: "```json\n[\n  {\n    \"description\": \"...\",\n    ...\n  }\n]```"  // ← これが実際のエージェントの応答
}
````

**正しい実装**:

```typescript
// ✅ 修正後
return {
  finalResponse: sdkResult.result, // result プロパティを直接使用
} satisfies AgentOutput;
```

**影響範囲**:

- Planner（タスク分解）が完全に動作しない
- `parseAgentOutput`がパースエラーで失敗
- フォールバックでダミータスクが使用されてしまう
- **Phase 2の本来の目的が達成できていない**

**優先度**: 🔴 **最優先**（Phase 2の成果物が機能していない）

**推定工数**: 30分（実装は1行の修正、テスト含めて）

**⚠️ 補足**: Codexエージェントについて

- `runCodexAgent`は`turn.finalResponse`を直接使用している
- しかし、実際にはCodexエージェントは実行されておらず、検証されていない
- Codex SDKの実際の戻り値構造が想定通りかは未確認
- Codexを使用する場合は、同様のバグがないか事前確認が必要

## 検証結果

### 実行時のログ（Phase 2実装後）

````bash
agent run "GitHub統合の諸機能を計画して文書化して。"
📋 Configuration loaded
   App Repo: /home/berlysia/workspace/agent-orchestorator
   Coord Repo: /home/berlysia/workspace/agent-orchestorator-coord
   Max Workers: 3

🚀 Starting orchestration...

📝 Instruction: "GitHub統合の諸機能を計画して文書化して。"

🔍 Planning tasks...
Failed to parse agent output: SyntaxError: Unexpected token '\', "\n[\n  {\n"... is not valid JSON
    at JSON.parse (<anonymous>)
    at parseAgentOutput (file:///home/berlysia/workspace/agent-orchestorator/dist/core/orchestrator/planner-operations.js:157:29)
    ...
Output was: {"type":"result","subtype":"success","is_error":false,"duration_ms":87833,"duration_api_ms":110675,"num_turns":6,"result":"```json\n[\n  {\n    \"description\": \"GitHubアダプター基盤の実装\",\n    \"branch\": \"feature/github-adapter-foundation\",\n    \"scopePaths\": [\"src/adapters/github/\", \"src/types/\"],\n    \"acceptance\": \"GitHubEffectsインターフェースが定義され、GitHubErrorタイプがエラー階層に統合されている。GitHubConfigスキーマ（token、owner、repo）がZodで定義され、設定ファイルから読み込める。\"\n  },\n  {\n    \"description\": \"GitHub PR作成機能の実装\",\n... (truncated)
````

**分析**:

- エージェントは正しくタスク分解を実行している（`result`フィールドにJSON配列が含まれている）
- しかし、`runClaudeAgent`が`JSON.stringify(sdkResult)`を実行したため、全体がJSON化されている
- `parseAgentOutput`は`finalResponse`から直接JSON配列を期待するが、実際にはラッパーオブジェクトの文字列を受け取る
- そのため、JSONパースに失敗している

### 実行時のログ（Phase 1以前）

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

## 実装済み機能の状態

### RunnerEffects

`src/core/runner/runner-effects-impl.ts` の実装状態：

- ✅ `ensureRunsDir()` - runsディレクトリ作成（Phase 1で使用開始）
- ✅ `appendLog()` - ログ追記（Phase 1で使用開始）
- ✅ `saveRunMetadata()` - メタデータ保存（Phase 1で使用開始）
- ✅ `loadRunMetadata()` - メタデータ読み込み（実装済み）
- ✅ `readLog()` - ログ読み込み（実装済み）
- ⚠️ `runClaudeAgent()` - Claudeエージェント実行（Phase 2で使用開始、**ただしバグあり**）
- ⚠️ `runCodexAgent()` - Codexエージェント実行（実装済み、**未検証**）

**Phase 1-3で多くの機能が使用開始されたが、`runClaudeAgent`にバグが発見された**。

## 優先順位

### 🔴 緊急: runClaudeAgentのバグ修正（問題4）

**理由**:

- Phase 2の成果物が完全に機能していない
- 1行の修正で解決可能
- Plannerのエージェント統合が実質的に無効化されている

**推定工数**: 30分

### ~~高: Worker実行ログの保存~~ ✅ Phase 1で解決

**理由**:

- ユーザーが途中経過を確認できないため、UXが非常に悪い
- デバッグが困難
- 既に実装されているRunnerEffectsを利用するだけで解決可能

**推定工数**: 2-3時間

### ~~中: Plannerのエージェント統合~~ ✅ Phase 2で解決（ただしバグあり）

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

1. **即座**: runClaudeAgentのバグを修正（Phase 2.4として実装）
2. Phase 2.4完了後、実際に複数タスクが生成されることを確認
3. Phase 3の機能（CLI出力改善）が正しく動作するか検証
4. Phase 4（Judge判定の強化）は別Epicとして扱う

## 関連ファイル

- `src/core/orchestrator/planner-operations.ts` - Planner実装
- `src/core/orchestrator/worker-operations.ts` - Worker実装
- `src/core/orchestrator/judge-operations.ts` - Judge実装
- `src/core/runner/runner-effects-impl.ts` - RunnerEffects実装
- `src/core/runner/runner-effects.ts` - RunnerEffectsインターフェース
