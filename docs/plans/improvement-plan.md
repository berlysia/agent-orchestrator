# Agent Orchestrator - 改善計画

**作成日**: 2026-01-19
**ステータス**: Phase 1-3 完了、Phase 2.4 修正中、Phase 4 は別Epic、**Phase 5以降（新規観点）追加**
**更新日**: 2026-01-19 (Phase 5以降の新規観点を追加)
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

### Phase 5以降（新規観点）

| Phase | 優先度 | ステータス | 推定工数 | 完了日 | コミット |
|-------|--------|-----------|----------|--------|----------|
| Phase 5.9: モデルの使い分け | 低 | ✅ 完了 | 2-3時間 | 2026-01-19 | 95114c4 |
| Phase 5.1: プランナーの品質向上 | 高 | ✅ 完了 | 4-6時間 | 2026-01-19 | ab6fcea, 2a4f003 |
| Phase 5.2: ジャッジによるタスク品質評価 | 高 | ✅ 完了 | 6-8時間 | 2026-01-19 | 546f55d |
| Phase 5.3: 並列実行サポート | 高 | ✅ 完了 | 10-12時間 | 2026-01-19 | 5a9870d |
| Phase 5.4: 直列タスクの変更統合 | 中 | ✅ 完了 | 6-8時間 | 2026-01-19 | 6c19086 |
| Phase 5.5: 統合処理とコンフリクト解決 | 中 | ✅ 完了 | 11-12時間 | 2026-01-19 | - |
| Phase 5.6: ジャッジ判定の高度化 | 中 | 📋 計画中 | 4-6時間 | - | - |
| Phase 5.7: 全体完了判定 | 中 | 📋 計画中 | 4-6時間 | - | - |
| Phase 5.8: プランナーの継続性 | 低 | 📋 計画中 | 4-6時間 | - | - |

**推奨実装順序**: Phase 5.9 → Phase 5.1 → Phase 5.2 → Phase 5.3 → Phase 5.4 → Phase 5.5 → Phase 5.6 → Phase 5.7 → Phase 5.8

**Phase 5.1完了**: プランナーが生成するタスクの品質を大幅に向上

**成果**:
- ✅ Worker実行ログが`runs/`ディレクトリに自動保存される
- ⚠️ Plannerが実際にClaude/Codexエージェントを使用してタスク分解を実行（ただし`runClaudeAgent`にバグ）
- ✅ CLI実行時にログファイルパスが表示される
- ✅ ユーザーが途中経過を確認できるようになった
- ✅ デバッグとトラブルシューティングが容易になった
- ✅ **Phase 5.9完了**: 役割別モデル最適化（Planner=Opus, Worker=Sonnet, Judge=Haiku）によるコスト削減と効率化
  - Config構造を `agents.{planner,worker,judge}` に刷新
  - 各役割ごとに `type` (claude/codex) と `model` をセットで指定可能
  - Zod 4の `toJSONSchema()` で JSON スキーマを自動生成
  - `??` フォールバック演算子を削除し、Config のデフォルト値を使用
- ✅ **Phase 5.1完了**: プランナーが生成するタスクの品質を大幅に向上
  - TaskBreakdown型にZodスキーマ（v2）を導入し、type/estimatedDuration/contextフィールドを必須化
  - Task型にtaskTypeとcontextフィールドを追加して永続化
  - buildPlanningPromptを大幅改善（タスクタイプ、粒度ガイドライン、完全なacceptance/context要求）
  - parseAgentOutputをZodバリデーションで厳格化し、不正なタスクを明確に拒否
  - ダミータスクフォールバックを削除し、エージェント失敗時はエラー終了
  - acceptanceとcontextに完全な実装情報を要求（外部参照なしで実行可能に）

**テスト**: 23/23テストが成功（Phase 5.1のZodバリデーション、estimatedDuration範囲検証、TaskType enum検証を含む）

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

---

## Phase 5以降: 新規観点の追加改善 【優先度: 検討中】

### 背景

Phase 1-3の実装後、実際の運用を通じて新たな問題点と改善の必要性が明らかになった。
以下の観点を追加で検討・実装する必要がある。

