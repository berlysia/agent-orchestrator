/**
 * Report generator that integrates data collection and formatting
 *
 * WHY: データ収集とフォーマットを統合し、レポート生成とファイル保存を提供する
 *      監視レポート機能の中核となる統合インターフェース
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr } from 'option-t/plain_result';
import type { PlannerSessionEffects } from '../orchestrator/planner-session-effects.ts';
import type { TaskStore } from '../task-store/interface.ts';
import { collectReportData } from './collector.ts';
import { formatReportAsMarkdown } from './formatter.ts';
import type { ReportError } from '../../types/errors.ts';
import { reportWriteError } from '../../types/errors.ts';
import type {
  PlanningReportData,
  TaskBreakdownData,
  ScopeReportData,
  ExecutionReportData,
  ReviewReportData,
  SummaryReportData,
} from './types.ts';

/**
 * ReportGenerator class
 *
 * データ収集、フォーマット、ファイル保存を統合して提供
 */
export class ReportGenerator {
  private readonly sessionEffects: PlannerSessionEffects;
  private readonly taskStore: TaskStore;
  private readonly coordPath: string;

  constructor(
    sessionEffects: PlannerSessionEffects,
    taskStore: TaskStore,
    coordPath: string,
  ) {
    this.sessionEffects = sessionEffects;
    this.taskStore = taskStore;
    this.coordPath = coordPath;
  }

  /**
   * レポートを生成してMarkdown文字列を返す
   *
   * @param rootSessionId ルートセッションID
   * @returns Markdown形式のレポート文字列
   * @throws エラー時は例外をスロー（generate自体は例外をスローする）
   */
  async generate(rootSessionId: string): Promise<string> {
    const dataResult = await collectReportData(
      rootSessionId,
      this.sessionEffects,
      this.taskStore,
    );

    if (!dataResult.ok) {
      throw new Error(
        `Failed to collect report data: ${dataResult.err.message}`,
      );
    }

    return formatReportAsMarkdown(dataResult.val);
  }

