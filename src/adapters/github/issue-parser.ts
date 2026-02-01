/**
 * GitHub Issue Reference Parser (ADR-029)
 *
 * 各種形式のIssue参照をパースする。
 * - #123
 * - 123
 * - owner/repo#123
 * - https://github.com/owner/repo/issues/123
 */

import type { Result } from 'option-t/plain_result';
import { createOk, createErr } from 'option-t/plain_result';
import type { IssueParseError } from '../../types/errors.ts';
import { invalidIssueRef } from '../../types/errors.ts';
import type { IssueRef } from '../../types/github-issue.ts';

/**
 * Issue参照文字列かどうかを判定
 *
 * @param input 入力文字列
 * @returns Issue参照形式の場合true
 */
export function isIssueRef(input: string): boolean {
  const trimmed = input.trim();

  // #123 形式
  if (/^#\d+$/.test(trimmed)) {
    return true;
  }

  // 数字のみ
  if (/^\d+$/.test(trimmed)) {
    return true;
  }

  // owner/repo#123 形式
  if (/^[\w.-]+\/[\w.-]+#\d+$/.test(trimmed)) {
    return true;
  }

  // GitHub URL形式
  if (/^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Issue参照文字列をパースしてIssueRef型に変換
 *
 * @param input 入力文字列
 * @returns パース結果またはエラー
 */
export function parseIssueRef(input: string): Result<IssueRef, IssueParseError> {
  const trimmed = input.trim();

  // #123 形式
  const hashMatch = trimmed.match(/^#(\d+)$/);
  if (hashMatch && hashMatch[1] !== undefined) {
    const num = parseInt(hashMatch[1], 10);
    if (num > 0) {
      return createOk({ type: 'number', number: num });
    }
  }

  // 数字のみ
  const numberMatch = trimmed.match(/^(\d+)$/);
  if (numberMatch && numberMatch[1] !== undefined) {
    const num = parseInt(numberMatch[1], 10);
    if (num > 0) {
      return createOk({ type: 'number', number: num });
    }
  }

  // owner/repo#123 形式
  const ownerRepoMatch = trimmed.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (
    ownerRepoMatch &&
    ownerRepoMatch[1] !== undefined &&
    ownerRepoMatch[2] !== undefined &&
    ownerRepoMatch[3] !== undefined
  ) {
    const num = parseInt(ownerRepoMatch[3], 10);
    if (num > 0) {
      return createOk({
        type: 'url',
        owner: ownerRepoMatch[1],
        repo: ownerRepoMatch[2],
        number: num,
      });
    }
  }

  // GitHub URL形式
  const urlMatch = trimmed.match(
    /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/,
  );
  if (
    urlMatch &&
    urlMatch[1] !== undefined &&
    urlMatch[2] !== undefined &&
    urlMatch[3] !== undefined
  ) {
    const num = parseInt(urlMatch[3], 10);
    if (num > 0) {
      return createOk({
        type: 'url',
        owner: urlMatch[1],
        repo: urlMatch[2],
        number: num,
      });
    }
  }

  return createErr(invalidIssueRef(input));
}

/**
 * IssueRefを文字列形式に変換
 *
 * @param ref IssueRef
 * @returns 文字列表現
 */
export function formatIssueRef(ref: IssueRef): string {
  if (ref.type === 'number') {
    return `#${ref.number}`;
  }
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/**
 * IssueRefからGitHub URLを生成
 *
 * @param ref IssueRef
 * @param defaultOwner デフォルトのオーナー（number形式の場合に使用）
 * @param defaultRepo デフォルトのリポジトリ（number形式の場合に使用）
 * @returns GitHub URL
 */
export function issueRefToUrl(
  ref: IssueRef,
  defaultOwner?: string,
  defaultRepo?: string,
): string | undefined {
  if (ref.type === 'url') {
    return `https://github.com/${ref.owner}/${ref.repo}/issues/${ref.number}`;
  }

  if (defaultOwner && defaultRepo) {
    return `https://github.com/${defaultOwner}/${defaultRepo}/issues/${ref.number}`;
  }

  return undefined;
}