### 5.1 プランナーの品質向上 【優先度: 高】【ステータス: ✅ 完了】

**完了日**: 2026-01-19

#### 問題点
- タスクの内容が不明確（例: 文書作成指示に対して実装タスクが混入）
- タスクの粒度がバラバラ（一部は大きすぎ、一部は小さすぎ）
- 元の指示の意図が正しく反映されない
- 親タスクから子タスクへのコンテキスト伝達が不十分
- acceptanceとcontextが不完全で、タスク実行に必要な情報が不足

#### 改善内容（実装済み）

**5.1.1 TaskBreakdown型のZodスキーマ定義（必須化）**

スキーマバージョン2として定義:
- `type`: タスクタイプ（implementation/documentation/investigation/integration）
- `estimatedDuration`: 見積時間（0.5-8時間、1-4時間推奨）
- `context`: タスク実行に必要な完全なコンテキスト情報

```typescript
export const TaskBreakdownSchema = z.object({
  description: z.string().min(1),
  branch: z.string().min(1),
  scopePaths: z.array(z.string()).min(1),
  acceptance: z.string().min(1),
  type: z.enum(['implementation', 'documentation', 'investigation', 'integration']),
  estimatedDuration: z.number().min(0.5).max(8),
  context: z.string().min(1),
});
```

**5.1.2 Task型の拡張**

永続化時に新フィールドを保持:
- `taskType`: タスクタイプ
- `context`: コンテキスト情報

**5.1.3 プロンプトの大幅改善**

`buildPlanningPrompt`を拡張:
- タスクタイプの詳細説明
- 粒度ガイドライン（1-4時間目安、最大8時間）
- **COMPLETE acceptance基準**: WHAT（何を）とHOW（検証方法）を明示、エッジケース・エラーシナリオを含む
- **COMPLETE context**: 外部参照なしで完全実行可能な全情報（技術的アプローチ、依存関係、制約、既存パターン、データモデル、エラーハンドリング、セキュリティ、テスト）
- 具体的な例（認証実装、ドキュメント作成）

**5.1.4 Zodバリデーションによる厳格化**

`parseAgentOutput`を改善:
- Zodスキーマによる厳格なバリデーション
- 詳細なエラーメッセージ（`parseAgentOutputWithErrors`）
- 新フィールド欠落時は明確に拒否

**5.1.5 エラーハンドリングの改善**

- ダミータスクフォールバックを削除
- エージェント失敗時は明確にエラー終了
- バリデーションエラーをログに詳細記録

#### 実装ファイル
- `src/core/orchestrator/planner-operations.ts`: TaskBreakdownSchema、プロンプト、パーサー
- `src/types/task.ts`: Task型拡張、createInitialTask更新
- `tests/unit/core/orchestrator/planner-operations.test.ts`: テスト拡充
- `tests/unit/file-store.test.ts`: 新フィールド対応

#### 推定工数
4-6時間（実績: 約5時間）

#### 将来的な拡張性

現在は`context`と`acceptance`に全情報を含めることでタスクが自己完結的に実行可能。

**Phase 5.4（直列タスクサポート）実装後**は、以下のフローもサポート可能:
1. **仕様書作成タスク**: 詳細な要件/設計文書を作成
2. **実装タスク**: その文書を`context`で参照して実装

例:
```json
{
  "description": "Implement authentication based on spec",
  "type": "implementation",
  "context": "Refer to auth-spec.md created in previous task for detailed requirements. Implement JWT authentication with bcrypt password hashing as specified.",
  "dependencies": ["Create authentication specification document"]
}
```

---

### 5.2 ジャッジによるタスク品質評価 【優先度: 高】【ステータス: ✅ 完了】

**完了日**: 2026-01-19

#### 問題点
- プランナーが生成したタスクの品質を誰も評価していない
- 不明確なタスクがそのまま実行されてしまう

#### 改善内容（実装済み）

**5.2.1 タスク生成直後の品質評価**

