/**
 * GitHub Issue Types (ADR-029)
 *
 * GitHub Issue連携のための型定義。
 */

import { z } from 'zod';

/**
 * Issue参照タイプ（discriminated union）
 *
 * - number: #123 形式（現在のリポジトリ）
 * - url: owner/repo#123 または完全URL形式
 */
export type IssueRef =
  | { type: 'number'; number: number }
  | { type: 'url'; owner: string; repo: string; number: number };

/**
 * Issueコメント
 */
export interface IssueComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * パース済みIssue情報
 *
 * gh CLIから取得したIssueの構造化データ
 */
export interface ParsedIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  milestone?: string;
  state: 'OPEN' | 'CLOSED';
  url: string;
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
}

/**
 * ParsedIssueのZodスキーマ（gh CLI出力のバリデーション用）
 */
export const ParsedIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable().transform((v) => v ?? ''),
  labels: z.array(
    z.union([
      z.string(),
      z.object({ name: z.string() }).transform((v) => v.name),
    ]),
  ),
  assignees: z.array(
    z.union([
      z.string(),
      z.object({ login: z.string() }).transform((v) => v.login),
    ]),
  ),
  milestone: z
    .union([
      z.string(),
      z.object({ title: z.string() }).transform((v) => v.title),
      z.null(),
    ])
    .optional()
    .transform((v) => v ?? undefined),
  state: z.enum(['OPEN', 'CLOSED']),
  url: z.string(),
  comments: z.array(
    z.object({
      id: z.number().optional().default(0),
      author: z
        .union([
          z.string(),
          z.object({ login: z.string() }).transform((v) => v.login),
        ])
        .optional()
        .default('unknown'),
      body: z.string(),
      createdAt: z.string(),
      updatedAt: z.string().optional().default(''),
    }),
  ).optional().default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * タスクに紐づくIssue情報（Task型の拡張用）
 */
export interface SourceIssue {
  number: number;
  title: string;
  url: string;
  owner?: string;
  repo?: string;
}

/**
 * SourceIssueのZodスキーマ
 */
export const SourceIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  owner: z.string().optional(),
  repo: z.string().optional(),
});

/**
 * ラベルマッピング設定
 */
export interface LabelMapping {
  label: string;
  priority?: 'high' | 'normal' | 'low';
  workflow?: string;
}

/**
 * 完了時アクション設定
 */
export interface IssueCompletionActions {
  createPr?: boolean;
  commentOnIssue?: boolean;
  updateLabels?: {
    add?: string[];
    remove?: string[];
  };
}

/**
 * GitHub Issue連携設定
 */
export interface GitHubIssueConfig {
  labelMapping?: LabelMapping[];
  onComplete?: IssueCompletionActions;
}
