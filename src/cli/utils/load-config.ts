import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ConfigSchema, type Config, DEFAULT_REFINEMENT_CONFIG } from '../../types/config.ts';
import { toDisplayPath } from './display-path.ts';
import { loadTrackedConfig } from './layered-config.ts';

/**
 * 設定ファイルを読み込む
 *
 * WHY: 後方互換性を維持しつつ、内部で階層化ロードを使用する
 *
 * 動作:
 * - configPath未指定: 階層化ロードを使用（4階層マージ）
 * - configPath指定: 指定されたファイルのみを読み込む（従来動作）
 *
 * 相対パスは設定ファイルの親ディレクトリ（app-repoルート）を基準に解決される
 *
 * @param configPath - 設定ファイルのパス（省略時は階層化ロード）
 * @returns 設定オブジェクト（パスは絶対パスに解決済み）
 */
export async function loadConfig(configPath?: string): Promise<Config> {
  // configPath未指定の場合: 階層化ロードを使用
  if (configPath === undefined) {
    const result = await loadTrackedConfig();

    if (!result.ok) {
      const error = result.err;
      if (error.type === 'ConfigFileNotFoundError') {
        throw new Error(
          `Configuration file not found: ${toDisplayPath(error.filePath)}\nRun 'agent init' to create it.`,
        );
      }
      throw new Error(error.message);
    }

    // maxQualityRetriesとの互換性処理は階層化ロードでは不要
    // （各階層で個別に設定されているため）
    return result.val.config;
  }

  // configPath指定の場合: 従来動作（指定ファイルのみ読み込み）
  const resolvedConfigPath = configPath;

  try {
    const configContent = await fs.readFile(resolvedConfigPath, 'utf-8');
    const rawConfig = JSON.parse(configContent);
    const parsed = ConfigSchema.parse(rawConfig);

    // 設定ファイルのディレクトリ（app-repoルート）を基準に相対パスを解決
    const configDir = path.dirname(path.dirname(resolvedConfigPath)); // .agent/config.json -> app-repo root

    // Refinement設定のマージとmaxQualityRetriesとの互換性処理
    let refinement = { ...DEFAULT_REFINEMENT_CONFIG, ...(parsed.refinement ?? {}) };

    // 後方互換性: maxQualityRetriesが設定されており、refinementで明示的に指定されていない場合は移行
    if (rawConfig.maxQualityRetries !== undefined && rawConfig.refinement?.maxRefinementAttempts === undefined) {
      refinement = {
        ...refinement,
        maxRefinementAttempts: rawConfig.maxQualityRetries,
      };
    }

    return {
      ...parsed,
      appRepoPath: path.resolve(configDir, parsed.appRepoPath),
      agentCoordPath: path.resolve(configDir, parsed.agentCoordPath),
      refinement,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Configuration file not found: ${toDisplayPath(resolvedConfigPath)}\nRun 'agent init' to create it.`,
      );
    }
    throw error;
  }
}
