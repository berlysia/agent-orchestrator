/**
 * Config command
 *
 * 設定管理コマンド（show, set, unset, edit, validate）
 */

import { Command } from 'commander';
import * as child_process from 'node:child_process';
import * as util from 'node:util';
import type { ConfigLayer } from '../../types/layered-config.ts';
import {
  loadTrackedConfig,
  setConfigValue,
  getConfigValue,
  resolveConfigLayerPaths,
} from '../utils/layered-config.ts';
import { ConfigSchema } from '../../types/config.ts';
import * as fs from 'node:fs/promises';

/**
 * 設定値を人間が読みやすい形式で表示
 */
function formatConfigValue(value: unknown, indent = 0): string {
  const indentStr = '  '.repeat(indent);

  if (value === null || value === undefined) {
    return 'null';
  }

  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }

  if (typeof value === 'string') {
    return `"${value}"`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]';
    }

    const items = value.map((item) => `${indentStr}  - ${formatConfigValue(item, indent + 1)}`).join('\n');
    return `\n${items}`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return '{}';
    }

    const items = entries
      .map(([k, v]) => {
        const formattedValue = formatConfigValue(v, indent + 1);
        if (formattedValue.startsWith('\n')) {
          return `${indentStr}  ${k}:${formattedValue}`;
        }
        return `${indentStr}  ${k}: ${formattedValue}`;
      })
      .join('\n');
    return `\n${items}`;
  }

  return String(value);
}

/**
 * agent config show [key]
 *
 * 設定値を表示
 */
async function showCommand(
  key: string | undefined,
  options: { withSource?: boolean; layer?: ConfigLayer; json?: boolean },
): Promise<void> {
  const result = await loadTrackedConfig();

  if (!result.ok) {
    console.error(`Error: ${result.err.message}`);
    process.exit(1);
  }

  const { config, sourceMap } = result.val;

  // 特定階層のみ表示
  if (options.layer) {
    const paths = resolveConfigLayerPaths();
    const layerPath = {
      global: paths.global,
      'global-local': paths.globalLocal,
      project: paths.project,
      'project-local': paths.projectLocal,
    }[options.layer];

    try {
      const content = await fs.readFile(layerPath, 'utf-8');
      const data = JSON.parse(content);

      if (options.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(`Configuration (${options.layer}):`);
        console.log(formatConfigValue(data));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log(`No configuration found for layer: ${options.layer}`);
      } else {
        throw error;
      }
    }

    return;
  }

  // 特定キーのみ表示
  if (key) {
    const value = getConfigValue(config as never, key);

    if (value === undefined) {
      console.error(`Key not found: ${key}`);
      process.exit(1);
    }

    if (options.json) {
      console.log(JSON.stringify(value, null, 2));
    } else {
      console.log(`${key}: ${formatConfigValue(value)}`);

      if (options.withSource) {
        const source = sourceMap.get(key);
        if (source) {
          console.log(`  (from ${source.layer}: ${source.filePath})`);
        }
      }
    }

    return;
  }

  // 全設定を表示
  if (options.json) {
    console.log(JSON.stringify(config, null, 2));
  } else {
    console.log('Merged configuration:');
    console.log(formatConfigValue(config));

    if (options.withSource) {
      console.log('\n--- Configuration Sources ---');

      const sourcesByLayer = new Map<ConfigLayer, string[]>();

      for (const [k, source] of sourceMap.entries()) {
        const keys = sourcesByLayer.get(source.layer) ?? [];
        keys.push(k);
        sourcesByLayer.set(source.layer, keys);
      }

      for (const layer of ['global', 'global-local', 'project', 'project-local'] as ConfigLayer[]) {
        const keys = sourcesByLayer.get(layer);
        if (keys && keys.length > 0) {
          console.log(`\n[${layer}]`);
          for (const k of keys) {
            console.log(`  ${k}`);
          }
        }
      }
    }
  }
}

/**
 * agent config set <key> [value]
 *
 * 設定値を変更
 */
