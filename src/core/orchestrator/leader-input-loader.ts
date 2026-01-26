import type { Result } from 'option-t/plain_result';
import { createOk, createErr, isErr } from 'option-t/plain_result';
import type { TaskStoreError } from '../../types/errors.ts';
import { ioError } from '../../types/errors.ts';
import type { TaskBreakdown } from '../../types/task-breakdown.ts';
import { TaskBreakdownSchema } from '../../types/task-breakdown.ts';
import type { PlannerSessionEffects } from './planner-session-effects.ts';
import type { RunnerEffects } from '../runner/runner-effects.ts';
import * as fs from 'node:fs/promises';
import { z } from 'zod';

/**
 * Leader 入力データ
 *
 * Leader セッションを開始するための入力情報を統一形式で保持
 */
export interface LeaderInput {
  /** 元のユーザー指示 */
  instruction: string;
  /** タスク一覧 */
  tasks: TaskBreakdown[];
  /** 計画文書の内容（パターンBの場合のみ） */
  planDocumentContent?: string;
  /** ソース種別 */
  sourceType: 'planner-session' | 'plan-document';
}

/**
 * パターン A: PlannerSession 経由でデータを読み込み
 *
 * PlannerSession の generatedTasks と instruction を直接使用
 * LLM 解釈は不要で、既にバリデーション済みのデータを取得
 *
 * @param sessionId PlannerSession ID
 * @param sessionEffects PlannerSessionEffects インスタンス
 * @returns LeaderInput
 */
export async function loadFromPlannerSession(
  sessionId: string,
  sessionEffects: PlannerSessionEffects,
): Promise<Result<LeaderInput, TaskStoreError>> {
  try {
    // PlannerSession を読み込み
    const loadResult = await sessionEffects.loadSession(sessionId);
    if (isErr(loadResult)) {
      return loadResult;
    }

    const session = loadResult.val;

    // generatedTasks が空の場合はエラー
    if (session.generatedTasks.length === 0) {
      return createErr(
        ioError(`PlannerSession ${sessionId} has no generated tasks. Cannot start Leader session.`),
      );
    }

    // LeaderInput を作成
    const leaderInput: LeaderInput = {
      instruction: session.instruction,
      tasks: session.generatedTasks,
      sourceType: 'planner-session',
    };

    return createOk(leaderInput);
  } catch (error) {
    return createErr(ioError(`Failed to load from PlannerSession: ${String(error)}`));
  }
}

/**
 * パターン B: 計画文書から直接読み込み
 *
 * Markdown 計画文書を LLM で解釈し、TaskBreakdown[] を抽出
 * - LLM に「タスクを抽出し JSON 配列で出力」とプロンプト
 * - TaskBreakdownSchema でバリデーション
 * - instruction は計画文書のタイトル/概要から推測
 *
 * @param filePath 計画文書のファイルパス
 * @param runnerEffects RunnerEffects インスタンス
 * @param agentType エージェント種別
 * @param model モデル名
 * @param workingDirectory 作業ディレクトリ（LLM実行用）
 * @returns LeaderInput
 */
export async function loadFromPlanDocument(
  filePath: string,
  runnerEffects: RunnerEffects,
  agentType: 'claude' | 'codex',
  model: string,
  workingDirectory: string,
): Promise<Result<LeaderInput, TaskStoreError>> {
  try {
    // 計画文書を読み込み
    const content = await fs.readFile(filePath, 'utf-8');

    // LLM にタスク抽出を依頼
    const prompt = `
You are a task extraction assistant. Extract task breakdown information from the following plan document.

**Requirements:**
1. Extract all tasks described in the document
2. For each task, provide:
   - id: Task ID in format "task-1", "task-2", etc. (starting from 1)
   - description: Task description
   - branch: Branch name for the task
   - scopePaths: Array of file paths this task will modify
   - acceptance: Acceptance criteria
   - type: Task type (implementation, documentation, investigation, or integration)
   - estimatedDuration: Estimated duration in hours (0.5-8)
   - context: Context information needed to complete the task
   - dependencies: Array of task IDs this task depends on (e.g., ["task-1", "task-2"])
   - summary: Brief summary (max 50 characters, optional)

3. Output the result as a **valid JSON array** only (no markdown code blocks, no explanations)
4. Ensure all required fields are present and valid

**Plan Document:**
${content}

**Output format example:**
[
  {
    "id": "task-1",
    "description": "Implement authentication module",
    "branch": "feature/auth",
    "scopePaths": ["src/auth/"],
    "acceptance": "Authentication works with JWT tokens",
    "type": "implementation",
    "estimatedDuration": 4,
    "context": "Need to implement JWT-based authentication",
    "dependencies": [],
    "summary": "Add JWT authentication"
  }
]

**Output (JSON array only):**
`.trim();

    // LLM 実行
    const runResult =
      agentType === 'claude'
        ? await runnerEffects.runClaudeAgent(prompt, workingDirectory, model)
        : await runnerEffects.runCodexAgent(prompt, workingDirectory, model);

    if (isErr(runResult)) {
      return createErr(ioError('loadFromPlanDocument.runAgent', runResult.err));
    }

    const llmOutput = runResult.val.finalResponse || '';

    // JSON 配列を抽出（マークダウンコードブロックをスキップ）
    let jsonStr = llmOutput.trim();
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch && codeBlockMatch[1]) {
      jsonStr = codeBlockMatch[1].trim();
    }

    // JSON パース
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(jsonStr);
    } catch (parseError) {
      return createErr(
        ioError(`Failed to parse LLM output as JSON: ${String(parseError)}\n\nOutput:\n${llmOutput}`),
      );
    }

    // TaskBreakdown[] としてバリデーション
    const tasksSchema = z.array(TaskBreakdownSchema);
    const validationResult = tasksSchema.safeParse(parsedJson);

    if (!validationResult.success) {
      return createErr(
        ioError(
          `LLM output does not match TaskBreakdown schema: ${validationResult.error.message}\n\nParsed JSON:\n${JSON.stringify(parsedJson, null, 2)}`,
        ),
      );
    }

    const tasks = validationResult.data;

    // instruction を推測（計画文書のタイトルまたは最初の行を使用）
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    let instruction = 'Execute plan from document';
    if (lines.length > 0) {
      // 最初の見出しを探す
      const firstHeading = lines.find((line) => line.startsWith('#'));
      if (firstHeading) {
        instruction = firstHeading.replace(/^#+\s*/, '').trim();
      } else if (lines[0]) {
        // 見出しがなければ最初の行を使用（最大100文字）
        instruction = lines[0].substring(0, 100);
      }
    }

    // LeaderInput を作成
    const leaderInput: LeaderInput = {
      instruction,
      tasks,
      planDocumentContent: content,
      sourceType: 'plan-document',
    };

    return createOk(leaderInput);
  } catch (error) {
    return createErr(ioError(`Failed to load from plan document: ${String(error)}`));
  }
}
