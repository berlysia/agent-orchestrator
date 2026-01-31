/**
 * AI Antipattern Reviewer - AI生成コードのアンチパターン検出
 *
 * ADR-031: AI Antipattern Review（AI生成コード品質ゲート）
 *
 * 検出対象:
 * 1. フォールバック乱用（?? 'default', catch { return ''; } 等）
 * 2. 未使用コード（使われていないexport、関数等）
 * 3. スコープクリープ（要求外の機能追加）
 * 4. Plausible-but-Wrong（構文的に正しいが意味的に誤り）
 */

import type {
  AIAntipatternConfig,
  AIAntipatternReviewResult,
  FallbackViolation,
  FallbackViolationType,
  UnusedCodeIssue,
  ScopeCreepIssue,
  PlausibleButWrongIssue,
} from '../../types/ai-antipattern.ts';
import { DEFAULT_AI_ANTIPATTERN_CONFIG } from '../../types/ai-antipattern.ts';

/**
 * AIAntipatternReviewer インターフェース
 */
export interface AIAntipatternReviewer {
  /**
   * コード変更をレビューしてアンチパターンを検出
   *
   * @param changedFiles 変更されたファイルの内容マップ
   * @param taskDescription 元のタスク説明（スコープクリープ検出用）
   * @returns レビュー結果
   */
  review(
    changedFiles: Map<string, string>,
    taskDescription?: string,
  ): Promise<AIAntipatternReviewResult>;

  /**
   * 単一ファイルのフォールバック違反を検出
   */
  detectFallbackViolations(
    filePath: string,
    content: string,
  ): FallbackViolation[];
}

/**
 * フォールバックパターン定義
 */
interface FallbackPattern {
  type: FallbackViolationType;
  pattern: RegExp;
  description: string;
}

/**
 * フォールバックパターンのリスト
 */