新しい関数 `judgeTaskQuality` の追加:
```typescript
interface TaskQualityJudgement {
  isAcceptable: boolean;
  issues: string[];
  suggestions: string[];
}

const judgeTaskQuality = async (
  taskBreakdowns: TaskBreakdown[],
  originalInstruction: string
): Promise<TaskQualityJudgement> => {
  // エージェントに品質評価を依頼
  const judgementPrompt = buildTaskQualityPrompt(taskBreakdowns, originalInstruction);
  const result = await runnerEffects.runClaudeAgent(
    judgementPrompt,
    appRepoPath,
    'claude-haiku-4-5-20250929', // 軽量モデル使用
  );

  return parseQualityJudgement(result.val.finalResponse);
};
```

**5.2.2 品質不足時の再生成フロー**

`planTasks`を拡張:
```typescript
const planTasks = async (userInstruction: string) => {
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    const taskBreakdowns = await generateTaskBreakdowns(userInstruction);
    const quality = await judgeTaskQuality(taskBreakdowns, userInstruction);

    if (quality.isAcceptable) {
      return saveAndReturnTasks(taskBreakdowns);
    }

    // フィードバックを含めて再生成
    userInstruction = appendFeedback(userInstruction, quality.issues, quality.suggestions);
    attempts++;
  }

  // 最大試行回数を超えた場合はエラー
  throw new Error('Failed to generate acceptable tasks after 3 attempts');
};
```

**5.2.3 実装統合**

`createPlannerOperations`内に`judgeTaskQuality`関数を追加し、`planTasks`で品質評価ループを実装:
- 最大3回までの再生成試行
- フィードバックを蓄積して次回のプロンプトに反映
- 品質評価エージェント失敗時はデフォルトで許容（可用性優先）

#### 実装ファイル
- `src/core/orchestrator/planner-operations.ts`: 品質評価ロジック、プロンプト、パーサー
- `src/core/orchestrator/orchestrate.ts`: PlannerDepsにjudgeModel追加
- `tests/unit/core/orchestrator/planner-operations.test.ts`: 品質評価テスト追加（8テスト）

#### テスト結果
- ユニットテスト: 31/31 パス ✅
- ビルド: 成功 ✅

#### 推定工数
6-8時間（実績: 約4時間）

---

### 5.3 並列実行サポート 【優先度: 高】【ステータス: ✅ 完了】

**完了日**: 2026-01-19

#### 問題点
- `maxWorkers`パラメータが存在するが、実際には直列実行されている（orchestrate.ts:122-193のforループ）
- タスク間の依存関係が考慮されていない

#### 改善内容（実装済み）

**5.3.1 型定義の拡張**

Task型とTaskBreakdownに`dependencies`フィールドを追加:
```typescript
// src/types/task.ts
export const TaskSchema = z.object({
  // ...
  dependencies: z.array(z.string().transform(taskId)).default([]),
});

// src/core/orchestrator/planner-operations.ts
export const TaskBreakdownSchema = z.object({
  id: z.string(),  // Planner段階でID割り当て
  // ...
  dependencies: z.array(z.string()).default([]),
});
```

**5.3.2 依存関係グラフモジュールの実装**

新規ファイル `src/core/orchestrator/dependency-graph.ts`:
- `buildDependencyGraph`: タスク間の依存関係グラフを構築
- `detectCycles`: Tarjan's SCCアルゴリズムで循環依存を検出
- `computeExecutionLevels`: Kahn's Algorithmでトポロジカルソート、実行レベルを計算

**5.3.3 並列実行器の実装**

新規ファイル `src/core/orchestrator/parallel-executor.ts`:
- `executeLevelParallel`: 同レベルのタスクを`Promise.allSettled`で並列実行
- `computeBlockedTasks`: 失敗タスクの依存先を自動的にブロック

**5.3.4 Orchestrator統合**

