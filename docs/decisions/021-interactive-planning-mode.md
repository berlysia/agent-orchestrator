# ADR-021: Interactive Planning Mode

## ステータス

**Proposed** 📝

## 提案日時

2026-01-27

## 背景

現在のAgent Orchestratorは、ユーザーの指示を受けて直接タスク分解を行う（PlannerSession）。しかし、以下の課題がある：

- **要件の曖昧性**: ユーザーの初期指示が抽象的な場合、Plannerが意図を正確に把握できない
- **設計決定の透明性不足**: 複数の実装アプローチがある場合、Plannerが自動選択し、ユーザーの意図と乖離する可能性がある
- **仕様変更のコスト**: タスク実行後に要件齟齬が発覚すると、大規模な再実行が必要になる
- **事前検証の欠如**: 実装前に設計の妥当性を確認する手段がない

## 決定

タスク実行前に**Interactive Planning Mode**を導入する。ユーザーと対話しながら要件を明確化・設計を決定し、承認後に既存のPlannerSessionへ引き継ぐ。

### 1. PlanningSessionの導入

PlannerSessionとは**責務を分離**した新しいセッション種別：

| セッション | 責務 | フェーズ |
|-----------|------|---------|
| **PlanningSession** | 要件明確化・設計決定・仕様確定 | DISCOVERY → DESIGN → REVIEW → APPROVED |
| **PlannerSession** | タスク分解・実行管理・統合 | PLANNING → EXECUTING → INTEGRATING → COMPLETED |

### 2. PlanningSession状態遷移

```
DISCOVERY    : 要件明確化（質問生成・回答収集）
    ↓
DESIGN       : 設計選択（オプション提示・決定記録）
    ↓
REVIEW       : レビュー・承認（サマリー確認）
    ↓ (approve)
APPROVED     : 承認済み（PlannerSessionへ移行）

REVIEW → (reject) → DESIGN  : 拒否時はDESIGNに戻る（最大3回まで）

任意の状態 → CANCELLED    : ユーザーが明示的にキャンセル
任意の状態 → FAILED       : LLM呼び出し失敗等の異常系
```

**状態遷移の詳細**:

| 遷移 | 条件 | 次状態 |
|------|------|--------|
| DISCOVERY → DESIGN | 全質問に回答完了 | DESIGN |
| DESIGN → REVIEW | 全DecisionPointで選択完了 | REVIEW |
| REVIEW → APPROVED | ユーザーが承認 | APPROVED |
| REVIEW → DESIGN | ユーザーが拒否（rejectCount < 3） | DESIGN |
| REVIEW → CANCELLED | ユーザーが拒否（rejectCount >= 3） | CANCELLED |
| 任意 → CANCELLED | ユーザーが明示的にキャンセル | CANCELLED |
| 任意 → FAILED | LLM呼び出し失敗等 | FAILED |

### 3. 対話フロー

```
┌─────────────────────────────────────────┐
│ 1. Discovery Phase                       │
│    - LLMが指示内容に応じて質問を生成     │
│    - ユーザーが順番に回答                │
│    - 全質問回答後、次フェーズへ          │
├─────────────────────────────────────────┤
│ 2. Design Phase                          │
│    - LLMが選択肢を生成                   │
│    - 各DecisionPointでPros/Cons提示      │
│    - ユーザーが選択・理由入力            │
├─────────────────────────────────────────┤
│ 3. Review Phase                          │
│    - 設計サマリーを生成・表示            │
│    - ユーザーが承認/却下                 │
│    - 承認後、実行確認プロンプト：        │
│      → Yes: 自動でタスク分解・実行開始   │
│      → No: コマンド表示のみ              │
└─────────────────────────────────────────┘
```

### 4. CLIコマンド

```bash
# 新規計画セッション開始
agent plan "認証機能を追加"

# 既存セッション再開（ID指定）
agent plan --resume planning-abc123

# 既存セッション再開（ID省略 → リスト表示して選択）
agent plan --resume
```

### 5. データモデル

#### PlanningSession型

```typescript
export const PlanningSessionStatus = {
  DISCOVERY: 'discovery',
  DESIGN: 'design',
  REVIEW: 'review',
  APPROVED: 'approved',
  CANCELLED: 'cancelled',
  FAILED: 'failed',  // LLM呼び出し失敗等の異常系
} as const;

export const PlanningSessionSchema = z.object({
  sessionId: z.string(),               // planning-<UUID>
  instruction: z.string(),             // 元のユーザー指示
  status: z.nativeEnum(PlanningSessionStatus),

  // 現在位置の状態管理（セッション再開に必要）
  currentQuestionIndex: z.number().int().min(0).default(0),
  currentDecisionIndex: z.number().int().min(0).default(0),

  questions: z.array(QuestionSchema),
  decisions: z.array(DecisionPointSchema),
  designSummary: z.string().nullable(),

  // 会話履歴（Discovery/Design/Review各フェーズのLLM対話を記録）
  conversationHistory: z.array(ConversationMessageSchema),

  // 拒否カウント（REVIEW → DESIGN ループの制限）
  rejectCount: z.number().int().min(0).default(0),

  // エラー情報（FAILED状態時）
  errorMessage: z.string().nullable().optional(),

  // PlannerSessionとの連携
  plannerSessionId: z.string().nullable(), // 承認後のリンク

  // ログパス（デバッグ用）
  discoveryLogPath: z.string().nullable().optional(),
  designLogPath: z.string().nullable().optional(),
  reviewLogPath: z.string().nullable().optional(),

  createdAt: z.string(),
  updatedAt: z.string(),
});
```

