import type { RunnerEffects } from '../runner/runner-effects.ts';
import type { PlanningSessionEffects } from './planning-session-effects.ts';
import type { PlannerSessionEffects } from './planner-session-effects.ts';
import {
  createPlanningSession,
  PlanningSessionStatus,
  QuestionType,
  type PlanningSession,
  type Question,
  type DecisionPoint,
} from '../../types/planning-session.ts';
import { createPlannerSession } from '../../types/planner-session.ts';
import { randomUUID } from 'node:crypto';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr } from 'option-t/plain_result';
import type { TaskStoreError } from '../../types/errors.ts';
import { ioError } from '../../types/errors.ts';
import { z } from 'zod';
import path from 'node:path';

/**
 * Planning Operations Dependencies
 */
export interface PlanningOperationsDeps {
  readonly planningSessionEffects: PlanningSessionEffects;
  readonly plannerSessionEffects: PlannerSessionEffects;
  readonly runnerEffects: RunnerEffects;
  readonly appRepoPath: string;
  readonly agentType: 'claude' | 'codex';
  readonly plannerModel: string;
}

/**
 * Planning Operations Interface
 */
export interface PlanningOperations {
  /**
   * 新規セッション開始（Discovery Phase）
   */
  startNewSession(instruction: string): Promise<Result<PlanningSession, TaskStoreError>>;

  /**
   * 質問への回答記録
   */
  answerQuestion(
    session: PlanningSession,
    questionId: string,
    answer: string | null,
  ): Promise<Result<PlanningSession, TaskStoreError>>;

  /**
   * Design Phase遷移
   */
  transitionToDesignPhase(
    session: PlanningSession,
  ): Promise<Result<PlanningSession, TaskStoreError>>;

  /**
   * 設計決定記録
   */
  recordDecision(
    session: PlanningSession,
    decisionId: string,
    selectedOption: string,
    rationale?: string,
  ): Promise<Result<PlanningSession, TaskStoreError>>;

  /**
   * Review Phase遷移
   */
  transitionToReviewPhase(
    session: PlanningSession,
  ): Promise<Result<PlanningSession, TaskStoreError>>;

  /**
   * 承認処理（PlannerSession作成）
   */
  approvePlan(session: PlanningSession): Promise<Result<PlanningSession, TaskStoreError>>;

  /**
   * 拒否処理（Design Phaseに戻る、3回目でCANCELLED）
   */
  rejectPlan(
    session: PlanningSession,
    reason: string,
  ): Promise<Result<PlanningSession, TaskStoreError>>;
}

/**
 * 会話履歴を最新100メッセージに制限
 *
 * WHY: conversationHistoryの肥大化を防ぐ
 */
const pruneConversationHistory = (session: PlanningSession): PlanningSession => {
  if (session.conversationHistory.length <= 100) {
    return session;
  }

  return {
    ...session,
    conversationHistory: session.conversationHistory.slice(-100),
  };
};

/**
 * セッション再開位置を判定
 *
 * NOTE: Phase 3 (CLI) で使用される予定
 */
/*
const determineResumePoint = (
  session: PlanningSession,
): { phase: string; index: number } => {
  switch (session.status) {
    case PlanningSessionStatus.DISCOVERY:
      return { phase: 'discovery', index: session.currentQuestionIndex };
    case PlanningSessionStatus.DESIGN:
      return { phase: 'design', index: session.currentDecisionIndex };
    case PlanningSessionStatus.REVIEW:
      return { phase: 'review', index: 0 };
    default:
      throw new Error(`Cannot resume from ${session.status}`);
  }
};
*/

/**
 * Discovery用プロンプト生成（JSON出力を強制）
 */