  /**
   * レポートを生成してファイルに保存
   *
   * @param rootSessionId ルートセッションID
   * @returns 保存したファイルパス、エラー時はundefined
   *
   * 仕様:
   * - agent-coord/reports/{rootSessionId}.mdに保存
   * - ディレクトリが存在しない場合は自動作成
   * - 既存レポートは上書き
   * - エラー時は例外をスローせず警告ログを出力してundefinedを返す
   */
  async saveReport(rootSessionId: string): Promise<string | undefined> {
    try {
      const content = await this.generate(rootSessionId);
      const dir = join(this.coordPath, 'reports');
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${rootSessionId}.md`);
      await writeFile(path, content, 'utf-8');
      return path;
    } catch (e) {
      console.warn('Report generation failed:', e);
      return undefined;
    }
  }

  // ===== ADR-032: Extended Report Generation Methods =====

  /**
   * セッション用レポートディレクトリを取得・作成
   */
  private async ensureSessionReportDir(sessionId: string): Promise<string> {
    const dir = join(this.coordPath, 'reports', sessionId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * タスク用レポートディレクトリを取得・作成
   */
  private async ensureTaskReportDir(sessionId: string, taskId: string): Promise<string> {
    const dir = join(this.coordPath, 'reports', sessionId, 'tasks', taskId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Planning Reportを生成して保存
   */
  async generatePlanningReport(
    data: PlanningReportData,
  ): Promise<Result<string, ReportError>> {
    try {
      const dir = await this.ensureSessionReportDir(data.sessionId);
      const filePath = join(dir, '00-planning.md');
      const content = formatPlanningReport(data);
      await writeFile(filePath, content, 'utf-8');
      return createOk(filePath);
    } catch (error) {
      return createErr(reportWriteError('00-planning.md', error));
    }
  }

  /**
   * Task Breakdown Reportを生成して保存
   */
  async generateTaskBreakdownReport(
    data: TaskBreakdownData,
  ): Promise<Result<string, ReportError>> {
    try {
      const dir = await this.ensureSessionReportDir(data.sessionId);
      const filePath = join(dir, '01-task-breakdown.md');
      const content = formatTaskBreakdownReport(data);
      await writeFile(filePath, content, 'utf-8');
      return createOk(filePath);
    } catch (error) {
      return createErr(reportWriteError('01-task-breakdown.md', error));
    }
  }

  /**
   * Scope Reportを生成して保存
   */
  async generateScopeReport(
    sessionId: string,
    data: ScopeReportData,
  ): Promise<Result<string, ReportError>> {
    try {
      const dir = await this.ensureTaskReportDir(sessionId, data.taskId);
      const filePath = join(dir, '00-scope.md');
      const content = formatScopeReport(data);
      await writeFile(filePath, content, 'utf-8');
      return createOk(filePath);
    } catch (error) {
      return createErr(reportWriteError('00-scope.md', error));
    }
  }

  /**
   * Execution Reportを生成して保存
   */
  async generateExecutionReport(
    sessionId: string,
    data: ExecutionReportData,
  ): Promise<Result<string, ReportError>> {
    try {
      const dir = await this.ensureTaskReportDir(sessionId, data.taskId);
      const filePath = join(dir, '01-execution.md');
      const content = formatExecutionReport(data);
      await writeFile(filePath, content, 'utf-8');
      return createOk(filePath);
    } catch (error) {
      return createErr(reportWriteError('01-execution.md', error));
    }
  }

  /**
   * Review Reportを生成して保存
   */
  async generateReviewReport(
    sessionId: string,
    data: ReviewReportData,
  ): Promise<Result<string, ReportError>> {
    try {
      const dir = await this.ensureTaskReportDir(sessionId, data.taskId);
      const filePath = join(dir, '02-review.md');
      const content = formatReviewReport(data);
      await writeFile(filePath, content, 'utf-8');
      return createOk(filePath);
    } catch (error) {
      return createErr(reportWriteError('02-review.md', error));
    }
  }

  /**
   * Summary Reportを生成して保存
   */
  async generateSummaryReport(
    data: SummaryReportData,
  ): Promise<Result<string, ReportError>> {
    try {
      const dir = await this.ensureSessionReportDir(data.sessionId);
      const filePath = join(dir, 'summary.md');
      const content = formatSummaryReport(data);
      await writeFile(filePath, content, 'utf-8');
      return createOk(filePath);
    } catch (error) {
      return createErr(reportWriteError('summary.md', error));
    }
  }
}

// ===== ADR-032: Report Formatters =====

function formatPlanningReport(data: PlanningReportData): string {
  const sections: string[] = [
    '# Planning Session Report',
    '',
    `**Session:** ${data.sessionId}`,
    `**Created:** ${data.createdAt}`,
    '',
    '## Original Request',
    data.originalRequest,
    '',
  ];

  if (data.clarifications.length > 0) {
    sections.push('## Clarifications');
    sections.push('| Question | Answer |');
    sections.push('|----------|--------|');
    for (const c of data.clarifications) {
      sections.push(`| ${c.question} | ${c.answer} |`);
    }
    sections.push('');
  }

  if (data.designDecisions.length > 0) {
    sections.push('## Design Decisions');
    sections.push('| Decision | Rationale |');
    sections.push('|----------|-----------|');
    for (const d of data.designDecisions) {
      sections.push(`| ${d.decision} | ${d.rationale} |`);
    }
    sections.push('');
  }

  sections.push('## Approved Scope');
  sections.push(data.approvedScope);

  return sections.join('\n');
}

function formatTaskBreakdownReport(data: TaskBreakdownData): string {
  const sections: string[] = [
    '# Task Breakdown',
    '',
    `**Session:** ${data.sessionId}`,
    `**Created:** ${data.createdAt}`,
    '',
    '## Tasks',
    '| # | ID | Title | Dependencies | Priority | Type |',
    '|---|-----|-------|--------------|----------|------|',
  ];

  data.tasks.forEach((task, index) => {
    const deps = task.dependencies.length > 0 ? task.dependencies.join(', ') : '-';
    sections.push(
      `| ${index + 1} | ${task.id} | ${task.title} | ${deps} | ${task.priority} | ${task.taskType} |`,
    );
  });

  sections.push('');
  sections.push('## Dependency Graph');
  sections.push('```');
  sections.push(generateDependencyGraph(data.tasks));
  sections.push('```');

  return sections.join('\n');
}

function generateDependencyGraph(tasks: TaskBreakdownData['tasks']): string {
  const lines: string[] = [];
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  // ルートタスク（依存なし）を見つける
  const roots = tasks.filter((t) => t.dependencies.length === 0);

  function printTree(taskId: string, indent: string, isLast: boolean): void {
    const task = taskMap.get(taskId);
    if (!task) return;

    const prefix = indent + (isLast ? '└── ' : '├── ');
    lines.push(prefix + task.id);

    // このタスクに依存するタスクを見つける
    const dependents = tasks.filter((t) => t.dependencies.includes(taskId));
    dependents.forEach((dep, index) => {
      const nextIndent = indent + (isLast ? '    ' : '│   ');
      printTree(dep.id, nextIndent, index === dependents.length - 1);
    });
  }

  roots.forEach((root, index) => {
    printTree(root.id, '', index === roots.length - 1);
  });

  return lines.join('\n') || '(no tasks)';
}

function formatScopeReport(data: ScopeReportData): string {
  const sections: string[] = [
    '# Change Scope Declaration',
    '',
    `**Task:** ${data.taskId}`,
    '',
    '## Description',
    data.description,
    '',
    '## Planned Changes',
    '| Type | File | Description |',
    '|------|------|-------------|',
  ];

  for (const change of data.plannedChanges) {
    sections.push(`| ${change.type} | \`${change.path}\` | ${change.description || '-'} |`);
  }

  sections.push('');
  sections.push(`## Estimated Size`);
  sections.push(data.estimatedSize.charAt(0).toUpperCase() + data.estimatedSize.slice(1));
  sections.push('');
  sections.push('## Impact Scope');
  for (const scope of data.impactScope) {
    sections.push(`- ${scope}`);
  }

  return sections.join('\n');
}

function formatExecutionReport(data: ExecutionReportData): string {
  const durationSec = Math.round(data.duration / 1000);
  const sections: string[] = [
    '# Execution Report',
    '',
    `**Task:** ${data.taskId}`,
    `**Worker:** ${data.workerId}`,
    `**Started:** ${data.startedAt}`,
    `**Completed:** ${data.completedAt}`,
    `**Duration:** ${durationSec}s`,
    '',
    '## Changes Made',
    '| Type | File | Lines Changed |',
    '|------|------|---------------|',
  ];

  for (const change of data.changes) {
    const lines = change.linesAdded || change.linesRemoved
      ? `+${change.linesAdded || 0}, -${change.linesRemoved || 0}`
      : '-';
    sections.push(`| ${change.type} | \`${change.path}\` | ${lines} |`);
  }

  if (data.commands.length > 0) {
    sections.push('');
    sections.push('## Commands Executed');
    sections.push('```bash');
    for (const cmd of data.commands) {
      const statusIcon = cmd.status === 'success' ? '✅' : '❌';
      sections.push(`${cmd.command}  # ${statusIcon} ${cmd.status}`);
    }
    sections.push('```');
  }

  if (data.notes) {
    sections.push('');
    sections.push('## Notes');
    sections.push(data.notes);
  }

  return sections.join('\n');
}

function formatReviewReport(data: ReviewReportData): string {
  const verdictIcon = data.verdict === 'done' ? '✅' : data.verdict === 'blocked' ? '❌' : '⚠️';
  const sections: string[] = [
    '# Judge Review Report',
    '',
    `**Task:** ${data.taskId}`,
    `**Verdict:** ${verdictIcon} ${data.verdict.toUpperCase()}`,
    `**Reviewed:** ${data.reviewedAt}`,
    '',
    '## Evaluation Summary',
    '| Aspect | Result | Notes |',
    '|--------|--------|-------|',
  ];

  for (const eval_ of data.evaluations) {
    const resultIcon = eval_.result === 'pass' ? '✅' : eval_.result === 'fail' ? '❌' : '⚠️';
    sections.push(`| ${eval_.aspect} | ${resultIcon} | ${eval_.notes || '-'} |`);
  }

  if (data.issues.length > 0) {
    sections.push('');
    sections.push('## Issues');
    sections.push('| # | Severity | Location | Issue | Action |');
    sections.push('|---|----------|----------|-------|--------|');
    data.issues.forEach((issue, index) => {
      sections.push(
        `| ${index + 1} | ${issue.severity} | ${issue.location || '-'} | ${issue.issue} | ${issue.action || '-'} |`,
      );
    });
  }

  if (data.continuationGuidance) {
    sections.push('');
    sections.push('## Continuation Guidance');
    sections.push(data.continuationGuidance);
  }

  return sections.join('\n');
}

function formatSummaryReport(data: SummaryReportData): string {
  const statusIcon = data.status === 'complete' ? '✅' : data.status === 'partial' ? '⚠️' : '❌';
  const durationMin = Math.round(data.totalDuration / 60000);
  const sections: string[] = [
    '# Task Completion Summary',
    '',
    `**Session:** ${data.sessionId}`,
    `**Duration:** ${durationMin}m`,
    `**Status:** ${statusIcon} ${data.status.charAt(0).toUpperCase() + data.status.slice(1)}`,
    '',
    '## Original Request',
    data.originalRequest,
    '',
    '## Deliverables',
    '| Type | File | Summary |',
    '|------|------|---------|',
  ];

  for (const del of data.deliverables) {
    sections.push(`| ${del.type} | \`${del.path}\` | ${del.summary} |`);
  }

  sections.push('');
  sections.push('## Task Execution Summary');
  sections.push('| Task | Status | Iterations |');
  sections.push('|------|--------|------------|');

  for (const task of data.taskResults) {
    const icon = task.status === 'done' ? '✅' : task.status === 'blocked' ? '❌' : '⏭️';
    sections.push(`| ${task.taskId} | ${icon} ${task.status} | ${task.iterations} |`);
  }

  sections.push('');
  sections.push('## Review Results');
  sections.push('| Review | Result |');
  sections.push('|--------|--------|');
  sections.push(`| Judge | ${data.reviewResults.judge} |`);
  if (data.reviewResults.integration) {
    sections.push(`| Integration | ${data.reviewResults.integration} |`);
  }

  if (data.verificationCommands.length > 0) {
    sections.push('');
    sections.push('## Verification Commands');
    sections.push('```bash');
    for (const cmd of data.verificationCommands) {
      sections.push(cmd);
    }
    sections.push('```');
  }

  return sections.join('\n');
}
