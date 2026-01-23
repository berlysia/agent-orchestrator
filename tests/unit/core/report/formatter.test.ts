import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatReportAsMarkdown } from '../../../../src/core/report/formatter.ts';
import type { ReportData, IntegrationInfo } from '../../../../src/core/report/types.ts';

describe('formatReportAsMarkdown', () => {
  // ベースとなるモックデータを作成
  const createBaseReportData = (): ReportData => ({
    rootSessionId: 'session-123',
    period: {
      start: new Date('2024-01-23T10:00:00.000Z'),
      end: new Date('2024-01-23T12:00:00.000Z'),
    },
    statistics: {
      total: 5,
      completed: 3,
      failed: 1,
      skipped: 0,
      blocked: 1,
    },
    taskSummaries: [],
    events: [],
  });

  describe('integration info formatting', () => {
    it('should format report with full integration info', () => {
      const fullIntegrationInfo: IntegrationInfo = {
        integrationBranch: 'integration/test-branch',
        mergedCount: 3,
        conflictCount: 1,
        conflictResolutionTaskId: 'task-conflict-1',
        completionScore: 85,
        missingAspects: ['テストカバレッジ不足', 'ドキュメント未更新'],
      };

      const reportData: ReportData = {
        ...createBaseReportData(),
        integration: fullIntegrationInfo,
      };

      const markdown = formatReportAsMarkdown(reportData);

      // 統合結果セクションが含まれる
      assert.ok(markdown.includes('## 統合結果'));
      assert.ok(markdown.includes('- 統合ブランチ: integration/test-branch'));
      assert.ok(markdown.includes('- マージ成功: 3'));
      assert.ok(markdown.includes('- コンフリクト: 1'));
      assert.ok(markdown.includes('- コンフリクト解決タスク: task-conflict-1'));

      // 完了評価セクションが含まれる
      assert.ok(markdown.includes('### 完了評価'));
      assert.ok(markdown.includes('- スコア: 85%'));

      // 未達成の側面セクションが含まれる
      assert.ok(markdown.includes('### 未達成の側面'));
      assert.ok(markdown.includes('- テストカバレッジ不足'));
      assert.ok(markdown.includes('- ドキュメント未更新'));
    });

    it('should format report without integration info', () => {
      const reportData: ReportData = {
        ...createBaseReportData(),
        integration: undefined,
      };

      const markdown = formatReportAsMarkdown(reportData);

      // 統合結果セクションが含まれない
      assert.ok(!markdown.includes('## 統合結果'));
      assert.ok(!markdown.includes('### 完了評価'));
      assert.ok(!markdown.includes('### 未達成の側面'));
    });

    it('should format report with integration but without conflictResolutionTaskId', () => {
      const partialIntegrationInfo: IntegrationInfo = {
        integrationBranch: 'integration/test-branch',
        mergedCount: 5,
        conflictCount: 0,
        conflictResolutionTaskId: undefined,
        completionScore: 100,
        missingAspects: [],
      };

      const reportData: ReportData = {
        ...createBaseReportData(),
        integration: partialIntegrationInfo,
      };

      const markdown = formatReportAsMarkdown(reportData);

      // 統合結果セクションは含まれる
      assert.ok(markdown.includes('## 統合結果'));
      assert.ok(markdown.includes('- 統合ブランチ: integration/test-branch'));
      assert.ok(markdown.includes('- マージ成功: 5'));
      assert.ok(markdown.includes('- コンフリクト: 0'));

      // コンフリクト解決タスク行は含まれない
      assert.ok(!markdown.includes('- コンフリクト解決タスク:'));
    });

    it('should format report with integration but without completionScore', () => {
      const integrationWithoutScore: IntegrationInfo = {
        integrationBranch: 'integration/test-branch',
        mergedCount: 2,
        conflictCount: 1,
        conflictResolutionTaskId: 'task-123',
        completionScore: undefined,
        missingAspects: ['未完了タスク'],
      };

      const reportData: ReportData = {
        ...createBaseReportData(),
        integration: integrationWithoutScore,
      };

      const markdown = formatReportAsMarkdown(reportData);

      // 統合結果セクションは含まれる
      assert.ok(markdown.includes('## 統合結果'));

      // 完了評価セクションは含まれない
      assert.ok(!markdown.includes('### 完了評価'));
      assert.ok(!markdown.includes('- スコア:'));

      // 未達成の側面は含まれる
      assert.ok(markdown.includes('### 未達成の側面'));
      assert.ok(markdown.includes('- 未完了タスク'));
    });

    it('should format report with empty missingAspects', () => {
      const integrationWithEmptyMissing: IntegrationInfo = {
        integrationBranch: 'integration/test-branch',
        mergedCount: 3,
        conflictCount: 0,
        conflictResolutionTaskId: undefined,
        completionScore: 100,
        missingAspects: [],
      };

      const reportData: ReportData = {
        ...createBaseReportData(),
        integration: integrationWithEmptyMissing,
      };

      const markdown = formatReportAsMarkdown(reportData);

      // 統合結果セクションは含まれる
      assert.ok(markdown.includes('## 統合結果'));

      // 完了評価は含まれる
      assert.ok(markdown.includes('### 完了評価'));
      assert.ok(markdown.includes('- スコア: 100%'));

      // 未達成の側面セクションは含まれない（空配列の場合）
      assert.ok(!markdown.includes('### 未達成の側面'));
    });

    it('should format report with integration but without integrationBranch', () => {
      const integrationWithoutBranch: IntegrationInfo = {
        integrationBranch: undefined,
        mergedCount: 2,
        conflictCount: 1,
        conflictResolutionTaskId: 'task-456',
        completionScore: 75,
        missingAspects: ['改善点'],
      };

      const reportData: ReportData = {
        ...createBaseReportData(),
        integration: integrationWithoutBranch,
      };

      const markdown = formatReportAsMarkdown(reportData);

      // 統合結果セクションは含まれる
      assert.ok(markdown.includes('## 統合結果'));

      // integrationBranchがundefinedの場合は「未作成」と表示
      assert.ok(markdown.includes('- 統合ブランチ: 未作成'));
      assert.ok(markdown.includes('- マージ成功: 2'));
      assert.ok(markdown.includes('- コンフリクト: 1'));
    });
  });

  describe('basic report structure', () => {
    it('should include header and basic sections', () => {
      const reportData = createBaseReportData();
      const markdown = formatReportAsMarkdown(reportData);

      // 基本セクションの確認
      assert.ok(markdown.includes('# 監視レポート'));
      assert.ok(markdown.includes('## 監視期間'));
      assert.ok(markdown.includes('## タスク統計'));
      assert.ok(markdown.includes('## タスク実行サマリー'));
      assert.ok(markdown.includes('## 観察されたイベント'));
    });

    it('should format period correctly', () => {
      const reportData = createBaseReportData();
      const markdown = formatReportAsMarkdown(reportData);

      assert.ok(markdown.includes('- 開始: 2024-01-23T10:00:00.000Z'));
      assert.ok(markdown.includes('- 終了: 2024-01-23T12:00:00.000Z'));
    });

    it('should format statistics table correctly', () => {
      const reportData = createBaseReportData();
      const markdown = formatReportAsMarkdown(reportData);

      assert.ok(markdown.includes('| 総数 | 5 |'));
      assert.ok(markdown.includes('| 完了 | 3 |'));
      assert.ok(markdown.includes('| 失敗 | 1 |'));
      assert.ok(markdown.includes('| スキップ | 0 |'));
      assert.ok(markdown.includes('| ブロック | 1 |'));
    });
  });
});
