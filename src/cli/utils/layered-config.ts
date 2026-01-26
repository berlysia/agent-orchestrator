/**
 * Layered Configuration Utilities
 *
 * 階層化設定システムのコアロジック
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ConfigSchema } from '../../types/config.ts';
import type {
  ConfigLayer,
  ConfigLayerPaths,
  ConfigObject,
  ConfigSourceMap,
  ConfigValue,
  RawConfigFile,
  ReplaceMarker,
  ResetMarker,
  TrackedConfigResult,
} from '../../types/layered-config.ts';
import type { ConfigError } from '../../types/errors.ts';
import { configParseError, configValidationError, configMergeError } from '../../types/errors.ts';
import { createOk, createErr, type Result } from 'option-t/plain_result';

/**
 * 特殊記法の型ガード
 */
function isResetMarker(value: unknown): value is ResetMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    '$reset' in value &&
    (value as ResetMarker).$reset === true &&
    Object.keys(value).length === 1
  );
}

function isReplaceMarker(value: unknown): value is ReplaceMarker<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    '$replace' in value &&
    Object.keys(value).length === 1
  );
}

function isConfigObject(value: unknown): value is ConfigObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 階層ごとの設定ファイルパスを解決
 *
 * WHY: XDG Base Directory仕様に従い、グローバル設定は~/.config/agent-orchestrator/に配置
 *
 * @param projectRoot - プロジェクトルート（.agentディレクトリの親）
 */
export function resolveConfigLayerPaths(projectRoot?: string): ConfigLayerPaths {
  const homeDir = os.homedir();
  const cwd = projectRoot ?? process.cwd();

  // XDG Base Directory仕様に従う
  const configHome = process.env['XDG_CONFIG_HOME'] || path.join(homeDir, '.config');
  const globalConfigDir = path.join(configHome, 'agent-orchestrator');

  return {
    global: path.join(globalConfigDir, 'config.json'),
    globalLocal: path.join(globalConfigDir, 'config.local.json'),
    project: path.join(cwd, '.agent', 'config.json'),
    projectLocal: path.join(cwd, '.agent', 'config.local.json'),
  };
}

/**
 * 設定ファイルを読み込む（存在しない場合はnull）
 */
async function readConfigFile(layer: ConfigLayer, filePath: string): Promise<RawConfigFile> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content) as ConfigObject;

    return {
      layer,
      filePath,
      exists: true,
      data,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        layer,
        filePath,
        exists: false,
        data: null,
      };
    }

    throw configParseError(filePath, error);
  }
}

/**
 * Deep Merge with special markers support
 *
 * WHY: 階層化設定のマージ処理。$reset/$replace記法をサポート。
 *
 * マージ仕様:
 * - オブジェクト: 再帰的にマージ
 * - 配列: 上位階層で完全置換
 * - プリミティブ: 上位階層が優先
 * - $reset: 継承をキャンセル（下位階層から再計算）
 * - $replace: 完全置換（マージしない）
 *
 * @param lower - 下位優先度の値
 * @param upper - 上位優先度の値
 * @param keyPath - 現在のキーパス（デバッグ用）
 * @returns マージ結果
 */
function deepMerge(
  lower: ConfigValue | undefined,
  upper: ConfigValue | undefined,
  keyPath: string,
): ConfigValue {
  // upperが未定義の場合はlowerをそのまま返す
  if (upper === undefined) {
    return lower ?? null;
  }

  // $resetマーカー: 継承をキャンセル（lowerを返す）
  if (isResetMarker(upper)) {
    return lower ?? null;
  }

  // $replaceマーカー: 完全置換（マージしない）
  if (isReplaceMarker(upper)) {
    return upper.$replace as ConfigValue;
  }

  // upperがプリミティブまたは配列の場合、そのまま優先
  if (!isConfigObject(upper)) {
    return upper;
  }

  // lowerが未定義またはオブジェクトでない場合、upperを返す
  if (!isConfigObject(lower)) {
    return upper;
  }

  // 両方がオブジェクトの場合、再帰的にマージ
  const merged: ConfigObject = { ...lower };

  for (const [key, upperValue] of Object.entries(upper)) {
    const lowerValue = merged[key];
    const nextKeyPath = keyPath ? `${keyPath}.${key}` : key;

    merged[key] = deepMerge(lowerValue, upperValue, nextKeyPath);
  }

  return merged;
}

