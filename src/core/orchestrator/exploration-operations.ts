/**
 * Exploration Operations
 *
 * ADR-025: 自律探索モード
 *
 * 探索セッションの操作ロジック。
 */

import type { Result } from 'option-t/plain_result';
import { createOk, createErr, isErr } from 'option-t/plain_result';
import type { TaskStore } from '../task-store/interface.ts';
import type { RunnerEffects } from '../runner/runner-effects.ts';
import type { ExplorationSessionEffects } from './exploration-session-effects.ts';
import {
  type ExplorationSession,
  type ExplorationFocus,
  type Finding,
  type TaskCandidate,
  createExplorationSession,
  updateExplorationSession,
  createFinding,
  createTaskCandidate,
} from '../../types/exploration-session.ts';
import { buildExplorationPrompt } from './exploration-prompts.ts';
import { createInitialTask, TaskState } from '../../types/task.ts';
import { taskId, branchName, repoPath } from '../../types/branded.ts';

/**
 * 探索操作の依存関係
 */
export interface ExplorationDeps {
  taskStore: TaskStore;
  runnerEffects: RunnerEffects;
  sessionEffects: ExplorationSessionEffects;
  appRepoPath: string;
  coordRepoPath: string;
  agentType: 'claude' | 'codex';
  model: string;
}

/**
 * 探索エラー
 */
export interface ExplorationError {
  message: string;
  cause?: unknown;
}

/**
 * 探索セッションを初期化
 */
export async function initializeExplorationSession(
  deps: ExplorationDeps,
  focus: ExplorationFocus[],
  scope: string[],
): Promise<Result<ExplorationSession, ExplorationError>> {
  // セッションを作成
  const session = createExplorationSession(focus, scope);

  // セッションを保存
  const saveResult = await deps.sessionEffects.save(session);
  if (isErr(saveResult)) {
    return createErr({
      message: `Failed to save session: ${saveResult.err.message}`,
      cause: saveResult.err,
    });
  }

  return createOk(session);
}

/**
 * 探索タスクを作成・実行
 */
export async function runExploration(
  deps: ExplorationDeps,
  session: ExplorationSession,
): Promise<Result<ExplorationSession, ExplorationError>> {
  // 探索プロンプトを構築
  const prompt = buildExplorationPrompt(session.focus, session.scope);

  // 探索タスクを作成
  const explorationTaskId = `explore-${session.sessionId}-${Date.now()}`;
  const explorationTask = createInitialTask({
    id: taskId(explorationTaskId),
    summary: `Explore codebase: ${session.focus.join(', ')}`,
    context: prompt,
    scopePaths: session.scope,
    acceptance: 'Identify code quality issues, security vulnerabilities, and improvement opportunities in the codebase',
    branch: branchName(`exploration/${session.sessionId}`),
    repo: repoPath(deps.appRepoPath),
    dependencies: [],
    taskType: 'investigation',
  });

  // タスクを保存
  const createResult = await deps.taskStore.createTask(explorationTask);
  if (isErr(createResult)) {
    return createErr({
      message: `Failed to create exploration task: ${createResult.err.message}`,
      cause: createResult.err,
    });
  }

  // セッションを更新
  let updatedSession = updateExplorationSession(session, {
    explorationTaskId,
    status: 'exploring',
  });

  // 探索タスクを実行
  const runResult = deps.agentType === 'claude'
    ? await deps.runnerEffects.runClaudeAgent(
        prompt,
        deps.appRepoPath,
        deps.model,
        explorationTaskId,
      )
    : await deps.runnerEffects.runCodexAgent(
        prompt,
        deps.appRepoPath,
        deps.model,
        explorationTaskId,
      );

  if (isErr(runResult)) {
    updatedSession = updateExplorationSession(updatedSession, {
      status: 'failed',
      error: `Exploration failed: ${runResult.err.message}`,
    });
    await deps.sessionEffects.save(updatedSession);
    return createErr({
      message: `Exploration failed: ${runResult.err.message}`,
      cause: runResult.err,
    });
  }

  // 実行ログを読み込み
  const logResult = await deps.runnerEffects.readLog(explorationTaskId);
  if (isErr(logResult)) {
    updatedSession = updateExplorationSession(updatedSession, {
      status: 'failed',
      error: `Failed to read exploration log: ${logResult.err.message}`,
    });
    await deps.sessionEffects.save(updatedSession);
    return createErr({
      message: `Failed to read exploration log: ${logResult.err.message}`,
      cause: logResult.err,
    });
  }

  // 発見事項を抽出
  const findings = extractFindings(logResult.val);

  // タスク候補を生成
  const taskCandidates = generateCandidatesFromFindings(findings);

  // セッションを更新
  updatedSession = updateExplorationSession(updatedSession, {
    findings,
    taskCandidates,
    status: taskCandidates.length > 0 ? 'awaiting-approval' : 'completed',
    completedAt: taskCandidates.length === 0 ? new Date().toISOString() : undefined,
  });

  // タスクを完了としてマーク
  await deps.taskStore.updateTaskCAS(
    taskId(explorationTaskId),
    explorationTask.version,
    (t) => ({ ...t, state: TaskState.DONE }),
  );

  // セッションを保存
  const saveResult = await deps.sessionEffects.save(updatedSession);
  if (isErr(saveResult)) {
    return createErr({
      message: `Failed to save session: ${saveResult.err.message}`,
      cause: saveResult.err,
    });
  }

  return createOk(updatedSession);
}

