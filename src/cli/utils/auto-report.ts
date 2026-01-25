/**
 * Auto report generation utility
 *
 * WHY: オーケストレーション完了後にレポートを自動生成するためのユーティリティ
 */

import { createFileStore } from '../../core/task-store/file-store.ts';
import { PlannerSessionEffectsImpl } from '../../core/orchestrator/planner-session-effects-impl.ts';
import { ReportGenerator } from '../../core/report/generator.ts';

/**
 * セッションのレポートを安全に生成
 *
 * @param sessionId セッションID
 * @param coordPath agent-coordリポジトリのパス
 *
 * エラー時は警告を出力するが、例外はスローしない
 */
export async function generateReportSafely(sessionId: string, coordPath: string): Promise<void> {
  try {
    console.log('\n📊 Generating report...');

    const taskStore = createFileStore({ basePath: coordPath });
    const sessionEffects = new PlannerSessionEffectsImpl(coordPath);
    const reportGenerator = new ReportGenerator(sessionEffects, taskStore, coordPath);

    const reportPath = await reportGenerator.saveReport(sessionId);

    if (reportPath) {
      console.log(`   Report saved: ${reportPath}`);
    } else {
      console.warn('   Report generation returned undefined');
    }
  } catch (error) {
    console.warn('   Failed to generate report:', error);
  }
}
