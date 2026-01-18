#!/usr/bin/env node

/**
 * .agent/config.json 用の JSON スキーマを生成
 *
 * WHY: IDE でオートコンプリートと検証を提供するため
 * WHY: Zod 4 のネイティブ z.toJSONSchema() を使用して自動生成
 */

import * as z from 'zod';
import { ConfigSchema } from '../src/types/config.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

async function main() {
  const jsonSchema = z.toJSONSchema(ConfigSchema);

  // $schema プロパティを追加
  const schemaWithMetadata = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Agent Orchestrator Configuration',
    description: 'Configuration file for Agent Orchestrator (.agent/config.json)',
    ...jsonSchema,
  };

  const distPath = path.join(process.cwd(), 'dist');

  // dist/.agent ディレクトリを作成
  await fs.mkdir(distPath, { recursive: true });

  const schemaPath = path.join(distPath, 'config.schema.json');

  await fs.writeFile(
    schemaPath,
    JSON.stringify(schemaWithMetadata, null, 2) + '\n',
    'utf-8',
  );

  console.log(`✅ JSON schema generated: ${schemaPath}`);
}

main().catch((error) => {
  console.error('❌ Failed to generate schema:', error);
  process.exit(1);
});