/**
 * 探索結果から発見事項を抽出
 */
export function extractFindings(runLog: string): Finding[] {
  const findings: Finding[] = [];

  // JSON形式の発見事項を抽出
  const jsonMatch = runLog.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch?.[1]) {
    try {
      const data = JSON.parse(jsonMatch[1]);
      if (data.findings && Array.isArray(data.findings)) {
        for (const f of data.findings) {
          findings.push(createFinding({
            category: f.category ?? 'code-quality',
            severity: f.severity ?? 'medium',
            location: {
              file: f.file ?? 'unknown',
              line: f.line,
            },
            title: f.title ?? f.description?.slice(0, 50) ?? 'Unknown finding',
            description: f.description ?? '',
            recommendation: f.recommendation ?? '',
            actionable: f.actionable ?? false,
            codeSnippet: f.codeSnippet,
          }));
        }
        return findings;
      }
    } catch {
      // JSON解析失敗、マークダウン形式を試す
    }
  }

  // マークダウン形式の発見事項を抽出
  const findingBlocks = runLog.split(/### Finding:/);
  for (let i = 1; i < findingBlocks.length; i++) {
    const block = findingBlocks[i];
    if (!block) continue;

    const finding = parseFindingBlock(block);
    if (finding) {
      findings.push(finding);
    }
  }

  return findings;
}

/**
 * 発見事項のマークダウンブロックをパース
 */
