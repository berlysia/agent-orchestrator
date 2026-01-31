/**
 * Eject Command - ビルトインリソースをユーザーディレクトリにコピー
 *
 * ADR-026: プロンプト外部化
 *
 * Usage:
 *   agent eject prompts           # すべてのプロンプトをeject
 *   agent eject prompts --agent worker  # 特定のエージェントのみ
 *   agent eject --all             # すべてのビルトインリソース
 */

import { Command } from 'commander';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { BUILTIN_PROMPTS, getPromptFileName } from '../../core/runner/builtin-prompts.ts';
import type { AgentRole } from '../../types/prompt.ts';

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
 * プロンプトディレクトリパスを取得
 */
const getPromptsDir = (global: boolean, projectDir?: string): string => {
  if (global) {
    return path.join(getGlobalConfigDir(), 'prompts');
  }
  return path.join(projectDir ?? process.cwd(), '.agent', 'prompts');
};

/**
 * ディレクトリを確実に作成
 */
const ensureDir = async (dirPath: string): Promise<void> => {
  await fs.mkdir(dirPath, { recursive: true });
};

/**
 * ファイルが存在するかチェック
 */
const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

/**
 * プロンプトをeject
 */
const ejectPrompts = async (options: {
  agent?: string;
  global: boolean;
  force: boolean;
  projectDir?: string;
}): Promise<void> => {
  const promptsDir = getPromptsDir(options.global, options.projectDir);
  await ensureDir(promptsDir);

  const agents: AgentRole[] = options.agent
    ? [options.agent as AgentRole]
    : (['planner', 'worker', 'judge', 'leader'] as AgentRole[]);

  console.log(`Ejecting prompts to: ${promptsDir}`);
  console.log('');

  for (const agent of agents) {
    const fileName = getPromptFileName(agent);
    const filePath = path.join(promptsDir, fileName);

    // 既存ファイルのチェック
    if (!options.force && (await fileExists(filePath))) {
      console.log(`  [SKIP] ${fileName} (already exists, use --force to overwrite)`);
      continue;
    }

    const content = BUILTIN_PROMPTS[agent];
    if (!content) {
      console.log(`  [WARN] No builtin prompt for agent: ${agent}`);
      continue;
    }

    await fs.writeFile(filePath, content, 'utf-8');
    console.log(`  [OK] ${fileName}`);
  }

  console.log('');
  console.log('Done! You can now customize the prompts.');
  console.log(`Edit files in: ${promptsDir}`);
};

/**
 * ejectコマンドを作成
 */
export const createEjectCommand = (): Command => {
  const command = new Command('eject')
    .description('Eject builtin resources for customization')
    .option('-g, --global', 'Eject to global config directory (~/.config/agent-orchestrator/)', false)
    .option('-f, --force', 'Overwrite existing files', false)
    .option('-d, --dir <path>', 'Project directory (default: current directory)');

  // サブコマンド: prompts
  command
    .command('prompts')
    .description('Eject builtin prompts')
    .option('-a, --agent <agent>', 'Specific agent to eject (planner, worker, judge, leader)')
    .action(async (subOptions: { agent?: string }) => {
      const parentOptions = command.opts();
      await ejectPrompts({
        agent: subOptions.agent,
        global: parentOptions['global'] as boolean,
        force: parentOptions['force'] as boolean,
        projectDir: parentOptions['dir'] as string | undefined,
      });
    });

  // サブコマンド: all
  command
    .command('all')
    .description('Eject all builtin resources')
    .action(async () => {
      const parentOptions = command.opts();
      console.log('Ejecting all builtin resources...');
      console.log('');

      // プロンプトをeject
      await ejectPrompts({
        global: parentOptions['global'] as boolean,
        force: parentOptions['force'] as boolean,
        projectDir: parentOptions['dir'] as string | undefined,
      });

      // 将来的に他のリソース（設定テンプレート、レポートテンプレート等）も追加可能
    });

  return command;
};