`src/core/orchestrator/orchestrate.ts`の`executeInstruction`を書き換え:
```typescript
// 1. すべてのタスクを取得して依存関係グラフを構築
const tasks: Task[] = [];
for (const rawTaskId of taskIds) {
  const taskResult = await deps.taskStore.readTask(taskId(rawTaskId));
  tasks.push(taskResult.val);
}
const graph = buildDependencyGraph(tasks);

// 2. 循環依存をチェック
if (graph.cyclicDependencies && graph.cyclicDependencies.length > 0) {
  // 循環依存タスクをBLOCKEDにする
}

// 3. 実行レベルを計算
const { levels, unschedulable } = computeExecutionLevels(graph);

// 4. レベルごとに並列実行
for (let levelIndex = 0; levelIndex < levels.length; levelIndex++) {
  const level = levels[levelIndex];
  const levelResult = await executeLevelParallel(
    level,
    schedulerOps,
    workerOps,
    judgeOps,
    schedulerState,
    blockedTaskIds,
  );

  // 失敗タスクの依存先をブロック
  const newBlocked = computeBlockedTasks(levelResult.failed, graph);
}
```

**5.3.5 プランナープロンプトの拡張**

`buildPlanningPrompt`にIDと依存関係の説明を追加:
```
IMPORTANT: You must assign a unique ID to each task. Use the format "task-1", "task-2", etc.
When one task depends on another, reference it by ID in the dependencies array.

For each task, provide:
1. id: Unique task identifier (e.g., "task-1", "task-2")
...
9. dependencies: Array of task IDs this task depends on (REQUIRED)
   - Empty array [] if the task has no dependencies
   - List task IDs that must be completed BEFORE this task can start
```

#### 実装ファイル
- `src/types/task.ts`: Task型に`dependencies`フィールド追加
- `src/core/orchestrator/planner-operations.ts`: TaskBreakdownに`id`と`dependencies`追加
- `src/core/orchestrator/dependency-graph.ts`: 依存関係グラフ構築・循環依存検出・レベル計算（新規）
- `src/core/orchestrator/parallel-executor.ts`: 並列実行ロジック（新規）
- `src/core/orchestrator/orchestrate.ts`: 並列実行統合
- `tests/unit/core/orchestrator/dependency-graph.test.ts`: 依存関係グラフテスト（新規、11テスト）
- `tests/unit/core/orchestrator/planner-operations.test.ts`: 既存テスト更新

#### エラーハンドリング戦略
- 循環依存検出時: 該当タスクをBLOCKED、他は続行
- 依存タスク失敗時: 後続タスクをBLOCKED、同レベル他タスクは続行
- 並列実行中の1タスク失敗: 同レベル他タスクは続行

#### テスト結果
- ユニットテスト: 41/41 パス ✅
- ビルド: 成功 ✅

#### 実行フロー
```
Level 0: [A, B]     ← 依存なし、並列実行
Level 1: [C]        ← A,Bに依存
Level 2: [D, E, F]  ← Cに依存、並列実行
```

#### 推定工数
8-12時間（実績: 約10時間）

---

### 5.4 直列タスクの変更統合 【優先度: 中】【ステータス: ✅ 完了】

**完了日**: 2026-01-19

#### 問題点
- 直列タスクの場合、前のタスクの変更結果を次のタスクが受け取れない
- 各worktreeに結果が散らばったまま

#### 改善内容（実装済み）

**5.4.1 直列タスクの検出**

依存関係グラフから直列チェーンを検出:
```typescript
const detectSerialChains = (taskGraph: DependencyGraph): TaskId[][] => {
  // A -> B -> C のような直線的な依存関係を検出
  return findLinearDependencyChains(taskGraph);
};
```

**5.4.2 同一worktreeでの実行**

直列チェーンは同じworktreeを再利用:
```typescript
const executeSerialChain = async (chain: TaskId[]) => {
  let worktreePath = null;

  for (const taskId of chain) {
    if (!worktreePath) {
      // 最初のタスク: 新しいworktreeを作成
      worktreePath = await createWorktree(taskId);
    } else {
      // 後続タスク: 既存のworktreeを再利用
      // 前のタスクの変更をコミット
      await commitChanges(worktreePath, taskId);
    }

    await executeTaskInWorktree(taskId, worktreePath);
  }

  // チェーン完了後にworktreeをクリーンアップ
  await cleanupWorktree(worktreePath);
};
```

