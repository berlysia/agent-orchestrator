/**
 * Issue to Task Conversion (ADR-029)
 *
 * ParsedIssueからタスクコンテキストへの変換機能。
 */

import type { ParsedIssue, SourceIssue, IssueRef } from '../../types/github-issue.ts';
import {
  sanitizeIssueContent,
  sanitizeIssueTitle,
  sanitizeAndFormatComments,
} from './issue-sanitizer.ts';

/**
 * 変換オプション
 */
export interface ConversionOptions {
  /** コメントを含めるか（デフォルト: true） */
  includeComments?: boolean;
  /** 最大コメント数（デフォルト: 10） */
  maxComments?: number;
  /** ラベルを含めるか（デフォルト: true） */
  includeLabels?: boolean;
  /** アサイニーを含めるか（デフォルト: true） */
  includeAssignees?: boolean;
}

/**
 * ParsedIssueをタスクコンテキスト文字列に変換
 *
 * @param issue パース済みIssue
 * @param options 変換オプション
 * @returns タスク実行に使用するコンテキスト文字列
 */
export function convertIssueToTaskContext(
  issue: ParsedIssue,
  options: ConversionOptions = {},
): string {
  const {
    includeComments = true,
    maxComments = 10,
    includeLabels = true,
    includeAssignees = true,
  } = options;

  const sections: string[] = [];

  // タイトル
  const title = sanitizeIssueTitle(issue.title);
  sections.push(`# ${title}`);

  // メタ情報
  const metaInfo: string[] = [];
  metaInfo.push(`Issue #${issue.number}`);
  metaInfo.push(`State: ${issue.state}`);

  if (includeLabels && issue.labels.length > 0) {
    metaInfo.push(`Labels: ${issue.labels.join(', ')}`);
  }

  if (includeAssignees && issue.assignees.length > 0) {
    metaInfo.push(`Assignees: ${issue.assignees.join(', ')}`);
  }

  if (issue.milestone) {
    metaInfo.push(`Milestone: ${issue.milestone}`);
  }

  sections.push(metaInfo.join(' | '));
  sections.push('');

  // 本文
  if (issue.body) {
    const sanitizedBody = sanitizeIssueContent(issue.body, {
      addContentMarkers: true,
    });
    sections.push('## Description');
    sections.push(sanitizedBody);
    sections.push('');
  }

  // コメント
  if (includeComments && issue.comments.length > 0) {
    sections.push('## Discussion');
    const formattedComments = sanitizeAndFormatComments(
      issue.comments.map((c) => ({
        author: c.author,
        body: c.body,
        createdAt: c.createdAt,
      })),
      maxComments,
    );
    sections.push(formattedComments);
  }

  return sections.join('\n');
}

/**
 * ParsedIssueからSourceIssue情報を抽出
 *
 * @param issue パース済みIssue
 * @param ref オリジナルのIssue参照（owner/repo情報用）
 * @returns SourceIssue情報
 */
export function extractSourceIssue(
  issue: ParsedIssue,
  ref?: IssueRef,
): SourceIssue {
  const sourceIssue: SourceIssue = {
    number: issue.number,
    title: sanitizeIssueTitle(issue.title, 100),
    url: issue.url,
  };

  // URLからowner/repoを抽出、またはrefから取得
  if (ref?.type === 'url') {
    sourceIssue.owner = ref.owner;
    sourceIssue.repo = ref.repo;
  } else {
    // URLからパース
    const urlMatch = issue.url.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (urlMatch && urlMatch[1] && urlMatch[2]) {
      sourceIssue.owner = urlMatch[1];
      sourceIssue.repo = urlMatch[2];
    }
  }

  return sourceIssue;
}

/**
 * Issueからタスクタイプを推測
 *
 * ラベルに基づいてタスクタイプを判定する
 */
export function inferTaskType(
  issue: ParsedIssue,
): 'implementation' | 'documentation' | 'investigation' | 'integration' {
  const labelsLower = issue.labels.map((l) => l.toLowerCase());

  // ドキュメント系
  if (
    labelsLower.some((l) =>
      l.includes('doc') || l.includes('documentation') || l.includes('readme'),
    )
  ) {
    return 'documentation';
  }

  // 調査系
  if (
    labelsLower.some((l) =>
      l.includes('research') ||
      l.includes('investigation') ||
      l.includes('spike') ||
      l.includes('question'),
    )
  ) {
    return 'investigation';
  }

  // 統合系
  if (labelsLower.some((l) => l.includes('integration') || l.includes('merge'))) {
    return 'integration';
  }

  // デフォルトは実装
  return 'implementation';
}

/**
 * Issueから受け入れ基準を抽出
 *
 * Issue本文から「受け入れ基準」「Acceptance Criteria」などのセクションを探す
 */
export function extractAcceptanceCriteria(issue: ParsedIssue): string {
  const body = issue.body || '';

  // よくある受け入れ基準セクションのパターン
  const patterns = [
    /##\s*受け入れ(?:基準|条件)\s*\n([\s\S]*?)(?=\n##|$)/i,
    /##\s*acceptance\s*criteria\s*\n([\s\S]*?)(?=\n##|$)/i,
    /##\s*done\s*when\s*\n([\s\S]*?)(?=\n##|$)/i,
    /##\s*完了条件\s*\n([\s\S]*?)(?=\n##|$)/i,
  ];

  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  // 見つからなければタイトルと本文の最初の部分から生成
  const summary = body.split('\n').slice(0, 3).join(' ').substring(0, 200);
  return `Complete the task as described in Issue #${issue.number}: ${issue.title}\n${summary}`;
}

/**
 * Issueタイトルから簡潔なサマリーを生成
 */
export function generateTaskSummary(issue: ParsedIssue): string {
  const title = sanitizeIssueTitle(issue.title, 50);

  // プレフィックス（[feat], [bug]等）を除去
  const cleanTitle = title.replace(/^\[[^\]]+\]\s*/, '');

  return cleanTitle.length > 40
    ? cleanTitle.substring(0, 37) + '...'
    : cleanTitle;
}
