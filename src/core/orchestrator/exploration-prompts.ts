/**
 * Exploration Prompt Templates
 *
 * ADR-025: 自律探索モード
 *
 * コードベース探索用のプロンプトテンプレート。
 */

import { ExplorationFocus, type ExplorationFocus as ExplorationFocusType } from '../../types/exploration-session.ts';

/**
 * フォーカスエリアごとの詳細説明
 */
const FOCUS_DESCRIPTIONS: Record<ExplorationFocusType, string> = {
  [ExplorationFocus.CODE_QUALITY]: `
    - Type safety issues (any types, missing type annotations)
    - Error handling gaps (unhandled promises, generic catch blocks)
    - Code duplication
    - Unused variables, imports, or exports
    - Inconsistent naming conventions
  `,
  [ExplorationFocus.SECURITY]: `
    - Input validation issues
    - Potential injection vulnerabilities (SQL, XSS, command injection)
    - Hardcoded secrets or credentials
    - Insecure authentication/authorization patterns
    - Missing rate limiting or access controls
  `,
  [ExplorationFocus.PERFORMANCE]: `
    - N+1 query patterns
    - Unnecessary re-renders or computations
    - Memory leaks
    - Inefficient algorithms or data structures
    - Missing caching opportunities
  `,
  [ExplorationFocus.MAINTAINABILITY]: `
    - High cyclomatic complexity
    - Missing or outdated documentation
    - Long functions or classes
    - Deep nesting
    - Tight coupling between modules
  `,
  [ExplorationFocus.ARCHITECTURE]: `
    - Circular dependencies
    - Layer violations (e.g., UI accessing database directly)
    - Mixed responsibilities in modules
    - Inconsistent patterns across codebase
    - Missing abstractions
  `,
  [ExplorationFocus.DOCUMENTATION]: `
    - Missing JSDoc/TSDoc comments on public APIs
    - Outdated README or docs
    - Missing inline comments for complex logic
    - Undocumented configuration options
  `,
  [ExplorationFocus.TEST_COVERAGE]: `
    - Untested functions or modules
    - Missing edge case tests
    - Flaky tests
    - Missing integration tests
  `,
};

/**
 * 探索プロンプトを構築
 *
 * @param focus 探索フォーカスエリア
 * @param scope 探索対象ディレクトリ
 * @returns 探索用プロンプト
 */
export function buildExplorationPrompt(
  focus: ExplorationFocusType[],
  scope: string[],
): string {
  const focusItems = focus.map((f) => FOCUS_DESCRIPTIONS[f]).join('\n');
  const scopeList = scope.length > 0
    ? scope.map((s) => `- ${s}`).join('\n')
    : '- . (entire repository)';

  return `
# Code Exploration Task

You are analyzing a codebase to identify issues and improvement opportunities.

## Focus Areas
${focusItems}

## Scope
Analyze the following directories:
${scopeList}

## Instructions

1. **Explore** the codebase thoroughly within the specified scope
2. **Identify** issues based on the focus areas above
3. **Categorize** each finding by severity (low/medium/high/critical)
4. **Provide** actionable recommendations for each finding

## Output Format

For each finding, provide:

### Finding: [Title]
- **Category**: [code-quality|security|performance|maintainability|architecture|documentation|test-coverage]
- **Severity**: [low|medium|high|critical]
- **Location**: [file:line]
- **Description**: [Detailed explanation of the issue]
- **Recommendation**: [Specific actionable fix]
- **Actionable**: [yes|no]
- **Code Snippet** (if applicable):
\`\`\`
[relevant code]
\`\`\`

## Summary

After listing all findings, provide:
- Total findings by category
- Priority recommendations (top 3-5 most impactful changes)
- Estimated effort for improvements

## Structured Output

At the end, provide structured output in the following format:

\`\`\`json
{
  "type": "exploration",
  "findings": [
    {
      "title": "...",
      "category": "security|code-quality|performance|maintainability|architecture|documentation|test-coverage",
      "severity": "low|medium|high|critical",
      "file": "...",
      "line": 123,
      "description": "...",
      "recommendation": "...",
      "actionable": true
    }
  ],
  "summary": {
    "total": 10,
    "critical": 1,
    "high": 3,
    "medium": 4,
    "low": 2
  },
  "priorityRecommendations": ["...", "...", "..."]
}
\`\`\`
`.trim();
}

/**
 * 発見事項からタスク候補を生成するためのプロンプトを構築
 *
 * @param findings 発見事項のJSON
 * @returns タスク生成用プロンプト
 */
export function buildTaskGenerationPrompt(findings: string): string {
  return `
# Task Generation from Findings

Based on the following exploration findings, generate actionable task candidates.

## Findings
${findings}

## Instructions

For each actionable finding, generate a task candidate with:
1. A clear, concise summary (one sentence)
2. A detailed description of what needs to be done
3. Estimated effort (small: < 1 hour, medium: 1-4 hours, large: > 4 hours)

## Output Format

\`\`\`json
{
  "taskCandidates": [
    {
      "findingId": "...",
      "summary": "Fix SQL injection vulnerability in queries.ts",
      "description": "Replace string concatenation with parameterized queries to prevent SQL injection attacks.",
      "estimatedEffort": "small|medium|large"
    }
  ]
}
\`\`\`

Only include findings where actionable=true.
`.trim();
}

/**
 * 探索結果のサマリープロンプトを構築
 */
export function buildSummaryPrompt(sessionId: string, findingsCount: number): string {
  return `
# Exploration Summary

Session: ${sessionId}
Total Findings: ${findingsCount}

Please provide a high-level summary of the exploration results, including:
1. Overall code health assessment
2. Most critical issues that need immediate attention
3. Recommended order of addressing issues
4. Any patterns or systemic issues observed
`.trim();
}