**フィールド設計の根拠**:

| フィールド | 目的 | WHY |
|-----------|------|-----|
| `currentQuestionIndex` | セッション再開位置 | 「どこまで進んだか」を判定するため |
| `currentDecisionIndex` | セッション再開位置 | Design Phaseの途中から再開するため |
| `rejectCount` | ループ制限 | 無限ループ防止（最大3回まで拒否可能） |
| `errorMessage` | 異常系の記録 | FAILED状態時のエラー内容を保存 |
| `discoveryLogPath` | デバッグログ | LLM呼び出しログを保存（トラブルシューティング用） |

#### Question型

```typescript
export const QuestionSchema = z.object({
  id: z.string(),                      // q-1, q-2, etc.
  type: z.enum(['clarification', 'scope', 'technical', 'priority', 'constraint']),
  question: z.string(),
  context: z.string().optional(),      // この質問が重要な理由
  options: z.array(z.string()).optional(), // 選択肢（あれば）
  answer: z.string().nullable(),       // ユーザーの回答
  answeredAt: z.string().nullable(),
});
```

#### DecisionPoint型

```typescript
export const DecisionPointSchema = z.object({
  id: z.string(),                      // d-1, d-2, etc.
  topic: z.string(),                   // 決定事項
  options: z.array(z.object({
    id: z.string(),                    // opt-a, opt-b, etc.
    name: z.string(),
    description: z.string(),
    tradeoffs: z.object({
      pros: z.array(z.string()),
      cons: z.array(z.string()),
    }),
    recommendation: z.boolean().optional(),
  })),
  selectedOptionId: z.string().nullable(),
  rationale: z.string().nullable(),    // 選択理由
  decidedAt: z.string().nullable(),
});
```

### 6. PlannerSession連携

`approvePlan()` 実行時、以下のプロセスでPlannerSessionへ引き継ぐ：

1. 質問回答・決定をコンテキストとして整形
2. 強化されたinstructionを構築（元の指示 + 明確化された要件 + 設計決定）
3. 既存の `plannerOps.planTasks()` を呼び出し
4. PlannerSessionIdをPlanningSessionに記録
5. ステータスをAPPROVEDに更新

```typescript
const buildEnhancedInstruction = (session: PlanningSession): string => {
  // 大きく影響する質問のみ含める（clarification, scope, technical）
  const criticalQuestions = session.questions
    .filter(q => ['clarification', 'scope', 'technical'].includes(q.type))
    .map(q => `- ${q.question}\n  Answer: ${q.answer}`)
    .join('\n');

  // 選択理由（rationale）を含める
  const decisionsWithRationale = session.decisions.map(d => {
    const selected = d.options.find(o => o.id === d.selectedOptionId);
    return `- ${d.topic}: ${selected?.name}\n  Reason: ${d.rationale || 'N/A'}`;
  }).join('\n');

  return `
Original Instruction: ${session.instruction}

## Clarified Requirements
${criticalQuestions}

## Design Decisions
${decisionsWithRationale}

## Design Summary
${session.designSummary}
  `.trim();
};
```

**設計方針**:
- 大きく影響する質問タイプ（clarification, scope, technical）のみ含める
- priority, constraint は designSummary に集約されるため省略
- 選択理由（rationale）を含めることで、「なぜこの選択をしたか」を明確化
- 無駄なトークン消費を避けつつ、重要な情報は確実に伝える

## 設計決定

| 項目 | 決定 | 理由 |
|------|------|------|
| 責務分離 | PlanningSession/PlannerSessionを分離 | 単一責任原則、既存ロジックの保護 |
| 状態遷移 | DISCOVERY → DESIGN → REVIEW → APPROVED | 段階的な仕様確定プロセス |
| reject処理 | REVIEW → DESIGN ループ（最大3回） | 無限ループ防止、過度な再設計を避ける |
| FAILED状態 | 異常系の明示的表現 | LLM失敗、ネットワークエラー等を記録 |
| 現在位置管理 | currentQuestionIndex, currentDecisionIndex | セッション再開に必須 |
| 質問タイプ | 5種類（clarification/scope/technical/priority/constraint） | 異なる側面の要件を網羅 |
| DecisionPoint構造 | ID付きOptions + Pros/Cons + rationale | 構造化された意思決定記録 |
| PlannerSession連携 | enhancedInstruction経由（トークン最適化） | 既存APIとの互換性維持 |
| セッションID形式 | `planning-<UUID>` | PlannerSessionとの識別性 |
| --resume動作 | ID省略時にリスト表示 | UX向上（最近のセッションから選択） |
| 承認後の実行確認 | プロンプトでYes/No選択 | 即座実行と手動実行の柔軟性 |
| ログ保存 | discoveryLogPath, designLogPath, reviewLogPath | デバッグとトラブルシューティング |