async function setCommand(
  key: string,
  value: string | undefined,
  options: { layer?: ConfigLayer; reset?: boolean },
): Promise<void> {
  const layer = options.layer ?? 'project';

  // --reset オプション
  if (options.reset) {
    const result = await setConfigValue(layer, key, { $reset: true } as never);

    if (!result.ok) {
      console.error(`Error: ${result.err.message}`);
      process.exit(1);
    }

    console.log(`Reset ${key} in ${layer} configuration`);
    return;
  }

  // 値が必要
  if (value === undefined) {
    console.error('Error: value is required (use --reset to reset inheritance)');
    process.exit(1);
  }

  // 値をパース（JSON形式をサポート）
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(value);
  } catch {
    // JSON以外は文字列として扱う
    parsedValue = value;
  }

  const result = await setConfigValue(layer, key, parsedValue as never);

  if (!result.ok) {
    console.error(`Error: ${result.err.message}`);
    process.exit(1);
  }

  console.log(`Set ${key} = ${value} in ${layer} configuration`);
}

/**
 * agent config unset <key>
 *
 * 設定値を削除
 */
async function unsetCommand(key: string, options: { layer?: ConfigLayer }): Promise<void> {
  const layer = options.layer ?? 'project';

  const result = await setConfigValue(layer, key, undefined);

  if (!result.ok) {
    console.error(`Error: ${result.err.message}`);
    process.exit(1);
  }

  console.log(`Unset ${key} from ${layer} configuration`);
}

/**
 * agent config edit
 *
 * エディタで設定ファイルを開く
 */
async function editCommand(options: { layer?: ConfigLayer }): Promise<void> {
  const layer = options.layer ?? 'project';
  const paths = resolveConfigLayerPaths();
  const layerPath = {
    global: paths.global,
    'global-local': paths.globalLocal,
    project: paths.project,
    'project-local': paths.projectLocal,
  }[layer];

  // エディタを決定
  const editor = process.env['EDITOR'] || process.env['VISUAL'] || 'vi';

  try {
    const { exec } = child_process;
    const execPromise = util.promisify(exec);
    await execPromise(`${editor} "${layerPath}"`);
  } catch (error) {
    console.error(`Failed to open editor: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

/**
 * agent config validate
 *
 * 設定を検証
 */
async function validateCommand(options: { file?: string }): Promise<void> {
  if (options.file) {
    // 特定ファイルを検証
    try {
      const content = await fs.readFile(options.file, 'utf-8');
      const data = JSON.parse(content);
      ConfigSchema.parse(data);

      console.log(`✓ Configuration is valid: ${options.file}`);
    } catch (error) {
      console.error(`✗ Validation failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  } else {
    // 階層化設定を検証
    const result = await loadTrackedConfig();

    if (!result.ok) {
      console.error(`✗ Validation failed: ${result.err.message}`);
      process.exit(1);
    }

    console.log('✓ Merged configuration is valid');
  }
}

/**
 * config コマンドを作成
 */
export function createConfigCommand(): Command {
  const config = new Command('config').description('Manage configuration files');

  // agent config show [key]
  config
    .command('show')
    .description('Show configuration')
    .argument('[key]', 'Configuration key (e.g., "maxWorkers", "agents.worker.model")')
    .option('--with-source', 'Show configuration sources')
    .option('--layer <layer>', 'Show specific layer only', /^(global|global-local|project|project-local)$/)
    .option('--json', 'Output as JSON')
    .action(showCommand);

  // agent config set <key> [value]
  config
    .command('set')
    .description('Set configuration value')
    .argument('<key>', 'Configuration key')
    .argument('[value]', 'Configuration value (JSON or string)')
    .option('--layer <layer>', 'Target layer (default: project)', /^(global|global-local|project|project-local)$/)
    .option('--reset', 'Reset inheritance (use $reset marker)')
    .action(setCommand);

  // agent config unset <key>
  config
    .command('unset')
    .description('Unset configuration value')
    .argument('<key>', 'Configuration key')
    .option('--layer <layer>', 'Target layer (default: project)', /^(global|global-local|project|project-local)$/)
    .action(unsetCommand);

  // agent config edit
  config
    .command('edit')
    .description('Edit configuration file in editor')
    .option('--layer <layer>', 'Target layer (default: project)', /^(global|global-local|project|project-local)$/)
    .action(editCommand);

  // agent config validate
  config
    .command('validate')
    .description('Validate configuration')
    .option('--file <path>', 'Validate specific file')
    .action(validateCommand);

  return config;
}
