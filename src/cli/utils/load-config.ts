import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ConfigSchema, type Config } from '../../types/config.ts';
import { toDisplayPath } from './display-path.ts';

/**
 * 設定ファイルを読み込む
 *
 * 相対パスは設定ファイルの親ディレクトリ（app-repoルート）を基準に解決される
 *
 * @param configPath - 設定ファイルのパス（デフォルト: .agent/config.json）
 * @returns 設定オブジェクト（パスは絶対パスに解決済み）
 */
export async function loadConfig(configPath?: string): Promise<Config> {
  // 設定ファイルのパスを決定
  const resolvedConfigPath = configPath ?? path.join(process.cwd(), '.agent', 'config.json');

  try {
    const configContent = await fs.readFile(resolvedConfigPath, 'utf-8');
    const config = JSON.parse(configContent);
    const parsed = ConfigSchema.parse(config);

    // 設定ファイルのディレクトリ（app-repoルート）を基準に相対パスを解決
    const configDir = path.dirname(path.dirname(resolvedConfigPath)); // .agent/config.json -> app-repo root

    return {
      ...parsed,
      appRepoPath: path.resolve(configDir, parsed.appRepoPath),
      agentCoordPath: path.resolve(configDir, parsed.agentCoordPath),
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
