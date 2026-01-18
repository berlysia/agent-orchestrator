import { z } from 'zod';

/**
 * プロジェクト設定のスキーマ定義（Zod）
 *
 * `.agent/config.json` に保存される設定
 */
export const ConfigSchema = z.object({
  /** 開発対象リポジトリのパス（app-repo） */
  appRepoPath: z.string(),

  /** タスク状態管理リポジトリのパス（agent-coord） */
  agentCoordPath: z.string(),

  /** Workerの最大並列実行数（デフォルト: 3） */
  maxWorkers: z.number().int().positive().default(3),

  /** デフォルトで使用するエージェント種別 */
  defaultAgentType: z.enum(['claude', 'codex']).default('claude'),

  /** Plannerが使用するエージェント種別 */
  plannerAgentType: z.enum(['claude', 'codex']).default('claude'),

  /** Workerが使用するエージェント種別 */
  workerAgentType: z.enum(['claude', 'codex']).default('claude'),

  /** Judgeが使用するエージェント種別 */
  judgeAgentType: z.enum(['claude', 'codex']).default('claude'),

  /** CI/Lintチェックを実行するか */
  enableChecks: z.boolean().default(true),

  /** CI/Lintチェック失敗時の動作（"block" | "warn"） */
  checkFailureMode: z.enum(['block', 'warn']).default('block'),
});

/**
 * Config型定義（TypeScript型）
 */
export type Config = z.infer<typeof ConfigSchema>;

/**
 * デフォルトConfig生成ヘルパー
 */
export function createDefaultConfig(params: {
  appRepoPath: string;
  agentCoordPath: string;
}): Config {
  return {
    appRepoPath: params.appRepoPath,
    agentCoordPath: params.agentCoordPath,
    maxWorkers: 3,
    defaultAgentType: 'claude',
    plannerAgentType: 'claude',
    workerAgentType: 'claude',
    judgeAgentType: 'claude',
    enableChecks: true,
    checkFailureMode: 'block',
  };
}
