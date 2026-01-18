import type { Config } from '../../types/config.ts';

/**
 * エージェント役割
 */
export type AgentRole = 'planner' | 'worker' | 'judge';

/**
 * Config から指定された役割のエージェントタイプを取得
 *
 * @param config プロジェクト設定
 * @param role エージェントの役割
 * @returns エージェントタイプ
 */
export const getAgentType = (config: Config, role: AgentRole): 'claude' | 'codex' => {
  return config.agents[role].type;
};

/**
 * Config から指定された役割のモデル名を取得
 *
 * @param config プロジェクト設定
 * @param role エージェントの役割
 * @returns モデル名（Claude使用時のみ）
 */
export const getModel = (config: Config, role: AgentRole): string | undefined => {
  const agentConfig = config.agents[role];
  return agentConfig.type === 'claude' ? agentConfig.model : undefined;
};