const buildDiscoveryPrompt = (instruction: string): string => {
  return `You are a planning assistant. Based on the following instruction, generate 3-5 clarifying questions to better understand the requirements.

Instruction: ${instruction}

Generate questions in the following categories:
- clarification: Clarify ambiguous requirements
- scope: Confirm the scope of work
- technical: Technical implementation details
- priority: Priority or importance
- constraint: Constraints or limitations

Output the questions in JSON format:
{
  "questions": [
    {
      "id": "q1",
      "type": "clarification",
      "question": "Question text here?",
      "options": ["Option 1", "Option 2"] // optional, null for free text
    }
  ]
}

IMPORTANT: Output ONLY valid JSON. Do not include any explanatory text before or after the JSON.`;
};

/**
 * Design用プロンプト生成（JSON出力を強制）
 */
const buildDesignPrompt = (
  instruction: string,
  answeredQuestions: Array<{ question: string; answer: string | null }>,
): string => {
  const questionsText = answeredQuestions
    .map((q, i) => `Q${i + 1}: ${q.question}\nA${i + 1}: ${q.answer ?? 'Skipped'}`)
    .join('\n\n');

  return `You are a planning assistant. Based on the instruction and answered questions, generate 2-4 design decision points with options.

Instruction: ${instruction}

Answered Questions:
${questionsText}

Generate design decision points in JSON format:
{
  "decisionPoints": [
    {
      "id": "d1",
      "title": "Decision title",
      "description": "Detailed description of what needs to be decided",
      "options": [
        {
          "label": "Option 1",
          "pros": ["Pro 1", "Pro 2"],
          "cons": ["Con 1", "Con 2"]
        },
        {
          "label": "Option 2",
          "pros": ["Pro 1"],
          "cons": ["Con 1"]
        }
      ]
    }
  ]
}

IMPORTANT: Output ONLY valid JSON. Do not include any explanatory text before or after the JSON.`;
};

/**
 * Review用プロンプト生成
 */
const buildReviewPrompt = (
  instruction: string,
  answeredQuestions: Array<{ question: string; answer: string | null }>,
  decisions: Array<{ title: string; selectedOption: string; rationale?: string | null }>,
): string => {
  const questionsText = answeredQuestions
    .map((q, i) => `Q${i + 1}: ${q.question}\nA${i + 1}: ${q.answer ?? 'Skipped'}`)
    .join('\n\n');

  const decisionsText = decisions
    .map(
      (d, i) =>
        `D${i + 1}: ${d.title}\nSelected: ${d.selectedOption}\nRationale: ${d.rationale ?? 'None'}`,
    )
    .join('\n\n');

  return `You are a planning assistant. Create a comprehensive implementation plan based on the following information.

Original Instruction:
${instruction}

Requirements (from Q&A):
${questionsText}

Design Decisions:
${decisionsText}

Generate a detailed implementation plan with:
1. Summary of requirements
2. Architectural approach
3. Key design decisions and rationale
4. Implementation steps
5. Potential risks and mitigations

Format your response as a clear, structured document.`;
};

/**
 * PlannerSession連携用の強化指示文生成（トークン制限: 2000トークン）
 *
 * WHY: Planning Sessionで収集した情報をPlannerSessionに連携する
 */
const buildEnhancedInstruction = (
  instruction: string,
  questions: Question[],
  decisionPoints: DecisionPoint[],
): string => {
  // 重要な質問タイプでフィルタリング
  const importantQuestions = questions.filter(
    (q) =>
      q.type === QuestionType.CLARIFICATION ||
      q.type === QuestionType.SCOPE ||
      q.type === QuestionType.TECHNICAL,
  );

  const questionsText = importantQuestions
    .map((q) => `- ${q.question}: ${q.answer ?? 'Not answered'}`)
    .join('\n');

  const decisionsText = decisionPoints
    .map((d) => `- ${d.title}: ${d.selectedOption ?? 'Not decided'} (${d.rationale ?? ''})`)
    .join('\n');

  const enhanced = `# Original Instruction
${instruction}

# Requirements Clarification
${questionsText}

# Design Decisions
${decisionsText}

# Implementation Instructions
Based on the above requirements and decisions, create a detailed implementation plan.`;

  // トークン上限チェック（簡易計算: 文字数 / 4）
  const estimatedTokens = enhanced.length / 4;
  if (estimatedTokens > 2000) {
    // トークン上限超過時は質問を削減
    const reducedQuestions = importantQuestions.slice(0, 3);
    const reducedQuestionsText = reducedQuestions
      .map((q) => `- ${q.question}: ${q.answer ?? 'Not answered'}`)
      .join('\n');

    return `# Original Instruction
${instruction}

# Requirements Clarification (top 3)
${reducedQuestionsText}

# Design Decisions
${decisionsText}

# Implementation Instructions
Based on the above requirements and decisions, create a detailed implementation plan.`;
  }

  return enhanced;
};