/**
 * 設定の出所を追跡しながらマージ
 *
 * WHY: どの設定値がどの階層から来ているかを記録し、
 *      デバッグや設定管理コマンドに利用できるようにする
 *
 * @param files - 下位優先度から上位優先度の順に並んだ設定ファイル
 * @returns マージ結果と出所マップ
 */
function mergeWithTracking(files: RawConfigFile[]): Result<
  { merged: ConfigObject; sourceMap: ConfigSourceMap },
  ConfigError
> {
  const sourceMap: ConfigSourceMap = new Map();
  let merged: ConfigObject = {};

  // 下位優先度から順にマージ
  for (const file of files) {
    if (!file.exists || !file.data) {
      continue;
    }

    // マージ実行
    const nextMerged = deepMerge(merged, file.data, '') as ConfigObject;

    // 出所追跡: 変更があったキーを記録
    trackSourceChanges(merged, nextMerged, file, sourceMap, '');

    merged = nextMerged;
  }

  return createOk({ merged, sourceMap });
}

/**
 * マージによる変更を追跡し、出所マップを更新
 */
function trackSourceChanges(
  before: ConfigObject,
  after: ConfigObject,
  source: RawConfigFile,
  sourceMap: ConfigSourceMap,
  keyPath: string,
): void {
  for (const [key, afterValue] of Object.entries(after)) {
    const beforeValue = before[key];
    const nextKeyPath = keyPath ? `${keyPath}.${key}` : key;

    // 値が変更された場合、出所を記録
    if (afterValue !== beforeValue) {
      // オブジェクトの場合は再帰的に追跡
      if (isConfigObject(afterValue) && isConfigObject(beforeValue)) {
        trackSourceChanges(beforeValue, afterValue, source, sourceMap, nextKeyPath);
      } else {
        // プリミティブ、配列、またはオブジェクト全体の置換
        sourceMap.set(nextKeyPath, {
          layer: source.layer,
          filePath: source.filePath,
        });
      }
    }
  }
}

/**
 * 特殊記法を除去
 *
 * WHY: Zodバリデーション前に$reset/$replaceマーカーを除去し、
 *      純粋な設定オブジェクトにする
 */
function stripSpecialMarkers(value: ConfigValue): ConfigValue {
  if (!isConfigObject(value)) {
    return value;
  }

  const result: ConfigObject = {};

  for (const [key, val] of Object.entries(value)) {
    // $reset/$replaceマーカーは除去
    if (isResetMarker(val) || isReplaceMarker(val)) {
      continue;
    }

    // ネストしたオブジェクトも再帰的に処理
    if (isConfigObject(val)) {
      result[key] = stripSpecialMarkers(val);
    } else if (Array.isArray(val)) {
      result[key] = val.map(stripSpecialMarkers);
    } else {
      result[key] = val;
    }
  }

  return result;
}

/**
 * 相対パスを設定ファイルの位置を基準に解決
 *
 * WHY: 各階層の設定ファイルで定義された相対パスは、
 *      その設定ファイルの親ディレクトリを基準に解決する
 *
 * @param config - マージ済み設定
 * @param sourceMap - 出所マップ
 * @returns パス解決済み設定
 */
function resolveConfigPaths(config: ConfigObject, sourceMap: ConfigSourceMap): ConfigObject {
  const resolved = { ...config };

  // appRepoPathとagentCoordPathを解決
  for (const pathKey of ['appRepoPath', 'agentCoordPath']) {
    const value = resolved[pathKey];
    if (typeof value !== 'string') {
      continue;
    }

    // 絶対パスの場合はそのまま
    if (path.isAbsolute(value)) {
      continue;
    }

    // 出所を確認し、その設定ファイルの位置を基準に解決
    const source = sourceMap.get(pathKey);
    if (!source) {
      continue;
    }

    // .agent/config.json -> .agent -> project root
    const configDir = path.dirname(path.dirname(source.filePath));
    resolved[pathKey] = path.resolve(configDir, value);
  }

  return resolved;
}

