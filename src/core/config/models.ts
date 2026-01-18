/**
 * エージェント設定（エージェントタイプとモデルのペア）
 */
export interface AgentConfig {
  /** エージェントタイプ（claude or codex） */
  readonly agentType: 'claude' | 'codex';
  /** モデル名（Claudeの場合のみ使用） */
  readonly model?: string;
}

/**
 * Agent role-specific configuration
 *
 * WHY: 役割ごとに最適なエージェント・モデルを使い分けることで、コスト削減と効率化を実現
 * - Planner: 高度な計画能力が必要 → Claude Opus
 * - Worker: バランス型の実装能力が必要 → Claude Sonnet（またはCodex）
 * - Judge/QualityCheck: 軽量で高速な判定が必要 → Claude Haiku
 */
export const AGENT_CONFIG = {
  /** Planner: タスク分解に使用（高度な計画能力が必要） */
  planner: {
    agentType: 'claude',
    model: 'claude-opus-4-5',
  } as const satisfies AgentConfig,

  /** Worker: タスク実装に使用（バランス型） */
  worker: {
    agentType: 'claude',
    model: 'claude-sonnet-4-5',
  } as const satisfies AgentConfig,

  /** Judge: タスク判定に使用（軽量で高速） */
  judge: {
    agentType: 'claude',
    model: 'claude-haiku-4-5',
  } as const satisfies AgentConfig,

  /** Quality Check: タスク品質評価に使用（軽量で高速） */
  qualityCheck: {
    agentType: 'claude',
    model: 'claude-haiku-4-5',
  } as const satisfies AgentConfig,

  /** Conflict Resolution: コンフリクト解決に使用（中程度の複雑さ） */
  conflictResolution: {
    agentType: 'claude',
    model: 'claude-sonnet-4-5',
  } as const satisfies AgentConfig,
} as const;

export type AgentRole = keyof typeof AGENT_CONFIG;

/**
 * 指定された役割のエージェント設定を取得
 *
 * @param role エージェントの役割
 * @returns エージェント設定
 */
export const getAgentConfig = (role: AgentRole): AgentConfig => {
  return AGENT_CONFIG[role];
};