/**
 * LLM出力から質問をパース（Zodバリデーション、エラー時1回リトライ）
 */
const parseQuestions = async (
  output: string,
  deps: PlanningOperationsDeps,
  instruction: string,
  retryCount: number = 0,
): Promise<Result<Question[], TaskStoreError>> => {
  try {
    // JSON部分を抽出（コードブロック対応）
    let jsonText = output.trim();
    if (jsonText.startsWith('```json')) {
      jsonText = jsonText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    const json = JSON.parse(jsonText);

    // Zodバリデーション
    const QuestionsOutputSchema = z.object({
      questions: z.array(
        z.object({
          id: z.string(),
          type: z.enum([
            QuestionType.CLARIFICATION,
            QuestionType.SCOPE,
            QuestionType.TECHNICAL,
            QuestionType.PRIORITY,
            QuestionType.CONSTRAINT,
          ]),
          question: z.string(),
          options: z.array(z.string()).nullable().optional(),
        }),
      ),
    });

    const parseResult = QuestionsOutputSchema.safeParse(json);
    if (!parseResult.success) {
      throw new Error(`Invalid questions format: ${parseResult.error.message}`);
    }

    // timestampを追加してQuestionに変換
    const now = new Date().toISOString();
    const questions: Question[] = parseResult.data.questions.map((q) => ({
      ...q,
      answer: null,
      timestamp: now,
    }));

    return createOk(questions);
  } catch (error) {
    if (retryCount >= 1) {
      return createErr(
        ioError('parseQuestions', error instanceof Error ? error : new Error(String(error))),
      );
    }

    // 1回リトライ（プロンプトに「JSON形式」を強調）
    const retryPrompt =
      buildDiscoveryPrompt(instruction) +
      '\n\nPrevious output was invalid. Please output ONLY valid JSON without any additional text.';

    const runResult =
      deps.agentType === 'claude'
        ? await deps.runnerEffects.runClaudeAgent(
            retryPrompt,
            deps.appRepoPath,
            deps.plannerModel,
          )
        : await deps.runnerEffects.runCodexAgent(retryPrompt, deps.appRepoPath);

    if (!runResult.ok) {
      return createErr(ioError('parseQuestions', new Error('Agent run failed on retry')));
    }

    const retryOutput = runResult.val.finalResponse ?? '';
    return parseQuestions(retryOutput, deps, instruction, retryCount + 1);
  }
};

/**
 * LLM出力から決定点をパース（Zodバリデーション、エラー時1回リトライ）
 */
const parseDecisionPoints = async (
  output: string,
  deps: PlanningOperationsDeps,
  instruction: string,
  answeredQuestions: Array<{ question: string; answer: string | null }>,
  retryCount: number = 0,
): Promise<Result<DecisionPoint[], TaskStoreError>> => {
  try {
    // JSON部分を抽出（コードブロック対応）
    let jsonText = output.trim();
    if (jsonText.startsWith('```json')) {
      jsonText = jsonText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    const json = JSON.parse(jsonText);

    // Zodバリデーション
    const DecisionPointsOutputSchema = z.object({
      decisionPoints: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          description: z.string(),
          options: z.array(
            z.object({
              label: z.string(),
              pros: z.array(z.string()),
              cons: z.array(z.string()),
            }),
          ),
        }),
      ),
    });

    const parseResult = DecisionPointsOutputSchema.safeParse(json);
    if (!parseResult.success) {
      throw new Error(`Invalid decision points format: ${parseResult.error.message}`);
    }

    // timestampを追加してDecisionPointに変換
    const now = new Date().toISOString();
    const decisionPoints: DecisionPoint[] = parseResult.data.decisionPoints.map((d) => ({
      ...d,
      selectedOption: null,
      rationale: null,
      timestamp: now,
    }));

    return createOk(decisionPoints);
  } catch (error) {
    if (retryCount >= 1) {
      return createErr(
        ioError(
          'parseDecisionPoints',
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
    }

    // 1回リトライ（プロンプトに「JSON形式」を強調）
    const retryPrompt =
      buildDesignPrompt(instruction, answeredQuestions) +
      '\n\nPrevious output was invalid. Please output ONLY valid JSON without any additional text.';

    const runResult =
      deps.agentType === 'claude'
        ? await deps.runnerEffects.runClaudeAgent(
            retryPrompt,
            deps.appRepoPath,
            deps.plannerModel,
          )
        : await deps.runnerEffects.runCodexAgent(retryPrompt, deps.appRepoPath);

    if (!runResult.ok) {
      return createErr(
        ioError('parseDecisionPoints', new Error('Agent run failed on retry')),
      );
    }

    const retryOutput = runResult.val.finalResponse ?? '';
    return parseDecisionPoints(
      retryOutput,
      deps,
      instruction,
      answeredQuestions,
      retryCount + 1,
    );
  }
};

/**
 * Planning Operations ファクトリー関数
 */
export const createPlanningOperations = (
  deps: PlanningOperationsDeps,
): PlanningOperations => {
  return {
    /**
     * 新規セッション開始（Discovery Phase）
     */
    async startNewSession(instruction: string): Promise<Result<PlanningSession, TaskStoreError>> {
      const sessionId = `planning-${randomUUID()}`;
      const session = createPlanningSession(sessionId, instruction);

      // Discovery Phase: 質問生成
      const prompt = buildDiscoveryPrompt(instruction);

      // LLM呼び出し
      const runResult =
        deps.agentType === 'claude'
          ? await deps.runnerEffects.runClaudeAgent(prompt, deps.appRepoPath, deps.plannerModel)
          : await deps.runnerEffects.runCodexAgent(prompt, deps.appRepoPath);

      if (!runResult.ok) {
        // LLM失敗時はFAILED状態に遷移
        const failedSession: PlanningSession = {
          ...session,
          status: PlanningSessionStatus.FAILED,
          errorMessage: `LLM invocation failed: ${runResult.err.message}`,
        };
        await deps.planningSessionEffects.saveSession(failedSession);
        return createErr(ioError('startNewSession', new Error(runResult.err.message)));
      }

      // ログ記録
      const logPath = path.join(
        deps.appRepoPath,
        '.agent',
        'logs',
        sessionId,
        'discovery.log',
      );
      const logContent = `=== Discovery Phase ===\n${prompt}\n\n=== Response ===\n${runResult.val.finalResponse ?? ''}\n\n`;
      await deps.planningSessionEffects.appendLog(logPath, logContent);

      // 質問をパース
      const questionsResult = await parseQuestions(
        runResult.val.finalResponse ?? '',
        deps,
        instruction,
      );
      if (!questionsResult.ok) {
        // パースエラー時はFAILED状態に遷移
        const failedSession: PlanningSession = {
          ...session,
          status: PlanningSessionStatus.FAILED,
          errorMessage: `Failed to parse questions: ${questionsResult.err.message}`,
          discoveryLogPath: logPath,
        };
        await deps.planningSessionEffects.saveSession(failedSession);
        return createErr(questionsResult.err);
      }

      // セッションを更新
      const updatedSession: PlanningSession = {
        ...session,
        questions: questionsResult.val,
        discoveryLogPath: logPath,
        conversationHistory: [
          { role: 'user', content: prompt, timestamp: new Date().toISOString() },
          {
            role: 'assistant',
            content: runResult.val.finalResponse ?? '',
            timestamp: new Date().toISOString(),
          },
        ],
      };

      // 保存
      const saveResult = await deps.planningSessionEffects.saveSession(updatedSession);
      if (!saveResult.ok) {
        return createErr(saveResult.err);
      }

      return createOk(updatedSession);
    },

    /**
     * 質問への回答記録
     */
    async answerQuestion(
      session: PlanningSession,
      questionId: string,
      answer: string | null,
    ): Promise<Result<PlanningSession, TaskStoreError>> {
      // 質問を検索
      const questionIndex = session.questions.findIndex((q) => q.id === questionId);
      if (questionIndex === -1) {
        return createErr(ioError('answerQuestion', new Error(`Question ${questionId} not found`)));
      }

      // 回答を記録
      const updatedQuestions = [...session.questions];
      updatedQuestions[questionIndex] = {
        ...updatedQuestions[questionIndex]!,
        answer,
      };

      const updatedSession: PlanningSession = pruneConversationHistory({
        ...session,
        questions: updatedQuestions,
        currentQuestionIndex: questionIndex + 1,
      });

      // 保存
      const saveResult = await deps.planningSessionEffects.saveSession(updatedSession);
      if (!saveResult.ok) {
        return createErr(saveResult.err);
      }

      return createOk(updatedSession);
    },

    /**
     * Design Phase遷移
     */
    async transitionToDesignPhase(
      session: PlanningSession,
    ): Promise<Result<PlanningSession, TaskStoreError>> {
      // Discovery Phaseでない場合はエラー
      if (session.status !== PlanningSessionStatus.DISCOVERY) {
        return createErr(
          ioError(
            'transitionToDesignPhase',
            new Error(`Invalid status: ${session.status}. Expected: discovery`),
          ),
        );
      }

      // 回答済みの質問を収集
      const answeredQuestions = session.questions.map((q) => ({
        question: q.question,
        answer: q.answer ?? null,
      }));

      // Design Phase: 決定点生成
      const prompt = buildDesignPrompt(session.instruction, answeredQuestions);

      // LLM呼び出し
      const runResult =
        deps.agentType === 'claude'
          ? await deps.runnerEffects.runClaudeAgent(prompt, deps.appRepoPath, deps.plannerModel)
          : await deps.runnerEffects.runCodexAgent(prompt, deps.appRepoPath);

      if (!runResult.ok) {
        // LLM失敗時はFAILED状態に遷移
        const failedSession: PlanningSession = {
          ...session,
          status: PlanningSessionStatus.FAILED,
          errorMessage: `LLM invocation failed: ${runResult.err.message}`,
        };
        await deps.planningSessionEffects.saveSession(failedSession);
        return createErr(ioError('transitionToDesignPhase', new Error(runResult.err.message)));
      }

      // ログ記録
      const logPath = path.join(
        deps.appRepoPath,
        '.agent',
        'logs',
        session.sessionId,
        'design.log',
      );
      const logContent = `=== Design Phase ===\n${prompt}\n\n=== Response ===\n${runResult.val.finalResponse ?? ''}\n\n`;
      await deps.planningSessionEffects.appendLog(logPath, logContent);

      // 決定点をパース
      const decisionPointsResult = await parseDecisionPoints(
        runResult.val.finalResponse ?? '',
        deps,
        session.instruction,
        answeredQuestions,
      );
      if (!decisionPointsResult.ok) {
        // パースエラー時はFAILED状態に遷移
        const failedSession: PlanningSession = {
          ...session,
          status: PlanningSessionStatus.FAILED,
          errorMessage: `Failed to parse decision points: ${decisionPointsResult.err.message}`,
          designLogPath: logPath,
        };
        await deps.planningSessionEffects.saveSession(failedSession);
        return createErr(decisionPointsResult.err);
      }

      // セッションを更新
      const updatedSession: PlanningSession = pruneConversationHistory({
        ...session,
        status: PlanningSessionStatus.DESIGN,
        decisionPoints: decisionPointsResult.val,
        currentDecisionIndex: 0,
        designLogPath: logPath,
        conversationHistory: [
          ...session.conversationHistory,
          { role: 'user', content: prompt, timestamp: new Date().toISOString() },
          {
            role: 'assistant',
            content: runResult.val.finalResponse ?? '',
            timestamp: new Date().toISOString(),
          },
        ],
      });

      // 保存
      const saveResult = await deps.planningSessionEffects.saveSession(updatedSession);
      if (!saveResult.ok) {
        return createErr(saveResult.err);
      }

      return createOk(updatedSession);
    },

    /**
     * 設計決定記録
     */
    async recordDecision(
      session: PlanningSession,
      decisionId: string,
      selectedOption: string,
      rationale?: string,
    ): Promise<Result<PlanningSession, TaskStoreError>> {
      // 決定点を検索
      const decisionIndex = session.decisionPoints.findIndex((d) => d.id === decisionId);
      if (decisionIndex === -1) {
        return createErr(
          ioError('recordDecision', new Error(`Decision ${decisionId} not found`)),
        );
      }

      // 決定を記録
      const updatedDecisionPoints = [...session.decisionPoints];
      updatedDecisionPoints[decisionIndex] = {
        ...updatedDecisionPoints[decisionIndex]!,
        selectedOption,
        rationale: rationale ?? null,
      };

      const updatedSession: PlanningSession = pruneConversationHistory({
        ...session,
        decisionPoints: updatedDecisionPoints,
        currentDecisionIndex: decisionIndex + 1,
      });

      // 保存
      const saveResult = await deps.planningSessionEffects.saveSession(updatedSession);
      if (!saveResult.ok) {
        return createErr(saveResult.err);
      }

      return createOk(updatedSession);
    },

    /**
     * Review Phase遷移
     */
    async transitionToReviewPhase(
      session: PlanningSession,
    ): Promise<Result<PlanningSession, TaskStoreError>> {
      // Design Phaseでない場合はエラー
      if (session.status !== PlanningSessionStatus.DESIGN) {
        return createErr(
          ioError(
            'transitionToReviewPhase',
            new Error(`Invalid status: ${session.status}. Expected: design`),
          ),
        );
      }

      // 回答済みの質問を収集
      const answeredQuestions = session.questions.map((q) => ({
        question: q.question,
        answer: q.answer ?? null,
      }));

      // 決定済みの選択肢を収集
      const decisions = session.decisionPoints.map((d) => ({
        title: d.title,
        selectedOption: d.selectedOption ?? 'Not decided',
        rationale: d.rationale ?? null,
      }));

      // Review Phase: サマリー生成
      const prompt = buildReviewPrompt(session.instruction, answeredQuestions, decisions);

      // LLM呼び出し
      const runResult =
        deps.agentType === 'claude'
          ? await deps.runnerEffects.runClaudeAgent(prompt, deps.appRepoPath, deps.plannerModel)
          : await deps.runnerEffects.runCodexAgent(prompt, deps.appRepoPath);

      if (!runResult.ok) {
        // LLM失敗時はFAILED状態に遷移
        const failedSession: PlanningSession = {
          ...session,
          status: PlanningSessionStatus.FAILED,
          errorMessage: `LLM invocation failed: ${runResult.err.message}`,
        };
        await deps.planningSessionEffects.saveSession(failedSession);
        return createErr(ioError('transitionToReviewPhase', new Error(runResult.err.message)));
      }

      // ログ記録
      const logPath = path.join(
        deps.appRepoPath,
        '.agent',
        'logs',
        session.sessionId,
        'review.log',
      );
      const logContent = `=== Review Phase ===\n${prompt}\n\n=== Response ===\n${runResult.val.finalResponse ?? ''}\n\n`;
      await deps.planningSessionEffects.appendLog(logPath, logContent);

      // セッションを更新
      const updatedSession: PlanningSession = pruneConversationHistory({
        ...session,
        status: PlanningSessionStatus.REVIEW,
        reviewLogPath: logPath,
        conversationHistory: [
          ...session.conversationHistory,
          { role: 'user', content: prompt, timestamp: new Date().toISOString() },
          {
            role: 'assistant',
            content: runResult.val.finalResponse ?? '',
            timestamp: new Date().toISOString(),
          },
        ],
      });

      // 保存
      const saveResult = await deps.planningSessionEffects.saveSession(updatedSession);
      if (!saveResult.ok) {
        return createErr(saveResult.err);
      }

      return createOk(updatedSession);
    },

    /**
     * 承認処理（PlannerSession作成）
     */
    async approvePlan(
      session: PlanningSession,
    ): Promise<Result<PlanningSession, TaskStoreError>> {
      // Review Phaseでない場合はエラー
      if (session.status !== PlanningSessionStatus.REVIEW) {
        return createErr(
          ioError(
            'approvePlan',
            new Error(`Invalid status: ${session.status}. Expected: review`),
          ),
        );
      }

      // PlannerSession用の強化指示文を生成
      const enhancedInstruction = buildEnhancedInstruction(
        session.instruction,
        session.questions,
        session.decisionPoints,
      );

      // PlannerSession作成
      const plannerSessionId = `planner-${randomUUID()}`;
      const plannerSession = createPlannerSession(plannerSessionId, enhancedInstruction);

      // PlannerSessionを保存
      const savePlannerResult =
        await deps.plannerSessionEffects.saveSession(plannerSession);
      if (!savePlannerResult.ok) {
        return createErr(savePlannerResult.err);
      }

      // Planning Sessionを更新
      const updatedSession: PlanningSession = {
        ...session,
        status: PlanningSessionStatus.APPROVED,
        plannerSessionId,
      };

      // 保存
      const saveResult = await deps.planningSessionEffects.saveSession(updatedSession);
      if (!saveResult.ok) {
        return createErr(saveResult.err);
      }

      return createOk(updatedSession);
    },

    /**
     * 拒否処理（Design Phaseに戻る、3回目でCANCELLED）
     */
    async rejectPlan(
      session: PlanningSession,
      reason: string,
    ): Promise<Result<PlanningSession, TaskStoreError>> {
      const newRejectCount = session.rejectCount + 1;

      let updatedSession: PlanningSession;
      if (newRejectCount >= 3) {
        // 3回目の拒否 → CANCELLED
        updatedSession = {
          ...session,
          status: PlanningSessionStatus.CANCELLED,
          rejectCount: newRejectCount,
          errorMessage: `Plan rejected 3 times. Last reason: ${reason}`,
        };
      } else {
        // DESIGN Phaseに戻る
        updatedSession = {
          ...session,
          status: PlanningSessionStatus.DESIGN,
          rejectCount: newRejectCount,
          currentDecisionIndex: 0,
        };
      }

      // 会話履歴に拒否理由を記録
      updatedSession = pruneConversationHistory({
        ...updatedSession,
        conversationHistory: [
          ...session.conversationHistory,
          {
            role: 'user',
            content: `Plan rejected. Reason: ${reason}`,
            timestamp: new Date().toISOString(),
          },
        ],
      });

      // 保存
      const saveResult = await deps.planningSessionEffects.saveSession(updatedSession);
      if (!saveResult.ok) {
        return createErr(saveResult.err);
      }

      return createOk(updatedSession);
    },
  };
};