**5.4.3 フィードバックの伝達**

前のタスクの実行結果を次のタスクに渡す:
```typescript
const executeTaskInWorktree = async (
  taskId: TaskId,
  worktreePath: WorktreePath,
  previousTaskFeedback?: string
) => {
  const prompt = previousTaskFeedback
    ? `Execute task: ${task.acceptance}\n\nPrevious task feedback:\n${previousTaskFeedback}`
    : `Execute task: ${task.acceptance}`;

  // エージェント実行
  const result = await runAgent(prompt, worktreePath);

  return {
    success: result.success,
    feedback: extractFeedback(result.output),
  };
};
```

#### 実装ファイル
- `src/core/orchestrator/dependency-graph.ts`: `detectSerialChains`関数を追加
- `src/core/orchestrator/worker-operations.ts`: `executeTaskInExistingWorktree`関数を追加
- `src/core/orchestrator/serial-executor.ts`: 直列チェーン実行ロジック（新規）
- `src/core/orchestrator/orchestrate.ts`: 直列チェーン実行を統合
- `tests/unit/core/orchestrator/dependency-graph.test.ts`: detectSerialChainsテスト追加（6テスト）

#### 実装の詳細

**直列チェーン検出アルゴリズム**:
- 入次数（依存先の数）と出次数（依存元の数）を計算
- 各タスクが厳密に1つの依存先と1つの依存元を持つチェーンを検出
- チェーンの長さが2以上のもののみ返す（単独タスクは並列実行の方が効率的）

**実行戦略**:
- 直列チェーンと並列タスクを分離
- 直列チェーンは順番に実行（同一worktreeを共有）
- 並列タスクは従来通りレベルベースで並列実行
- 各直列チェーン完了後にworktreeをクリーンアップ

**フィードバック伝達**:
- 前のタスクのRunIDを次のタスクに渡す
- プロンプトに前のタスクのフィードバックを含める
- ログに明示的に記録（`Worktree: <path> (reused)`）

#### テスト結果
- ユニットテスト: 47/47 パス ✅
- 新規テスト: detectSerialChains 6テスト追加
- ビルド: 成功 ✅

#### 推定工数
6-8時間（実績: 約6時間）

---

### 5.5 統合処理とコンフリクト解決 【優先度: 中】【ステータス: ✅ 完了】

**完了日**: 2026-01-19

#### 問題点
- 並列実行されたタスクの結果がそれぞれのworktreeに散らばっている
- 統合時にコンフリクトが発生する可能性
- 並列実行後、各タスクの変更は個別ブランチにpushされるが、統合されない

#### 改善内容（実装済み）

**5.5.1 型定義の追加**

新規ファイル `src/types/integration.ts`:
- `GitConflictInfo`: コンフリクト情報
- `ConflictContent`: コンフリクトの詳細内容
- `MergeResult`: マージ結果（成功/コンフリクト/失敗）
- `IntegrationResult`: 統合結果（統合済みタスク、コンフリクトタスク、解決タスクID）
- `IntegrationFinalResult`: 統合ブランチ取り込み方法（discriminated union: 'pr' | 'command'）
- `ConflictResolutionInfo`: コンフリクト解決情報

`src/types/errors.ts`に`GitMergeConflictError`を追加。

**5.5.2 GitEffectsインターフェース拡張**

`src/adapters/vcs/git-effects.ts`にマージ関連メソッドを追加:
- `merge`: ブランチをマージ（コンフリクト検出含む）
- `abortMerge`: 進行中のマージを中止
- `getConflictedFiles`: コンフリクトファイルのリスト取得
- `getConflictContent`: コンフリクト内容の詳細取得
- `markConflictResolved`: コンフリクト解決済みマーク

**5.5.3 simple-git-effectsの実装**

