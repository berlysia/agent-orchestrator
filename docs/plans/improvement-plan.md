# Agent Orchestrator - 改善計画

**作成日**: 2026-01-19
**ステータス**: Phase 1-3 完了、Phase 2.4 修正中、Phase 4 は別Epic
**更新日**: 2026-01-19 (Phase 2実装バグ発見)
**関連**: [current-issues.md](./current-issues.md)

## 実装ステータス

| Phase | 優先度 | ステータス | 完了日 | コミット |
|-------|--------|-----------|--------|----------|
| Phase 1: Worker実行ログの保存 | 高 | ✅ 完了 | 2026-01-19 | 73e74cc |
| Phase 2: Plannerのエージェント統合 | 中 | ⚠️ バグあり | 2026-01-19 | 73e74cc |
| **Phase 2.4: runClaudeAgentバグ修正** | 🔴 緊急 | 🚧 修正中 | - | - |
| Phase 3: CLI出力の改善 | 中 | ✅ 完了 | 2026-01-19 | 73e74cc |
| Phase 4: Judge判定の強化 | 低 | 🔜 別Epic | - | - |

**実装順序**: Phase 1 → Phase 3 → Phase 2 → **Phase 2.4（緊急バグ修正）**

**成果**:
- ✅ Worker実行ログが`runs/`ディレクトリに自動保存される
- ⚠️ Plannerが実際にClaude/Codexエージェントを使用してタスク分解を実行（ただし`runClaudeAgent`にバグ）
- ✅ CLI実行時にログファイルパスが表示される
- ✅ ユーザーが途中経過を確認できるようになった
- ✅ デバッグとトラブルシューティングが容易になった

**テスト**: 17/17テストが成功（パーサーのエッジケース対応含む）

