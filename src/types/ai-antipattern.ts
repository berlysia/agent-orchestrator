/**
 * AI Antipattern Types - AIアンチパターン検出のための型定義
 *
 * ADR-031: AI Antipattern Review（AI生成コード品質ゲート）
 */

import { z } from 'zod';

/**
 * フォールバック違反の種類
 */
export const FallbackViolationType = {
  NULLISH_COALESCING: 'nullish_coalescing',
  LOGICAL_OR_DEFAULT: 'logical_or_default',
  EMPTY_CATCH: 'empty_catch',
  SILENT_SKIP: 'silent_skip',
  FALLBACK_CHAIN: 'fallback_chain',
} as const;

export type FallbackViolationType =
  (typeof FallbackViolationType)[keyof typeof FallbackViolationType];

/**
 * フォールバック違反
 */
export interface FallbackViolation {
  /** 違反の種類 */
  type: FallbackViolationType;
  /** ファイルパス */
  filePath: string;
  /** 行番号 */
  lineNumber: number;
  /** 問題のコードスニペット */
  codeSnippet: string;
  /** 説明 */
  description: string;
  /** 例外として許容される理由（あれば） */
  exemptionReason?: string;
}

/**
 * 未使用コード問題の種類
 */
export const UnusedCodeIssueType = {
  UNUSED_EXPORT: 'unused_export',
  UNUSED_FUNCTION: 'unused_function',
  UNUSED_VARIABLE: 'unused_variable',
  SYMMETRY_CODE: 'symmetry_code',
  FUTURE_EXTENSIBILITY: 'future_extensibility',
} as const;

export type UnusedCodeIssueType =
  (typeof UnusedCodeIssueType)[keyof typeof UnusedCodeIssueType];

/**
 * 未使用コード問題
 */
export interface UnusedCodeIssue {
  /** 問題の種類 */
  type: UnusedCodeIssueType;
  /** ファイルパス */
  filePath: string;
  /** 行番号 */
  lineNumber: number;
  /** シンボル名 */
  symbolName: string;
  /** 説明 */
  description: string;
  /** フレームワーク例外として許容されるか */
  isFrameworkException: boolean;
}

/**
 * スコープクリープ問題の種類
 */
export const ScopeCreepIssueType = {
  UNEXPECTED_FILE: 'unexpected_file',
  UNEXPECTED_FEATURE: 'unexpected_feature',
  OVER_ENGINEERING: 'over_engineering',
  PREMATURE_ABSTRACTION: 'premature_abstraction',
  GOLD_PLATING: 'gold_plating',
} as const;

export type ScopeCreepIssueType =
  (typeof ScopeCreepIssueType)[keyof typeof ScopeCreepIssueType];

/**
 * スコープクリープ問題
 */
export interface ScopeCreepIssue {
  /** 問題の種類 */
  type: ScopeCreepIssueType;
  /** 対象（ファイルパスまたは機能名） */
  target: string;
  /** 説明 */
  description: string;
  /** 元のタスク要件との乖離度（0-1） */
  deviationScore: number;
}

/**
 * Plausible-but-Wrong問題の種類
 */
export const PlausibleButWrongIssueType = {
  SEMANTIC_ERROR: 'semantic_error',
  HALLUCINATED_API: 'hallucinated_api',
  OUTDATED_PATTERN: 'outdated_pattern',
  BUSINESS_RULE_VIOLATION: 'business_rule_violation',
} as const;

export type PlausibleButWrongIssueType =
  (typeof PlausibleButWrongIssueType)[keyof typeof PlausibleButWrongIssueType];

/**
 * Plausible-but-Wrong問題
 */
export interface PlausibleButWrongIssue {
  /** 問題の種類 */
  type: PlausibleButWrongIssueType;
  /** ファイルパス */
  filePath: string;
  /** 行番号 */
  lineNumber?: number;
  /** 問題のコードスニペット */
  codeSnippet?: string;
  /** 説明 */
  description: string;
  /** 推奨される修正 */
  suggestedFix?: string;
}

/**
 * AIアンチパターンレビュー結果
 */
export interface AIAntipatternReviewResult {
  /** フォールバック違反 */
  fallbackViolations: FallbackViolation[];
  /** 未使用コード問題 */
  unusedCode: UnusedCodeIssue[];
  /** スコープクリープ問題 */
  scopeCreep: ScopeCreepIssue[];
  /** Plausible-but-Wrong問題 */
  plausibleButWrong: PlausibleButWrongIssue[];
  /** 全体のスコア（0-100、高いほど良い） */
  overallScore: number;
  /** REJECTすべきか */
  shouldReject: boolean;
  /** REJECT理由（shouldReject=trueの場合） */
  rejectReason?: string;
}

/**
 * AIアンチパターン設定スキーマ
 */
export const AIAntipatternConfigSchema = z
  .object({
    /** 機能を有効化 */
    enabled: z.boolean().default(true),

    /** フォールバック検出設定 */
    fallbackDetection: z
      .object({
        enabled: z.boolean().default(true),
        /** 検出から除外するファイルパターン */
        exceptions: z.array(z.string()).default(['*.config.ts', '*.config.js']),
      })
      .default({
        enabled: true,
        exceptions: ['*.config.ts', '*.config.js'],
      }),

    /** 未使用コード検出設定 */
    unusedCodeDetection: z
      .object({
        enabled: z.boolean().default(true),
        /** 検出ツール（knip | ts-prune | grep） */
        tool: z.enum(['knip', 'ts-prune', 'grep']).default('grep'),
        /** フレームワーク例外 */
        frameworkExceptions: z.array(z.string()).default(['react', 'express', 'node']),
      })
      .default({
        enabled: true,
        tool: 'grep',
        frameworkExceptions: ['react', 'express', 'node'],
      }),

    /** スコープクリープ検出設定 */
    scopeCreepDetection: z
      .object({
        enabled: z.boolean().default(true),
        /** スコープ超過の許容度（0-1） */
        tolerance: z.number().min(0).max(1).default(0.2),
      })
      .default({
        enabled: true,
        tolerance: 0.2,
      }),

    /** REJECT閾値（この数以上の問題でREJECT） */
    rejectThreshold: z.number().int().min(1).default(3),
  })
  .default({
    enabled: true,
    fallbackDetection: {
      enabled: true,
      exceptions: ['*.config.ts', '*.config.js'],
    },
    unusedCodeDetection: {
      enabled: true,
      tool: 'grep',
      frameworkExceptions: ['react', 'express', 'node'],
    },
    scopeCreepDetection: {
      enabled: true,
      tolerance: 0.2,
    },
    rejectThreshold: 3,
  });

export type AIAntipatternConfig = z.infer<typeof AIAntipatternConfigSchema>;

/**
 * デフォルトAIアンチパターン設定
 */
export const DEFAULT_AI_ANTIPATTERN_CONFIG: AIAntipatternConfig = {
  enabled: true,
  fallbackDetection: {
    enabled: true,
    exceptions: ['*.config.ts', '*.config.js'],
  },
  unusedCodeDetection: {
    enabled: true,
    tool: 'grep',
    frameworkExceptions: ['react', 'express', 'node'],
  },
  scopeCreepDetection: {
    enabled: true,
    tolerance: 0.2,
  },
  rejectThreshold: 3,
};