`src/adapters/vcs/simple-git-effects.ts`にマージ操作を実装:
- `merge`: simple-gitの`merge()`を使用、`GitResponseError`でコンフリクト検出
- `getConflictedFiles`: `status().conflicted`配列を取得
- `getConflictContent`: `git show :1:/:2:/:3:`でbase/ours/theirsを取得
- その他のマージ補助メソッド

**5.5.4 integration-operationsの実装**

新規ファイル `src/core/orchestrator/integration-operations.ts`:

主要関数:
- `integrateTasks`: 複数タスクブランチを統合ブランチ（`integration/merge-{timestamp}`）にマージ
- `createConflictResolutionTask`: コンフリクト発生時に解決タスクを自動生成
- `buildConflictResolutionPrompt`: コンフリクト解決用の詳細プロンプトを構築
- `collectConflictDetails`: コンフリクト詳細情報を収集
- `finalizeIntegration`: 統合ブランチの取り込み方法を決定

統合フロー:
1. 統合ブランチを作成（`integration/merge-{timestamp}`）
2. 各タスクのブランチを順番にマージ
3. コンフリクト発生時はアボートして解決タスクを生成
4. 統合成功時：設定/オプションに基づいて処理
   - `pr`: GitHub CLIでPR作成（リモート必須、現時点では未実装）
   - `command`: マージコマンドを出力
   - `auto`（デフォルト）: リモートがあればPR、なければコマンド（現時点ではコマンド）

**5.5.5 設定の追加**

`src/types/config.ts`に統合設定を追加:
```typescript
integration: {
  method: 'pr' | 'command' | 'auto'  // デフォルト: 'auto'
}
```

**5.5.6 orchestrate.tsへの統合**

`src/core/orchestrator/orchestrate.ts`の`executeInstruction`に統合フェーズを追加:
- 完了タスクが複数ある場合のみ統合を実行
- 統合結果に基づいてユーザーに適切な情報を表示
- コンフリクト発生時は解決タスクIDを表示

#### 実装ファイル
- `src/types/integration.ts`: 統合関連の型定義（新規）
- `src/types/errors.ts`: GitMergeConflictError追加
- `src/types/config.ts`: 統合設定追加
- `src/adapters/vcs/git-effects.ts`: マージ関連メソッド追加
- `src/adapters/vcs/simple-git-effects.ts`: マージ操作の実装
- `src/core/orchestrator/integration-operations.ts`: 統合処理ロジック（新規）
- `src/core/orchestrator/orchestrate.ts`: 統合フェーズ追加
- `tests/unit/core/orchestrator/integration-operations.test.ts`: 統合処理テスト（新規、12テスト）
- `tests/unit/adapters/vcs/simple-git-effects-merge.test.ts`: マージ機能テストプレースホルダー（新規）

#### テスト結果
- ユニットテスト: 59/59 パス ✅
- ビルド: 成功 ✅
- Lint: 成功 ✅

#### 推定工数
11-12時間（実績: 約11時間）

#### 備考
- PR作成機能（GitHub CLI統合）は将来の実装予定
- 現時点では統合ブランチのマージコマンドを出力する形で運用

---

### 5.6 ジャッジ判定の高度化 【優先度: 中】

#### 問題点
- 現在の判定が単純すぎる（RUNNING = 成功）
- タスク内容に対する十分性を評価していない

#### 改善内容

**5.6.1 エージェントベースの判定**

`judgeTask`をエージェント呼び出しに置き換え:
```typescript
const judgeTask = async (tid: TaskId): Promise<Result<JudgementResult, TaskStoreError>> => {
  const taskResult = await deps.taskStore.readTask(tid);
  if (!taskResult.ok) return createErr(taskResult.err);

  const task = taskResult.val;

  // 実行ログを読み込み
  const runLog = await loadTaskRunLog(tid);

  // エージェントに判定を依頼
  const judgementPrompt = buildJudgementPrompt(task, runLog);
  const result = await runnerEffects.runClaudeAgent(
    judgementPrompt,
    appRepoPath,
    'claude-haiku-4-5-20250929', // 軽量モデル使用
  );

  return parseJudgementResult(result.val.finalResponse);
};
```

**5.6.2 判定プロンプト**