**🔴 発見された問題**:
- Phase 2実装後のテスト実行で`runClaudeAgent`のバグを発見
- エージェントは正しく動作しているが、SDKの戻り値を誤って処理している
- 詳細は [current-issues.md#問題4](./current-issues.md#4-runclaudeagentの実装バグ--緊急) を参照

## 目標

Agent Orchestratorの実行可視性を向上させ、本来の価値を発揮できるようにする。

## 改善フェーズ

### Phase 1: Worker実行ログの保存 【優先度: 高】

#### 目的
- ユーザーが途中経過を確認できるようにする
- デバッグ・トラブルシューティングを可能にする
- 実行履歴を追跡可能にする

#### 変更内容

**ファイル**: `src/core/orchestrator/worker-operations.ts`

##### 1.1 executeTask関数の修正

**現在**:
```typescript
const executeTask = async (
  task: Task,
  worktreePath: WorktreePath,
  agentType: AgentType,
): Promise<Result<WorkerResult, OrchestratorError>> => {
  const agentPrompt = `Execute task: ${task.acceptance}`;
  const agentResult = /* ... */;

  if (isErr(agentResult)) {
    return createOk({
      runId: `error-${task.id}`,
      success: false,
      error: agentResult.err.message,
    });
  }

  return createOk({
    runId: task.id,
    success: true,
  });
};
```

**変更後**:
```typescript
const executeTask = async (
  task: Task,
  worktreePath: WorktreePath,
  agentType: AgentType,
): Promise<Result<WorkerResult, OrchestratorError>> => {
  // 1. runsディレクトリを確保
  const ensureResult = await deps.runnerEffects.ensureRunsDir();
  if (isErr(ensureResult)) {
    return createErr(ensureResult.err);
  }

  // 2. RunID生成（タスクIDベース）
  const runId = `run-${task.id}-${Date.now()}`;

  // 3. 実行メタデータを初期化
  const runMetadata: Run = {
    id: runId,
    taskId: task.id,
    agentType,
    startedAt: new Date().toISOString(),
    status: 'running',
  };

  // メタデータ保存
  const saveMetaResult = await deps.runnerEffects.saveRunMetadata(runMetadata);
  if (isErr(saveMetaResult)) {
    return createErr(saveMetaResult.err);
  }

  // 4. ログにタスク開始を記録
  await deps.runnerEffects.appendLog(
    runId,
    `[${new Date().toISOString()}] Starting task: ${task.acceptance}\n`
  );
  await deps.runnerEffects.appendLog(
    runId,
    `Agent Type: ${agentType}\n`
  );
  await deps.runnerEffects.appendLog(
    runId,
    `Worktree: ${worktreePath}\n\n`
  );

  // 5. エージェントを実行
  const agentPrompt = `Execute task: ${task.acceptance}`;
  const agentResult =
    agentType === 'claude'
      ? await deps.runnerEffects.runClaudeAgent(
          agentPrompt,
          worktreePath as string,
          'claude-sonnet-4-5-20250929',
        )
      : await deps.runnerEffects.runCodexAgent(agentPrompt, worktreePath as string);

  // 6. 結果をログに記録
  if (isErr(agentResult)) {
    const errorMsg = agentResult.err.message;
    await deps.runnerEffects.appendLog(
      runId,
      `[${new Date().toISOString()}] ❌ Agent execution failed\n`
    );
    await deps.runnerEffects.appendLog(runId, `Error: ${errorMsg}\n`);

    // メタデータ更新
    const updatedMeta: Run = {
      ...runMetadata,
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: errorMsg,
    };
    await deps.runnerEffects.saveRunMetadata(updatedMeta);

    return createOk({
      runId,
      success: false,
      error: errorMsg,
    });
  }

  // 7. 成功時の処理
  const output = agentResult.val;
  await deps.runnerEffects.appendLog(
    runId,
    `[${new Date().toISOString()}] ✅ Agent execution completed\n`
  );
  await deps.runnerEffects.appendLog(
    runId,
    `Final Response:\n${output.finalResponse}\n`
  );

  // メタデータ更新
  const completedMeta: Run = {
    ...runMetadata,
    status: 'completed',
    completedAt: new Date().toISOString(),
    output: output.finalResponse,
  };
  await deps.runnerEffects.saveRunMetadata(completedMeta);

  return createOk({
    runId,
    success: true,
  });
};
```

##### 1.2 必要な型定義の追加

**ファイル**: `src/types/run.ts` (既存の型を確認・拡張)

```typescript
export interface Run {
  id: string;
  taskId: string;
  agentType: 'claude' | 'codex';
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'completed' | 'failed';
  output?: string;
  error?: string;
}
```

#### 実装手順

1. `src/types/run.ts` の型定義を確認・必要に応じて拡張
2. `src/core/orchestrator/worker-operations.ts` の `executeTask` を修正
3. ユニットテストを実行して既存機能が壊れていないか確認
4. 実際に `agent run` を実行してログが保存されることを確認
   ```bash
   agent run "テスト用タスク"
   ls -la ~/workspace/agent-orchestorator-coord/runs/
   cat ~/workspace/agent-orchestorator-coord/runs/run-*.log
   ```

#### 成功基準

- ✅ runsディレクトリに `.log` ファイルが作成される
- ✅ runsディレクトリに `.json` ファイル（メタデータ）が作成される
- ✅ ログにタスク開始・完了・エラーが記録される
- ✅ エージェントの出力が記録される
- ✅ 既存のテストがすべてパスする

#### 推定工数
2-3時間

---

### Phase 2: Plannerのエージェント統合 【優先度: 中】

#### 目的
- ダミー実装を置き換える
- ユーザー指示から適切にタスク分解を行う
- 複雑な指示に対応可能にする

#### 変更内容

**ファイル**: `src/core/orchestrator/planner-operations.ts`

##### 2.1 planTasks関数の修正

**現在**:
```typescript
const planTasks = async (
  userInstruction: string,
): Promise<Result<PlanningResult, TaskStoreError>> => {
  // TODO: 実際のエージェント実行を統合
  const taskBreakdowns = createDummyTaskBreakdown(userInstruction);
  // ...
};
```

**変更後**:
```typescript
const planTasks = async (
  userInstruction: string,
): Promise<Result<PlanningResult, TaskStoreError>> => {
  const plannerTaskId = `planner-${randomUUID()}`;

  // 1. Plannerプロンプトを構築
  const planningPrompt = buildPlanningPrompt(userInstruction);

  // 2. エージェントを実行（デフォルトはClaude）
  const runResult = await deps.runnerEffects.runClaudeAgent(
    planningPrompt,
    deps.appRepoPath,
    'claude-sonnet-4-5-20250929',
  );

  if (isErr(runResult)) {
    return createErr(
      ioError('planTasks', `Failed to run planner agent: ${runResult.err.message}`)
    );
  }

  // 3. エージェント出力をパース
  const taskBreakdowns = parseAgentOutput(runResult.val.finalResponse);

  if (taskBreakdowns.length === 0) {
    return createErr(
      ioError('planTasks', 'Agent returned no task breakdowns')
    );
  }

  // 4. タスクをTaskStoreに保存（既存のロジック）
  // ...
};
```

##### 2.2 プロンプトビルダーの実装

```typescript
export const buildPlanningPrompt = (userInstruction: string): string => {
  return `You are a task planner for a multi-agent development system.

USER INSTRUCTION:
${userInstruction}

Your task is to break down this instruction into concrete, implementable tasks.

For each task, provide:
1. description: Clear description of what needs to be done
2. branch: Git branch name (e.g., "feature/add-login")
3. scopePaths: Array of file/directory paths that will be modified (e.g., ["src/auth/", "tests/auth/"])
4. acceptance: Acceptance criteria for completion

Output format (JSON array):
[
  {
    "description": "Task description",
    "branch": "feature/branch-name",
    "scopePaths": ["path1/", "path2/"],
    "acceptance": "Acceptance criteria"
  }
]

Rules:
- Create 1-5 tasks (prefer smaller, focused tasks)
- Each task should be independently implementable
- Branch names must be valid Git branch names
- Scope paths should be specific but allow flexibility
- Acceptance criteria should be testable

Output only the JSON array, no additional text.`;
};
```

##### 2.3 出力パーサーの実装

```typescript
export const parseAgentOutput = (output: string): TaskBreakdown[] => {
  try {
    // JSONブロックを抽出（マークダウンコードブロックに囲まれている可能性）
    const jsonMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ||
                      output.match(/(\[[\s\S]*\])/);

    const jsonStr = jsonMatch ? jsonMatch[1] : output;
    const parsed = JSON.parse(jsonStr.trim());

    if (!Array.isArray(parsed)) {
      console.warn('Agent output is not an array, wrapping in array');
      return [parsed];
    }

    // バリデーション
    return parsed.filter((item) => {
      return (
        typeof item.description === 'string' &&
        typeof item.branch === 'string' &&
        Array.isArray(item.scopePaths) &&
        typeof item.acceptance === 'string'
      );
    });
  } catch (error) {
    console.error('Failed to parse agent output:', error);
    console.error('Output was:', output);
    return [];
  }
};
```

#### 実装手順

1. `buildPlanningPrompt` 関数を実装
2. `parseAgentOutput` 関数を実装
3. `planTasks` 関数を修正してエージェントを呼び出す
4. ユニットテストを追加（パーサーのテスト）
5. 実際に `agent run` を実行して複数タスクが生成されることを確認
6. `createDummyTaskBreakdown` を削除（またはフォールバック用に残す）

#### 成功基準

- ✅ エージェントがタスク分解を実行する
- ✅ JSONレスポンスが正しくパースされる
- ✅ 複数のタスクが生成される（指示に応じて）
- ✅ 生成されたタスクがTaskStoreに保存される
- ✅ パーサーのユニットテストがパスする

#### 推定工数
4-6時間

---

### Phase 2.4: runClaudeAgentバグ修正 【優先度: 🔴 緊急】

#### 発見の経緯
Phase 2実装後のテスト実行時に、以下のエラーが発生：

```
Failed to parse agent output: SyntaxError: Unexpected token '\', "\n[\n  {\n"... is not valid JSON
Output was: {"type":"result","subtype":"success",...,"result":"```json\n[...]```"}
```

#### 根本原因
`src/core/runner/runner-effects-impl.ts:121`で、Claude Agent SDKの戻り値全体を`JSON.stringify`してしまっている。

**現在の誤った実装**:
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
      finalResponse: JSON.stringify(sdkResult), // ← この行が間違い
    } satisfies AgentOutput;
  });

  return mapErrForResult(result, (e) => agentExecutionError('claude', e));
};
```

**SDKの実際の戻り値構造**:
```typescript
{
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 87833,
  duration_api_ms: 110675,
  num_turns: 6,
  result: "```json\n[...]```"  // ← これが実際のエージェントの応答
}
```

#### 修正内容

**ファイル**: `src/core/runner/runner-effects-impl.ts`

**修正前**:
```typescript
return {
  finalResponse: JSON.stringify(sdkResult),
} satisfies AgentOutput;
```

**修正後**:
```typescript
return {
  finalResponse: sdkResult.result, // resultプロパティを直接使用
} satisfies AgentOutput;
```

#### 実装手順

1. `src/core/runner/runner-effects-impl.ts` の121行目を修正
2. プロジェクトをビルド (`pnpm build`)
3. 既存テストを実行 (`pnpm test`)
4. 実際に`agent run`を実行して複数タスクが生成されることを確認
   ```bash
   agent run "GitHub統合の諸機能を計画して文書化して。"
   # 複数のタスクが生成されることを確認
   ```

#### 成功基準

- ✅ `parseAgentOutput`がエラーなくパースできる
- ✅ エージェントが生成した複数のタスクが正しくTaskStoreに保存される
- ✅ フォールバックでダミータスクが使用されない
- ✅ 既存のテストがすべてパスする

#### 影響範囲

**修正箇所**: 1ファイル、1行のみ
**影響**: Planner（タスク分解）の動作が正常化

#### 推定工数
30分（実装5分、ビルド・テスト・検証25分）

---

### Phase 3: CLI出力の改善 【優先度: 中】

#### 目的
- ユーザーにリアルタイムで進捗を表示
- 実行結果の確認方法を提供
- より良いユーザー体験を実現

#### 変更内容

##### 3.1 orchestrate.tsでのログ出力改善

**ファイル**: `src/core/orchestrator/orchestrate.ts`

```typescript
// Worker実行後にログファイルのパスを表示
console.log(`  📝 Execution log: runs/${runId}.log`);
console.log(`  📊 Metadata: runs/${runId}.json`);
```

##### 3.2 agent statusコマンドの拡張

**ファイル**: `src/cli/commands/status.ts`

```typescript
// 最近の実行ログを表示する機能を追加
// 例: agent status --logs
// 例: agent status --task <task-id>
```

##### 3.3 新しいコマンド: agent logs

```typescript
// 特定の実行ログを表示
// agent logs <run-id>
// agent logs --task <task-id>  # タスクの全実行ログを表示
```

#### 実装手順

1. orchestrate.tsでログファイルパスを出力
2. `agent status` コマンドを拡張
3. `agent logs` コマンドを新規作成
4. ドキュメント（README.md）を更新

#### 成功基準

- ✅ 実行後にログファイルの場所が表示される
- ✅ `agent status` で実行履歴が確認できる
- ✅ `agent logs` でログ内容を確認できる

#### 推定工数
2-3時間

---

### Phase 4: Judge判定の強化 【優先度: 低】

**注**: CI統合が必要なため、別Epicとして扱う

#### 目的
- タスクの実際の完了状態を確認
- CI/テスト結果に基づいた判定
- 品質保証の向上

#### 変更内容（概要のみ）

1. CI実行結果の取得
2. テスト結果の確認
3. ビルド成功/失敗の判定
4. 受け入れ基準の検証

#### 推定工数
6-8時間（CI統合含む）

---

## 実装順序

### 実際の実装順序

1. **Phase 1**: Worker実行ログの保存（2-3時間） ✅ 完了
   - すぐにUX改善効果が得られる
   - 既存機能を活用するだけで実装可能
   - 後続フェーズのデバッグにも役立つ

2. **Phase 3**: CLI出力の改善（2-3時間） ✅ 完了
   - Phase 1で保存したログを活用
   - ユーザーフレンドリーなインターフェース

3. **Phase 2**: Plannerのエージェント統合（4-6時間） ✅ 完了（ただしバグ発見）
   - Phase 1のログ機能でデバッグしやすくなる
   - システムの本来の価値を発揮

4. **Phase 2.4**: runClaudeAgentバグ修正（30分） 🚧 実装中
   - Phase 2実装時の見落とし
   - 1行の修正で解決可能
   - **最優先で修正が必要**

5. **Phase 4**: Judge判定の強化（別Epic） 🔜 未実装
   - CI統合が必要
   - より大きな設計決定が必要

### 推奨順序（将来のプロジェクト向け）

1. **Phase 1**: Worker実行ログの保存（2-3時間）
2. **Phase 3**: CLI出力の改善（2-3時間）
3. **Phase 2**: Plannerのエージェント統合（4-6時間）
   - **重要**: SDKの戻り値構造を事前に確認すること
   - Phase 2.4のようなバグを防ぐため、単体テストを十分に行う
4. **Phase 4**: Judge判定の強化（別Epic）

### 最小限の改善（クイックウィン）

もし時間が限られている場合は、**Phase 1のみ**を実装することを推奨します。

**Phase 1の価値**:
- ユーザーが途中経過を確認できる
- デバッグが可能になる
- 実装コストが低い（2-3時間）
- 既存のRunnerEffectsを活用するだけ

---

## テスト戦略

### Phase 1のテスト

#### ユニットテスト
```typescript
// tests/unit/core/orchestrator/worker-operations.test.ts
describe('executeTask with logging', () => {
  it('should save execution logs', async () => {
    // ...
  });

  it('should save metadata', async () => {
    // ...
  });

  it('should log errors', async () => {
    // ...
  });
});
```

#### E2Eテスト
```bash
# tests/e2e/run-with-logs.test.ts
# agent runを実行して、ログが保存されることを確認
```

### Phase 2のテスト

#### ユニットテスト
```typescript
// tests/unit/core/orchestrator/planner-operations.test.ts
describe('parseAgentOutput', () => {
  it('should parse valid JSON array', () => {
    // ...
  });

  it('should extract JSON from markdown code blocks', () => {
    // ...
  });

  it('should handle invalid output gracefully', () => {
    // ...
  });
});
```

---

## リスクと対策

### Phase 1のリスク

**リスク**: ログファイルが大きくなりすぎる

**対策**:
- ログローテーション機能の追加（将来）
- 古いログの自動削除（将来）
- 現時点では手動クリーンアップで対処

### Phase 2のリスク

**リスク**: エージェントが不正なJSONを返す

**対策**:
- パーサーのエラーハンドリングを強化 ✅ 実装済み
- フォールバックとして `createDummyTaskBreakdown` を保持 ✅ 実装済み
- プロンプトの改善（JSONフォーマットの厳密化）

**リスク**: エージェント実行コストが増加

**対策**:
- タスク数の上限を設定（最大5タスク）
- キャッシュ機構の検討（将来）

**🔴 実際に発生したリスク**: SDKの戻り値構造の誤解

**発生内容**:
- `unstable_v2_prompt`の戻り値を正しく理解していなかった
- `JSON.stringify(sdkResult)`を使用してしまった
- 実際には`sdkResult.result`を使用すべきだった

**教訓**:
- 外部SDKの戻り値構造は、必ず公式ドキュメントを確認する
- 実装前に小さなテストスクリプトで動作確認を行う
- 単体テストでSDKのモックを適切に設定する

### Phase 2.4のリスク

**リスク**: 修正が他の部分に影響する

**対策**:
- 修正は1行のみであり、影響範囲が限定的
- 既存のテストスイートで回帰を確認

**⚠️ 注意**: Codexエージェントも未検証
- `runCodexAgent`は`turn.finalResponse`を直接使用しているが、実際には実行されていない
- Codex SDKの実際の戻り値構造が想定通りかは未確認
- Codexを使用する場合は、同様のバグがないか事前確認が必要

---

## 完了基準

### Phase 1完了基準

- ✅ `agent run` 実行時に `runs/` ディレクトリにログが保存される
- ✅ ログファイルにタスク開始・完了・エラーが記録される
- ✅ メタデータファイルに実行情報が記録される
- ✅ 既存のテストがすべてパスする
- ✅ E2Eテストでログ保存が検証される

### Phase 2完了基準

- ✅ ダミー実装が実際のエージェント呼び出しに置き換えられる
- ⚠️ エージェントが複数のタスクを生成する（バグのため動作せず）
- ✅ パーサーのユニットテストがすべてパスする
- ✅ エラーハンドリングが適切に機能する

### Phase 2.4完了基準

- ☐ `runClaudeAgent`が`sdkResult.result`を返すように修正される
- ☐ `parseAgentOutput`がエラーなくパースできる
- ☐ エージェントが生成した複数のタスクが正しくTaskStoreに保存される
- ☐ フォールバックでダミータスクが使用されない
- ☐ 既存のテストがすべてパスする

### Phase 3完了基準

- ✅ ログファイルの場所がCLIに表示される
- ✅ `agent status` でログ確認可能
- ✅ ドキュメントが更新される

---

## 次のアクション

### 完了済み
1. ✅ このドキュメントをレビュー
2. ✅ Phase 1の実装開始を決定
3. ✅ 実装ブランチを作成（例: `feature/worker-logging`）
4. ✅ Phase 1の実装とテストを実行
5. ✅ Phase 1完了後、Phase 2の詳細設計を開始
6. ✅ Phase 2, Phase 3の実装完了

### 🔴 緊急タスク（Phase 2.4）
1. **即座実行**: `runClaudeAgent`のバグ修正
   - `src/core/runner/runner-effects-impl.ts:121`を修正
   - `JSON.stringify(sdkResult)` → `sdkResult.result`
2. ビルドとテストの実行
3. 実際の動作確認（`agent run`で複数タスク生成を確認）
4. バグ修正をコミット

### 今後の計画
1. Phase 2.4完了後、システム全体の動作確認
2. Phase 4（Judge判定の強化）を別Epicとして計画
3. 本番運用に向けた準備

---

## 関連ドキュメント

- [current-issues.md](./current-issues.md) - 現在の問題点
- [docs/architecture.md](../../docs/architecture.md) - アーキテクチャドキュメント
- [README.md](../../README.md) - プロジェクトREADME