/**
 * 階層化設定を読み込む（出所追跡付き）
 *
 * WHY: 複数の設定ファイルを階層的にマージし、
 *      各設定値の出所を追跡可能にする
 *
 * @param projectRoot - プロジェクトルート（省略時はprocess.cwd()）
 * @returns 階層化設定の読み込み結果
 */
export async function loadTrackedConfig(
  projectRoot?: string,
): Promise<Result<TrackedConfigResult, ConfigError>> {
  const paths = resolveConfigLayerPaths(projectRoot);

  // 全階層の設定ファイルを読み込む（下位優先度から順）
  const files = await Promise.all([
    readConfigFile('global', paths.global),
    readConfigFile('global-local', paths.globalLocal),
    readConfigFile('project', paths.project),
    readConfigFile('project-local', paths.projectLocal),
  ]);

  // マージと出所追跡
  const mergeResult = mergeWithTracking(files);
  if (!mergeResult.ok) {
    return mergeResult;
  }

  const { merged, sourceMap } = mergeResult.val;

  // 特殊記法を除去
  const cleaned = stripSpecialMarkers(merged) as ConfigObject;

  // パス解決
  const resolved = resolveConfigPaths(cleaned, sourceMap);

  // Zodバリデーション
  try {
    const validated = ConfigSchema.parse(resolved);

    return createOk({
      config: validated,
      sourceMap,
    });
  } catch (error) {
    return createErr(configValidationError(error instanceof Error ? error.message : String(error)));
  }
}

/**
 * 特定階層の設定ファイルに値を設定
 *
 * WHY: CLIからの設定変更を可能にする
 *
 * @param layer - 設定階層
 * @param key - 設定キー（ドット区切り、例: "agents.worker.model"）
 * @param value - 設定値（undefinedの場合は削除）
 * @param projectRoot - プロジェクトルート
 */
export async function setConfigValue(
  layer: ConfigLayer,
  key: string,
  value: ConfigValue | undefined,
  projectRoot?: string,
): Promise<Result<void, ConfigError>> {
  const paths = resolveConfigLayerPaths(projectRoot);
  const layerPathMap: Record<ConfigLayer, string> = {
    global: paths.global,
    'global-local': paths.globalLocal,
    project: paths.project,
    'project-local': paths.projectLocal,
  };
  const layerPath = layerPathMap[layer];

  // 設定ファイルを読み込む
  const file = await readConfigFile(layer, layerPath);
  const config = file.data ?? {};

  // キーパスを辿って値を設定
  const keyParts = key.split('.');

  if (keyParts.length === 0) {
    return createErr(configMergeError('Invalid key: empty string'));
  }

  let current: ConfigObject = config;

  for (let i = 0; i < keyParts.length - 1; i++) {
    const part = keyParts[i];
    if (!part) continue;

    if (!isConfigObject(current[part])) {
      current[part] = {};
    }

    current = current[part] as ConfigObject;
  }

  const lastKey = keyParts[keyParts.length - 1];
  if (!lastKey) {
    return createErr(configMergeError('Invalid key: empty component'));
  }

  if (value === undefined) {
    // 削除
    delete current[lastKey];
  } else {
    // 設定
    current[lastKey] = value;
  }

  // ファイルに書き込む
  try {
    const dir = path.dirname(layerPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(layerPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

    return createOk(undefined);
  } catch (error) {
    return createErr(
      configMergeError(`Failed to write config file: ${error instanceof Error ? error.message : String(error)}`),
    );
  }
}

/**
 * 設定値を取得（キーパスで指定）
 *
 * WHY: ネストした設定値を簡単に取得できるようにする
 *
 * @param config - 設定オブジェクト
 * @param keyPath - キーパス（ドット区切り、例: "agents.worker.model"）
 * @returns 設定値（存在しない場合はundefined）
 */
export function getConfigValue(config: ConfigObject, keyPath: string): ConfigValue {
  const parts = keyPath.split('.');
  let current: ConfigValue = config;

  for (const part of parts) {
    if (!part) continue;

    if (!isConfigObject(current)) {
      return null;
    }

    const next: ConfigValue | undefined = current[part];

    if (next === undefined) {
      return null;
    }

    current = next;
  }

  return current;
}