function parseFindingBlock(block: string): Finding | null {
  const titleMatch = block.match(/^\s*(.+?)(?:\n|$)/);
  const categoryMatch = block.match(/\*\*Category\*\*:\s*(\S+)/i);
  const severityMatch = block.match(/\*\*Severity\*\*:\s*(\S+)/i);
  const locationMatch = block.match(/\*\*Location\*\*:\s*(.+?)(?:\n|$)/i);
  const descriptionMatch = block.match(/\*\*Description\*\*:\s*(.+?)(?=\*\*|$)/is);
  const recommendationMatch = block.match(/\*\*Recommendation\*\*:\s*(.+?)(?=\*\*|$)/is);
  const actionableMatch = block.match(/\*\*Actionable\*\*:\s*(\S+)/i);
  const codeMatch = block.match(/```[\s\S]*?```/);

  if (!titleMatch) {
    return null;
  }

  // ロケーションをパース
  const locParts = locationMatch?.[1]?.split(':') ?? ['unknown'];
  const file = locParts[0] ?? 'unknown';
  const line = locParts[1] ? parseInt(locParts[1], 10) : undefined;

  const category = categoryMatch?.[1]?.toLowerCase() ?? 'code-quality';
  const severity = severityMatch?.[1]?.toLowerCase() ?? 'medium';
  const actionableStr = actionableMatch?.[1]?.toLowerCase() ?? 'no';

  return createFinding({
    category: category as Finding['category'],
    severity: severity as Finding['severity'],
    location: { file, line },
    title: titleMatch[1]?.trim() ?? 'Unknown finding',
    description: descriptionMatch?.[1]?.trim() ?? '',
    recommendation: recommendationMatch?.[1]?.trim() ?? '',
    actionable: actionableStr === 'yes' || actionableStr === 'true',
    codeSnippet: codeMatch?.[0]?.replace(/```/g, '').trim(),
  });
}

/**
 * 発見事項からタスク候補を生成
 */
export function generateCandidatesFromFindings(findings: Finding[]): TaskCandidate[] {
  const candidates: TaskCandidate[] = [];

  // アクション可能な発見事項のみ対象
  const actionableFindings = findings.filter((f) => f.actionable);

  for (const finding of actionableFindings) {
    candidates.push(createTaskCandidate({
      findingId: finding.id,
      summary: `Fix: ${finding.title}`,
      description: `${finding.description}\n\nRecommendation: ${finding.recommendation}`,
      estimatedEffort: estimateEffort(finding),
    }));
  }

  return candidates;
}

/**
 * 発見事項から工数を推定
 */
function estimateEffort(finding: Finding): 'small' | 'medium' | 'large' {
  // シンプルなヒューリスティック
  if (finding.severity === 'low') {
    return 'small';
  }
  if (finding.severity === 'critical') {
    return 'large';
  }
  if (finding.category === 'architecture') {
    return 'large';
  }
  if (finding.category === 'documentation') {
    return 'small';
  }
  return 'medium';
}

/**
 * タスク候補を承認
 */
export async function approveCandidates(
  deps: ExplorationDeps,
  session: ExplorationSession,
  candidateIds: string[],
): Promise<Result<ExplorationSession, ExplorationError>> {
  // 候補を更新
  const updatedCandidates = session.taskCandidates.map((candidate) => {
    if (candidateIds.includes(candidate.id)) {
      return { ...candidate, approved: true };
    }
    return candidate;
  });

  // 承認されたタスクIDを記録
  const approvedIds = updatedCandidates
    .filter((c) => c.approved)
    .map((c) => c.id);

  // セッションを更新
  const updatedSession = updateExplorationSession(session, {
    taskCandidates: updatedCandidates,
    approvedTaskIds: approvedIds,
  });

  // セッションを保存
  const saveResult = await deps.sessionEffects.save(updatedSession);
  if (isErr(saveResult)) {
    return createErr({
      message: `Failed to save session: ${saveResult.err.message}`,
      cause: saveResult.err,
    });
  }

  return createOk(updatedSession);
}

/**
 * 承認済みタスクを実行
 */
export async function executeApprovedTasks(
  deps: ExplorationDeps,
  session: ExplorationSession,
): Promise<Result<ExplorationSession, ExplorationError>> {
  const approvedCandidates = session.taskCandidates.filter((c) => c.approved);

  if (approvedCandidates.length === 0) {
    return createErr({
      message: 'No approved candidates to execute',
    });
  }

  // セッションを実行中に更新
  let updatedSession = updateExplorationSession(session, {
    status: 'executing',
  });
  await deps.sessionEffects.save(updatedSession);

  const executedTaskIds: string[] = [];

  // 各承認済み候補に対してタスクを作成・実行
  for (const candidate of approvedCandidates) {
    const finding = session.findings.find((f) => f.id === candidate.findingId);
    if (!finding) {
      continue;
    }

    const taskIdStr = `fix-${candidate.id}-${Date.now()}`;
    const fixContext = `
Fix the following issue:

**Title**: ${finding.title}
**Category**: ${finding.category}
**Severity**: ${finding.severity}
**Location**: ${finding.location.file}:${finding.location.line ?? '?'}

**Description**: ${finding.description}

**Recommendation**: ${finding.recommendation}

${finding.codeSnippet ? `**Current Code**:\n\`\`\`\n${finding.codeSnippet}\n\`\`\`` : ''}

Please implement the fix according to the recommendation.
    `;
    const task = createInitialTask({
      id: taskId(taskIdStr),
      summary: candidate.summary,
      context: fixContext,
      scopePaths: [finding.location.file],
      acceptance: `The issue "${finding.title}" is fixed according to the recommendation`,
      branch: branchName(`fix/${session.sessionId}/${candidate.id}`),
      repo: repoPath(deps.appRepoPath),
      dependencies: [],
      taskType: 'implementation',
    });

    const createResult = await deps.taskStore.createTask(task);
    if (isErr(createResult)) {
      console.warn(`Failed to create task for candidate ${candidate.id}: ${createResult.err.message}`);
      continue;
    }

    executedTaskIds.push(taskIdStr);
  }

  // セッションを完了に更新
  updatedSession = updateExplorationSession(updatedSession, {
    executedTaskIds,
    status: 'completed',
    completedAt: new Date().toISOString(),
  });

  // セッションを保存
  const saveResult = await deps.sessionEffects.save(updatedSession);
  if (isErr(saveResult)) {
    return createErr({
      message: `Failed to save session: ${saveResult.err.message}`,
      cause: saveResult.err,
    });
  }

  return createOk(updatedSession);
}
