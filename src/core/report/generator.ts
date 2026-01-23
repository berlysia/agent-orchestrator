/**
 * Report generator that integrates data collection and formatting
 *
 * WHY: データ収集とフォーマットを統合し、レポート生成とファイル保存を提供する
 *      監視レポート機能の中核となる統合インターフェース
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlannerSessionEffects } from '../orchestrator/planner-session-effects.ts';
import type { TaskStore } from '../task-store/interface.ts';
import { collectReportData } from './collector.ts';
import { formatReportAsMarkdown } from './formatter.ts';

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
}
