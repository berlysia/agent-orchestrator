/**
 * Layered Configuration Types
 *
 * 階層化設定システムの型定義
 */

import type { Config } from './config.ts';

/**
 * 設定階層
 *
 * 優先度: project-local (4) > project (3) > global-local (2) > global (1)
 */
export type ConfigLayer = 'global' | 'global-local' | 'project' | 'project-local';

/**
 * 設定の出所情報
 *
 * WHY: 設定値がどの階層から来ているかを追跡し、デバッグを容易にする
 */
export interface ConfigSource {
  /** 設定階層 */
  readonly layer: ConfigLayer;
  /** 設定ファイルの絶対パス */
  readonly filePath: string;
}

/**
 * 設定キーと出所のマップ
 *
 * キー例: "maxWorkers", "agents.worker.model", "checks.commands"
 */
export type ConfigSourceMap = Map<string, ConfigSource>;

/**
 * 階層化設定の読み込み結果
 *
 * WHY: マージ済み設定と各設定値の出所情報を一緒に返すことで、
 *      デバッグや設定管理コマンドの実装を可能にする
 */
export interface TrackedConfigResult {
  /** マージ済み設定 */
  readonly config: Config;
  /** 設定キーごとの出所マップ */
  readonly sourceMap: ConfigSourceMap;
}

/**
 * 特殊記法: $reset
 *
 * WHY: 継承をキャンセルし、下位優先度の階層から再計算する
 *
 * 使用例:
 * ```json
 * {
 *   "checks": {
 *     "commands": { "$reset": true }
 *   }
 * }
 * ```
 */
export interface ResetMarker {
  readonly $reset: true;
}

/**
 * 特殊記法: $replace
 *
 * WHY: オブジェクトのマージをせず、指定した値で完全置換する
 *
 * 使用例:
 * ```json
 * {
 *   "checks": {
 *     "$replace": {
 *       "enabled": false,
 *       "commands": ["pnpm test"]
 *     }
 *   }
 * }
 * ```
 */
export interface ReplaceMarker<T> {
  readonly $replace: T;
}

/**
 * 設定値の型（特殊記法を含む）
 */
export type ConfigValue =
  | string
  | number
  | boolean
  | null
  | ResetMarker
  | ReplaceMarker<unknown>
  | ConfigObject
  | ConfigValue[];

/**
 * 設定オブジェクト（特殊記法を含む）
 */
export interface ConfigObject {
  [key: string]: ConfigValue;
}

/**
 * 階層ごとの設定ファイルパス解決
 */
export interface ConfigLayerPaths {
  readonly global: string;
  readonly globalLocal: string;
  readonly project: string;
  readonly projectLocal: string;
}

/**
 * 設定ファイルの読み込み結果（バリデーション前）
 */
export interface RawConfigFile {
  /** 設定階層 */
  readonly layer: ConfigLayer;
  /** 設定ファイルの絶対パス */
  readonly filePath: string;
  /** ファイルが存在したか */
  readonly exists: boolean;
  /** 読み込んだ生の設定データ（特殊記法含む） */
  readonly data: ConfigObject | null;
}
