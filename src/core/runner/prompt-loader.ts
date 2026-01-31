/**
 * Prompt Loader - プロンプト外部化のためのローダー
 *
 * ADR-026: エージェントプロンプトをMarkdownファイルとして外部化
 *
 * 解決順序:
 * 1. .agent/prompts/<role>.md （プロジェクト固有）
 * 2. ~/.config/agent-orchestrator/prompts/<role>.md （ユーザーグローバル）
 * 3. ビルトイン（パッケージ埋め込み）
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Result } from 'option-t/plain_result';
import { createOk, createErr } from 'option-t/plain_result';
import type {
  AgentRole,
  PromptVariables,
  PromptLoadError,
  LoadedPrompt,
  PromptConfig,
} from '../../types/prompt.ts';
import {
  PromptLoadErrorType,
  PromptSource,
  promptLoadError,
} from '../../types/prompt.ts';
import { BUILTIN_PROMPTS } from './builtin-prompts.ts';

/**
 * XDG Base Directory準拠のグローバル設定パス
 */
const getGlobalConfigDir = (): string => {
  const xdgConfigHome = process.env['XDG_CONFIG_HOME'];
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, 'agent-orchestrator');
  }
  return path.join(os.homedir(), '.config', 'agent-orchestrator');
};

/**
 * プロンプトキャッシュエントリ
 */
interface CacheEntry {
  prompt: LoadedPrompt;
  expiresAt: number;
}

/**
 * PromptLoader インターフェース
 */
export interface PromptLoader {
  /**
   * 指定されたロールのプロンプトをロード
   *
   * @param role エージェントロール
   * @param projectDir プロジェクトディレクトリ（オプション）
   * @returns ロードされたプロンプト
   */
  loadPrompt(
    role: AgentRole,
    projectDir?: string,
  ): Promise<Result<LoadedPrompt, PromptLoadError>>;

  /**
   * プロンプトに変数を展開
   *
   * @param content プロンプトテンプレート
   * @param variables 変数
   * @returns 展開されたプロンプト
   */
  expandVariables(content: string, variables: PromptVariables): string;

  /**
   * キャッシュをクリア
   */
  clearCache(): void;
}

/**
 * PromptLoader実装を作成
 *
 * @param config プロンプト設定
 * @returns PromptLoader実装
 */
export const createPromptLoader = (config: Partial<PromptConfig> = {}): PromptLoader => {
  const cache = new Map<string, CacheEntry>();
  const effectiveConfig = {
    enabled: config.enabled ?? true,
    customPath: config.customPath,
    cacheEnabled: config.cacheEnabled ?? true,
    cacheTtlSeconds: config.cacheTtlSeconds ?? 300,
  };

  /**
   * キャッシュキーを生成
   */
  const getCacheKey = (role: AgentRole, projectDir?: string): string => {
    return `${role}:${projectDir ?? 'global'}`;
  };

  /**
   * キャッシュからプロンプトを取得
   */
  const getFromCache = (key: string): LoadedPrompt | undefined => {
    if (!effectiveConfig.cacheEnabled) return undefined;

    const entry = cache.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
      return undefined;
    }

    return entry.prompt;
  };

  /**
   * キャッシュにプロンプトを保存
   */
  const setCache = (key: string, prompt: LoadedPrompt): void => {
    if (!effectiveConfig.cacheEnabled) return;

    cache.set(key, {
      prompt,
      expiresAt: Date.now() + effectiveConfig.cacheTtlSeconds * 1000,
    });
  };

  /**
   * ファイルからプロンプトを読み込み
   */
  const tryReadPromptFile = async (
    filePath: string,
    source: PromptSource,
  ): Promise<Result<LoadedPrompt, PromptLoadError>> => {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return createOk({
        content,
        source,
        sourcePath: filePath,
        loadedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return createErr(
          promptLoadError(
            PromptLoadErrorType.FILE_NOT_FOUND,
            `Prompt file not found: ${filePath}`,
            filePath,
          ),
        );
      }
      return createErr(
        promptLoadError(
          PromptLoadErrorType.IO_ERROR,
          `Failed to read prompt file: ${filePath}`,
          filePath,
          error,
        ),
      );
    }
  };

  /**
   * プロンプトをロード（解決順序に従う）
   */
  const loadPrompt = async (
    role: AgentRole,
    projectDir?: string,
  ): Promise<Result<LoadedPrompt, PromptLoadError>> => {
    // 外部化が無効の場合はビルトインを返す
    if (!effectiveConfig.enabled) {
      const builtin = BUILTIN_PROMPTS[role];
      return createOk({
        content: builtin,
        source: PromptSource.BUILTIN,
        loadedAt: new Date().toISOString(),
      });
    }

    // キャッシュチェック
    const cacheKey = getCacheKey(role, projectDir);
    const cached = getFromCache(cacheKey);
    if (cached) {
      return createOk(cached);
    }

    const fileName = `${role}.md`;

    // 1. プロジェクト固有 (.agent/prompts/<role>.md)
    if (projectDir) {
      const projectPath = effectiveConfig.customPath
        ? path.join(effectiveConfig.customPath, fileName)
        : path.join(projectDir, '.agent', 'prompts', fileName);

      const projectResult = await tryReadPromptFile(projectPath, PromptSource.PROJECT);
      if (projectResult.ok) {
        setCache(cacheKey, projectResult.val);
        return projectResult;
      }
    }

    // 2. ユーザーグローバル (~/.config/agent-orchestrator/prompts/<role>.md)
    const globalPath = path.join(getGlobalConfigDir(), 'prompts', fileName);
    const globalResult = await tryReadPromptFile(globalPath, PromptSource.GLOBAL);
    if (globalResult.ok) {
      setCache(cacheKey, globalResult.val);
      return globalResult;
    }

    // 3. ビルトイン
    const builtin = BUILTIN_PROMPTS[role];
    const loadedPrompt: LoadedPrompt = {
      content: builtin,
      source: PromptSource.BUILTIN,
      loadedAt: new Date().toISOString(),
    };
    setCache(cacheKey, loadedPrompt);
    return createOk(loadedPrompt);
  };

  /**
   * プロンプトに変数を展開
   *
   * {variable_name} 形式のプレースホルダーを置換
   */
  const expandVariables = (content: string, variables: PromptVariables): string => {
    let result = content;

    // 各変数を展開
    const entries = Object.entries(variables) as [keyof PromptVariables, unknown][];
    for (const [key, value] of entries) {
      if (value !== undefined) {
        const placeholder = new RegExp(`\\{${key}\\}`, 'g');
        result = result.replace(placeholder, String(value));
      }
    }

    return result;
  };

  /**
   * キャッシュをクリア
   */
  const clearCache = (): void => {
    cache.clear();
  };

  return {
    loadPrompt,
    expandVariables,
    clearCache,
  };
};

/**
 * デフォルトのPromptLoader（シングルトン）
 */
let defaultLoader: PromptLoader | null = null;

/**
 * デフォルトのPromptLoaderを取得
 */
export const getDefaultPromptLoader = (): PromptLoader => {
  if (!defaultLoader) {
    defaultLoader = createPromptLoader();
  }
  return defaultLoader;
};

/**
 * デフォルトのPromptLoaderをリセット（テスト用）
 */
export const resetDefaultPromptLoader = (): void => {
  defaultLoader = null;
};