```typescript
const buildJudgementPrompt = (task: Task, runLog: string): string => {
  return `You are a task completion judge.

TASK ACCEPTANCE CRITERIA:
${task.acceptance}

EXECUTION LOG:
${runLog}

Your task:
1. Determine if the acceptance criteria were met
2. Check if the implementation is complete and functional
3. Identify any missing requirements or issues

Output (JSON):
{
  "success": true/false,
  "reason": "Detailed explanation",
  "missingRequirements": ["req1", "req2"],
  "shouldContinue": true/false
}`;
};
```

#### 推定工数
4-6時間

---

### 5.7 全体完了判定 【優先度: 中】

#### 問題点
- 全タスク完了後に、本当に元の指示が達成されたかを確認していない

#### 改善内容

**5.7.1 最終判定フェーズの追加**

`executeInstruction`の最後に最終判定を追加:
```typescript
const executeInstruction = async (userInstruction: string) => {
  // ... 既存のタスク実行 ...

  // 全タスク完了後の最終判定
  const finalJudgement = await judgeFinalCompletion(
    userInstruction,
    completedTaskIds,
    failedTaskIds
  );

  if (!finalJudgement.isComplete) {
    console.log('⚠️  Original instruction not fully satisfied. Generating additional tasks...');

    // 追加タスクを生成
    const additionalTasks = await planAdditionalTasks(
      userInstruction,
      finalJudgement.missingAspects
    );

    // 追加タスクを実行
    return executeAdditionalTasks(additionalTasks);
  }

  return createOk({ success: true, ... });
};
```

**5.7.2 最終判定プロンプト**

```typescript
const buildFinalJudgementPrompt = (
  instruction: string,
  completedTasks: Task[],
  failedTasks: Task[]
): string => {
  return `You are judging if the original user instruction was fully completed.

ORIGINAL INSTRUCTION:
${instruction}

COMPLETED TASKS:
${completedTasks.map(t => `- ${t.acceptance}`).join('\n')}

FAILED TASKS:
${failedTasks.map(t => `- ${t.acceptance}`).join('\n')}

Your task:
1. Determine if the original instruction is fully satisfied
2. Identify any missing aspects
3. Suggest additional tasks if needed

Output (JSON):
{
  "isComplete": true/false,
  "missingAspects": ["aspect1", "aspect2"],
  "additionalTaskSuggestions": ["task1", "task2"]
}`;
};
```

#### 推定工数
4-6時間

---

### 5.8 プランナーの継続性 【優先度: 低】

#### 問題点
- プランナーが前回のやり取りを継続できない
- 追加タスク生成時に前回のコンテキストが失われる

#### 改善内容

**5.8.1 会話履歴の保存**

```typescript
interface PlannerSession {
  sessionId: string;
  instruction: string;
  conversationHistory: { role: string; content: string }[];
  generatedTasks: TaskBreakdown[];
}

const savePlannerSession = async (session: PlannerSession): Promise<void> => {
  await fs.writeFile(
    `${coordRepoPath}/planner-sessions/${session.sessionId}.json`,
    JSON.stringify(session, null, 2)
  );
};
```

**5.8.2 会話履歴を使った追加タスク生成**

```typescript
const planAdditionalTasks = async (
  sessionId: string,
  missingAspects: string[]
) => {
  const session = await loadPlannerSession(sessionId);

  const prompt = `