const FALLBACK_PATTERNS: FallbackPattern[] = [
  {
    type: 'nullish_coalescing',
    // ?? 'unknown', ?? 'default', ?? '', ?? [] 等を検出
    // ただし、変数への代入や設定オプションは除外が難しいため、パターンで絞る
    pattern: /\?\?\s*(['"`](?:unknown|default|error|none|N\/A)['"`]|\[\]|''|"")/gi,
    description: 'Nullish coalescing with suspicious default value',
  },
  {
    type: 'logical_or_default',
    // || 'default', || '' 等を検出
    pattern: /\|\|\s*(['"`](?:unknown|default|error|none|N\/A)['"`]|''|"")/gi,
    description: 'Logical OR with suspicious default value',
  },
  {
    type: 'empty_catch',
    // catch { return ''; }, catch { return []; }, catch { return null; } 等を検出
    pattern: /catch\s*(?:\([^)]*\))?\s*\{\s*(?:return\s*(?:''|""|null|\[\]|undefined|void\s+0);?\s*)\}/gi,
    description: 'Empty catch block that silently swallows errors',
  },
  {
    type: 'silent_skip',
    // if (!x) return; のパターン（エラーにすべき箇所）
    // これは文脈依存なので、より具体的なパターンに限定
    pattern: /if\s*\(\s*!\s*\w+\s*\)\s*return\s*;?\s*(?:\/\/\s*(?:skip|ignore|silent))?/gi,
    description: 'Silent skip without error handling',
  },
  {
    type: 'fallback_chain',
    // a ?? b ?? c ?? d のような多段フォールバック（3つ以上の??）
    pattern: /\?\?.*\?\?.*\?\?/g,
    description: 'Multi-level fallback chain',
  },
];

/**
 * フレームワーク例外パターン
 */
const FRAMEWORK_EXCEPTION_PATTERNS: Record<string, RegExp[]> = {
  react: [
    /^use[A-Z]/, // Hooks
    /^on[A-Z]/, // Event handlers
    /^handle[A-Z]/, // Handler functions
  ],
  express: [
    /^(get|post|put|delete|patch|use|all)$/, // HTTP methods
    /^middleware/, // Middleware
  ],
  node: [
    /^(setup|teardown)$/, // Test lifecycle
    /^(before|after)(Each|All)?$/, // Test hooks
  ],
};

/**
 * ファイルパスがパターンに一致するかチェック
 */
const matchesGlobPattern = (filePath: string, pattern: string): boolean => {
  // 簡易的なglob matching
  const regexPattern = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexPattern}$`).test(filePath);
};

/**
 * AIAntipatternReviewer実装を作成
 */
export const createAIAntipatternReviewer = (
  config: AIAntipatternConfig = DEFAULT_AI_ANTIPATTERN_CONFIG,
): AIAntipatternReviewer => {
  /**
   * フォールバック違反を検出
   */
  const detectFallbackViolations = (
    filePath: string,
    content: string,
  ): FallbackViolation[] => {
    if (!config.fallbackDetection.enabled) {
      return [];
    }

    // 例外パターンにマッチするファイルはスキップ
    for (const exceptionPattern of config.fallbackDetection.exceptions) {
      if (matchesGlobPattern(filePath, exceptionPattern)) {
        return [];
      }
    }

    const violations: FallbackViolation[] = [];
    const lines = content.split('\n');

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      if (line === undefined) continue;

      const lineNumber = lineIndex + 1;

      for (const pattern of FALLBACK_PATTERNS) {
        // パターンをリセット（グローバルフラグのため）
        pattern.pattern.lastIndex = 0;
        const match = pattern.pattern.exec(line);

        if (match) {
          // コメント行はスキップ
          const trimmedLine = line.trim();
          if (
            trimmedLine.startsWith('//') ||
            trimmedLine.startsWith('*') ||
            trimmedLine.startsWith('/*') ||
            trimmedLine.endsWith('*/')
          ) {
            continue;
          }

          // 明示的なコメントがあれば例外として記録
          const hasExemptionComment = /\/\/\s*(?:intentional|expected|required|ok)/i.test(
            line,
          );

          violations.push({
            type: pattern.type,
            filePath,
            lineNumber,
            codeSnippet: trimmedLine,
            description: pattern.description,
            exemptionReason: hasExemptionComment
              ? 'Explicit exemption comment found'
              : undefined,
          });
        }
      }
    }

    return violations;
  };

  /**
   * 未使用コードを検出（簡易版 - grepベース）
   */
  const detectUnusedCode = (
    changedFiles: Map<string, string>,
  ): UnusedCodeIssue[] => {
    if (!config.unusedCodeDetection.enabled) {
      return [];
    }

    const issues: UnusedCodeIssue[] = [];

    // 新規追加されたexportを抽出
    const exportPattern = /export\s+(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/g;

    for (const [filePath, content] of changedFiles) {
      const lines = content.split('\n');
      const exports: Array<{ name: string; line: number }> = [];

      // exportを抽出
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;

        exportPattern.lastIndex = 0;
        let match;
        while ((match = exportPattern.exec(line)) !== null) {
          const name = match[1];
          if (name !== undefined) {
            exports.push({ name, line: i + 1 });
          }
        }
      }

      // 各exportが他のファイルで使われているかチェック
      for (const exp of exports) {
        let isUsed = false;

        // フレームワーク例外チェック
        let isFrameworkException = false;
        for (const framework of config.unusedCodeDetection.frameworkExceptions) {
          const patterns = FRAMEWORK_EXCEPTION_PATTERNS[framework];
          if (patterns) {
            for (const pattern of patterns) {
              if (pattern.test(exp.name)) {
                isFrameworkException = true;
                break;
              }
            }
          }
        }

        // 他のファイルで使用されているかチェック
        for (const [otherPath, otherContent] of changedFiles) {
          if (otherPath === filePath) continue;

          // import文またはコード内での使用をチェック
          const usePattern = new RegExp(`\\b${exp.name}\\b`);
          if (usePattern.test(otherContent)) {
            isUsed = true;
            break;
          }
        }

        // 同じファイル内での使用もチェック（export以外の箇所）
        if (!isUsed) {
          const selfUsePattern = new RegExp(`\\b${exp.name}\\b`, 'g');
          const matches = content.match(selfUsePattern);
          // 2回以上出現すれば使用されている（1回はexport自体）
          if (matches && matches.length > 1) {
            isUsed = true;
          }
        }

        if (!isUsed && !isFrameworkException) {
          issues.push({
            type: 'unused_export',
            filePath,
            lineNumber: exp.line,
            symbolName: exp.name,
            description: `Export '${exp.name}' appears to be unused`,
            isFrameworkException: false,
          });
        }
      }
    }

    return issues;
  };

  /**
   * スコープクリープを検出
   */
  const detectScopeCreep = (
    changedFiles: Map<string, string>,
    taskDescription?: string,
  ): ScopeCreepIssue[] => {
    if (!config.scopeCreepDetection.enabled || !taskDescription) {
      return [];
    }

    const issues: ScopeCreepIssue[] = [];

    // タスク説明からキーワードを抽出
    const taskKeywords = new Set(
      taskDescription
        .toLowerCase()
        .split(/\W+/)
        .filter((word) => word.length > 3),
    );

    // 変更されたファイルがタスクと関連しているかチェック
    for (const [filePath] of changedFiles) {
      const fileKeywords = new Set(
        filePath
          .toLowerCase()
          .split(/[/\\._-]/)
          .filter((word) => word.length > 2),
      );

      // 共通キーワードの割合を計算
      let commonCount = 0;
      for (const keyword of fileKeywords) {
        if (taskKeywords.has(keyword)) {
          commonCount++;
        }
      }

      const relevanceScore = fileKeywords.size > 0 ? commonCount / fileKeywords.size : 0;

      // 関連性が低い場合はスコープクリープの可能性
      if (relevanceScore < 1 - config.scopeCreepDetection.tolerance) {
        issues.push({
          type: 'unexpected_file',
          target: filePath,
          description: `File '${filePath}' may be outside the task scope`,
          deviationScore: 1 - relevanceScore,
        });
      }
    }

    return issues;
  };

  /**
   * Plausible-but-Wrong問題を検出（基本的なパターン）
   */
  const detectPlausibleButWrong = (
    changedFiles: Map<string, string>,
  ): PlausibleButWrongIssue[] => {
    const issues: PlausibleButWrongIssue[] = [];

    // 存在しない可能性のあるAPIパターン
    const suspiciousApiPatterns = [
      // 存在しないArray/Objectメソッド
      { pattern: /\.(toSorted|toReversed|toSpliced|with)\s*\(/g, api: 'Newer Array methods (may not be available)' },
      // 存在しないPromiseメソッド
      { pattern: /Promise\.(any|allSettled)\s*\(/g, api: 'Newer Promise methods' },
    ];

    for (const [filePath, content] of changedFiles) {
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;

        const lineNumber = i + 1;

        for (const { pattern, api } of suspiciousApiPatterns) {
          pattern.lastIndex = 0;
          if (pattern.test(line)) {
            issues.push({
              type: 'hallucinated_api',
              filePath,
              lineNumber,
              codeSnippet: line.trim(),
              description: `Potentially unavailable API: ${api}`,
              suggestedFix: 'Verify this API is available in your target environment',
            });
          }
        }
      }
    }

    return issues;
  };

  /**
   * 総合スコアを計算
   */
  const calculateOverallScore = (result: Omit<AIAntipatternReviewResult, 'overallScore' | 'shouldReject' | 'rejectReason'>): number => {
    // 問題の重み付け
    const weights = {
      fallback: 10,
      unused: 5,
      scopeCreep: 15,
      plausibleButWrong: 20,
    };

    // 例外付きの違反は半分の重み
    const fallbackScore = result.fallbackViolations.reduce(
      (sum, v) => sum + (v.exemptionReason ? weights.fallback / 2 : weights.fallback),
      0,
    );

    // フレームワーク例外は除外
    const unusedScore = result.unusedCode
      .filter((u) => !u.isFrameworkException)
      .length * weights.unused;

    const scopeCreepScore = result.scopeCreep.reduce(
      (sum, s) => sum + s.deviationScore * weights.scopeCreep,
      0,
    );

    const plausibleScore = result.plausibleButWrong.length * weights.plausibleButWrong;

    const totalPenalty = fallbackScore + unusedScore + scopeCreepScore + plausibleScore;

    // 100から減点（最低0）
    return Math.max(0, 100 - totalPenalty);
  };

  /**
   * コード変更をレビュー
   */
  const review = async (
    changedFiles: Map<string, string>,
    taskDescription?: string,
  ): Promise<AIAntipatternReviewResult> => {
    if (!config.enabled) {
      return {
        fallbackViolations: [],
        unusedCode: [],
        scopeCreep: [],
        plausibleButWrong: [],
        overallScore: 100,
        shouldReject: false,
      };
    }

    // 各検出を実行
    const fallbackViolations: FallbackViolation[] = [];
    for (const [filePath, content] of changedFiles) {
      fallbackViolations.push(...detectFallbackViolations(filePath, content));
    }

    const unusedCode = detectUnusedCode(changedFiles);
    const scopeCreep = detectScopeCreep(changedFiles, taskDescription);
    const plausibleButWrong = detectPlausibleButWrong(changedFiles);

    // スコア計算
    const partialResult = {
      fallbackViolations,
      unusedCode,
      scopeCreep,
      plausibleButWrong,
    };
    const overallScore = calculateOverallScore(partialResult);

    // REJECTすべきかの判定
    const criticalIssueCount =
      fallbackViolations.filter((v) => !v.exemptionReason).length +
      unusedCode.filter((u) => !u.isFrameworkException).length +
      plausibleButWrong.length;

    const shouldReject = criticalIssueCount >= config.rejectThreshold;

    return {
      ...partialResult,
      overallScore,
      shouldReject,
      rejectReason: shouldReject
        ? `${criticalIssueCount} critical AI antipattern issues detected (threshold: ${config.rejectThreshold})`
        : undefined,
    };
  };

  return {
    review,
    detectFallbackViolations,
  };
};