## 検証方法

```bash
# 1. 新規計画セッション
agent plan "ユーザー認証機能を追加"

# 2. 対話フローを確認（Discovery → Design → Review）
# 3. 承認後、生成されたPlannerSessionを確認
agent status --session <generated-session-id>

# 4. セッション再開
agent plan --resume
# → リスト表示から選択

# 5. 既存セッション確認
agent plan --resume planning-abc123
```

## 影響

### 新規ファイル

| ファイル | 役割 |
|----------|------|
| `src/types/planning-session.ts` | 型定義（PlanningSession, Question, DecisionPoint） |
| `src/core/orchestrator/planning-session-effects.ts` | ストレージインターフェース |
| `src/core/orchestrator/planning-session-effects-impl.ts` | ストレージ実装 |
| `src/core/orchestrator/planning-operations.ts` | コアロジック |
| `src/cli/commands/plan.ts` | CLIコマンド |
| `tests/unit/planning-session-effects.test.ts` | ユニットテスト |
| `tests/e2e/cli-plan.test.ts` | E2Eテスト |

### 変更ファイル

| ファイル | 変更内容 |
|----------|----------|
| `src/cli/index.ts` | `createPlanCommand()` 登録 |
| `src/cli/utils/prompt.ts` | `promptFreeText()` 追加 |
| `src/types/branded.ts` | `PlanningSessionId` 追加（オプション） |

### 後方互換性

既存の `agent run` および `agent continue` コマンドは影響を受けない。PlanningSessionは完全に新規機能として追加される。

## 代替案

### Option A: PlannerSessionを拡張

既存のPlannerSessionに対話フェーズを追加する。

**却下理由**:
- 単一責任原則に反する（対話と実行を混在）
- 既存コードの複雑性増大
- 既存の動作に影響を与えるリスク

### Option B: PlanningSessionを独立（採用）

新しいPlanningSessionを導入し、PlannerSessionと責務を分離する。

**採用理由**:
- 単一責任原則の遵守
- 既存ロジックへの影響を最小化
- テストとメンテナンスが容易

## 参考リンク

- [Architecture Document](../architecture.md)
- [PlannerSession型定義](../../src/types/planner-session.ts)
- [ADR-020: 階層化コンフィグシステム](020-layered-config-system.md)

## 実装チェックリスト

### Phase 1: Foundation（型・ストレージ）
- [ ] 型定義の作成（planning-session.ts）
- [ ] ストレージインターフェース（planning-session-effects.ts）
- [ ] ストレージ実装（planning-session-effects-impl.ts）
- [ ] ユニットテスト（planning-session-effects.test.ts）

### Phase 2: Core Operations
- [ ] コアロジックの実装（planning-operations.ts）
- [ ] Discovery/Design/Reviewプロンプト設計
- [ ] PlannerSession連携（approvePlan()）
- [ ] ユニットテスト（planning-operations.test.ts）

### Phase 3: CLI Integration
- [ ] promptFreeText()追加（prompt.ts）
- [ ] CLIコマンド実装（plan.ts）
- [ ] コマンド登録（index.ts）
- [ ] E2Eテスト（cli-plan.test.ts）

### Phase 4: Documentation
- [ ] ADR作成（本文書）
- [ ] アーキテクチャドキュメント更新

## エッジケース処理

| シナリオ | 処理方針 |
|----------|----------|
| **質問に回答しない** | タイムアウト（5分）後、スキップオプション提示。スキップした質問は `answer: null` として記録 |
| **承認を拒否（reject）** | DESIGN Phaseに戻る。rejectCount をインクリメント。3回目の拒否でCANCELLED状態に遷移 |
| **セッション保存失敗** | Result型でエラー返却。リトライ戦略（最大3回）。ユーザーにエラーメッセージ表示 |
| **LLM呼び出し失敗** | FAILED状態に遷移。errorMessage にエラー内容を記録。ログファイルにスタックトレース保存 |
| **並行セッション** | 許可する。異なるsessionIdで識別。ファイルシステムベースのため競合なし |
| **セッション再開時の状態不整合** | currentQuestionIndex/currentDecisionIndex から再開位置を判定。不整合時はDISCOVERYから再開 |
| **conversationHistory肥大化** | 最新100メッセージのみ保持。古いメッセージは要約してログファイルに移動 |
| **designSummaryがnull** | REVIEW Phase開始時に必須チェック。null時はDESIGN Phaseに戻す |

## 参考: PlanningSession Storage Structure

```
.agent/
├── planning-sessions/
│   └── planning-<uuid>.json          # PlanningSession本体
└── logs/
    └── planning-<uuid>/
        ├── discovery.log              # Discovery PhaseのLLM呼び出しログ
        ├── design.log                 # Design PhaseのLLM呼び出しログ
        └── review.log                 # Review PhaseのLLM呼び出しログ
```

各ファイルは `PlanningSession` 型のJSONとして保存される。
