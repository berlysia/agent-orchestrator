/**
 * Judge AI Antipattern Integration
 *
 * ADR-031: AI Antipattern ReviewをJudge評価に統合するためのヘルパー
 *
 * このモジュールは、JudgeOperationsからAIAntipatternReviewerを呼び出すための
 * 統合ポイントを提供します。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr } from 'option-t/plain_result';
import type { GitEffects } from '../../adapters/vcs/git-effects.ts';
import type { WorktreePath } from '../../types/branded.ts';
import type { AIAntipatternConfig, AIAntipatternReviewResult } from '../../types/ai-antipattern.ts';
import { createAIAntipatternReviewer } from './ai-antipattern-reviewer.ts';

/**
 * AI Antipattern Review統合依存関係
 */
export interface AIAntipatternIntegrationDeps {
  readonly gitEffects: GitEffects;
  readonly config: AIAntipatternConfig;
}

/**
 * AI Antipatternレビューエラー
 */
export interface AIAntipatternError {
  type: 'ai_antipattern_error';
  message: string;
  cause?: unknown;
}

/**
 * Worktreeの変更ファイルを取得してAI Antipatternレビューを実行
 *
 * @param deps 依存関係
 * @param worktreePath worktreeパス
 * @param taskDescription タスクの説明（スコープクリープ検出用）
 * @param baseRef 差分の基準となるref（デフォルト: HEAD~1）
 * @returns レビュー結果
 */
export const reviewWorktreeChanges = async (
  deps: AIAntipatternIntegrationDeps,
  worktreePath: WorktreePath,
  taskDescription?: string,
  baseRef: string = 'HEAD~1',
): Promise<Result<AIAntipatternReviewResult, AIAntipatternError>> => {
  try {
    // 変更されたファイル一覧を取得
    const diffResult = await deps.gitEffects.getDiff(worktreePath, ['--name-only', baseRef]);
    if (!diffResult.ok) {
      return createErr({
        type: 'ai_antipattern_error',
        message: 'Failed to get changed files',
        cause: diffResult.err,
      });
    }

    const changedFilePaths = diffResult.val
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);

    if (changedFilePaths.length === 0) {
      // 変更がない場合は完璧なスコアを返す
      return createOk({
        fallbackViolations: [],
        unusedCode: [],
        scopeCreep: [],
        plausibleButWrong: [],
        overallScore: 100,
        shouldReject: false,
      });
    }

    // 各ファイルの内容を読み取り（ファイルシステムから直接）
    const changedFiles = new Map<string, string>();
    for (const filePath of changedFilePaths) {
      // TypeScript/JavaScript ファイルのみを対象
      if (!filePath.endsWith('.ts') && !filePath.endsWith('.js') && !filePath.endsWith('.tsx') && !filePath.endsWith('.jsx')) {
        continue;
      }

      try {
        const fullPath = path.join(worktreePath, filePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        changedFiles.set(filePath, content);
      } catch {
        // ファイルが読めない場合（削除されたファイル等）はスキップ
      }
    }

    // AIAntipatternReviewerでレビュー実行
    const reviewer = createAIAntipatternReviewer(deps.config);
    const reviewResult = await reviewer.review(changedFiles, taskDescription);

    return createOk(reviewResult);
  } catch (error) {
    return createErr({
      type: 'ai_antipattern_error',
      message: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  }
};

/**
 * Judge評価結果にAI Antipatternレビュー結果を統合するかどうかを判定
 *
 * @param reviewResult AI Antipatternレビュー結果
 * @returns Judge評価に影響を与えるべきかどうか
 */
export const shouldAffectJudgement = (reviewResult: AIAntipatternReviewResult): boolean => {
  // REJECTすべき場合はJudge評価に影響
  return reviewResult.shouldReject;
};

/**
 * AI Antipatternレビュー結果からJudgeフィードバックメッセージを生成
 *
 * @param reviewResult AI Antipatternレビュー結果
 * @returns フィードバックメッセージ
 */
export const generateFeedbackMessage = (reviewResult: AIAntipatternReviewResult): string => {
  const messages: string[] = [];

  if (reviewResult.fallbackViolations.length > 0) {
    const count = reviewResult.fallbackViolations.filter((v) => !v.exemptionReason).length;
    if (count > 0) {
      messages.push(`- ${count} fallback violation(s) detected (e.g., ?? 'unknown', empty catch)`);
    }
  }

  if (reviewResult.unusedCode.length > 0) {
    const count = reviewResult.unusedCode.filter((u) => !u.isFrameworkException).length;
    if (count > 0) {
      messages.push(`- ${count} unused code issue(s) detected`);
    }
  }

  if (reviewResult.scopeCreep.length > 0) {
    messages.push(`- ${reviewResult.scopeCreep.length} scope creep issue(s) detected`);
  }

  if (reviewResult.plausibleButWrong.length > 0) {
    messages.push(`- ${reviewResult.plausibleButWrong.length} plausible-but-wrong issue(s) detected`);
  }

  if (messages.length === 0) {
    return '';
  }

  return `AI Antipattern Review (score: ${reviewResult.overallScore}/100):\n${messages.join('\n')}`;
};