Previous conversation:
${session.conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n\n')}

Based on the above context, the following aspects are still missing:
${missingAspects.join('\n')}

Generate additional tasks to address these missing aspects.
`;

  // エージェント呼び出し
  const result = await runClaudeAgent(prompt, ...);

  // 会話履歴を更新
  session.conversationHistory.push(
    { role: 'user', content: prompt },
    { role: 'assistant', content: result.val.finalResponse }
  );
  await savePlannerSession(session);

  return parseAgentOutput(result.val.finalResponse);
};
```

#### 推定工数
4-6時間

---

### 5.9 モデルの使い分け 【優先度: 低】【ステータス: ✅ 完了】

**完了日**: 2026-01-19

#### 問題点
- すべての役割で同じモデルを使用している
- コスト効率が悪い

#### 改善内容

**5.9.1 役割別モデル定義**

```typescript
const MODEL_CONFIG = {
  planner: 'claude-opus-4-5-20251101',    // 高度な計画能力が必要
  worker: 'claude-sonnet-4-5-20250929',   // バランス型
  judge: 'claude-haiku-4-5-20250929',     // 軽量で高速
  qualityCheck: 'claude-haiku-4-5-20250929', // 軽量で高速
  conflictResolution: 'claude-sonnet-4-5-20250929', // 中程度の複雑さ
} as const;
```

**5.9.2 各操作での適用**

```typescript
// Planner
const runResult = await deps.runnerEffects.runClaudeAgent(
  planningPrompt,
  deps.appRepoPath,
  MODEL_CONFIG.planner,  // Opus使用
);

// Judge
const result = await runnerEffects.runClaudeAgent(
  judgementPrompt,
  appRepoPath,
  MODEL_CONFIG.judge,  // Haiku使用
);

// Worker
const agentResult = await deps.runnerEffects.runClaudeAgent(
  agentPrompt,
  worktreePath,
  MODEL_CONFIG.worker,  // Sonnet使用
);
```

#### 推定工数
2-3時間

#### 実装結果

**実装ファイル**:
- `src/core/config/models.ts` - 役割別エージェント設定（新規作成）
- `src/core/orchestrator/planner-operations.ts` - Planner でのモデル適用
- `src/core/orchestrator/worker-operations.ts` - Worker でのモデル適用

**実装内容**:
1. `AGENT_CONFIG` 定数を定義（エージェントタイプとモデルのペア）
2. Planner で `AGENT_CONFIG.planner.model` (Opus) を使用
3. Worker で `AGENT_CONFIG.worker.model` (Sonnet) を使用
4. Judge は Phase 5.6 で対応予定（現在はエージェント呼び出しなし）

**効果**:
- Planner に高性能な Opus を使用することで、タスク分解の品質向上
- Worker に Sonnet を使用することで、実装とコストのバランスを維持
- Judge に Haiku を使用することで、判定処理の高速化とコスト削減（Phase 5.6 実装時）

---

## 新規観点の実装順序

### 推奨実装順序

1. **Phase 5.9**: モデルの使い分け（2-3時間）
   - 即座にコスト削減効果
   - 他のフェーズの実装コストも下がる

2. **Phase 5.1**: プランナーの品質向上（4-6時間）
   - タスク品質の基盤改善
   - 後続フェーズの効果を高める

3. **Phase 5.2**: ジャッジによるタスク品質評価（6-8時間）
   - プランナー改善と相乗効果
   - 品質保証の基盤

4. **Phase 5.3**: 並列実行サポート（8-12時間）
   - パフォーマンス大幅改善
   - ユーザー体験の向上

5. **Phase 5.4**: 直列タスクの変更統合（6-8時間）
   - 並列実行と組み合わせて真価を発揮

6. **Phase 5.5**: 統合処理とコンフリクト解決（8-10時間）
   - 並列実行の完成形

7. **Phase 5.6**: ジャッジ判定の高度化（4-6時間）
   - 品質保証の完成

8. **Phase 5.7**: 全体完了判定（4-6時間）
   - システムの自律性向上

9. **Phase 5.8**: プランナーの継続性（4-6時間）
   - より高度な使用ケースへの対応

### クイックウィン（優先実装）

時間が限られている場合は、以下の順序を推奨:

1. **Phase 5.9**: モデルの使い分け（2-3時間）
2. **Phase 5.1**: プランナーの品質向上（4-6時間）
3. **Phase 5.2**: ジャッジによるタスク品質評価（6-8時間）

これらだけで、タスク品質が大幅に向上し、コストも削減できる。

---

## 関連ドキュメント

- [current-issues.md](./current-issues.md) - 現在の問題点
- [docs/architecture.md](../../docs/architecture.md) - アーキテクチャドキュメント
- [README.md](../../README.md) - プロジェクトREADME
