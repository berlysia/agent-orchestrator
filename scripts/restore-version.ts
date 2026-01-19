#!/usr/bin/env node

/**
 * ビルド後にget-version.tsを元に戻す
 *
 * WHY: ビルド時にget-version.tsを書き換えるが、Gitの変更として残したくないため
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

async function main() {
  const originalPath = path.join(
    process.cwd(),
    'src',
    'cli',
    'utils',
    'get-version.ts.original',
  );
  const targetPath = path.join(
    process.cwd(),
    'src',
    'cli',
    'utils',
    'get-version.ts',
  );

  try {
    // バックアップファイルが存在する場合のみ復元
    await fs.access(originalPath);
    await fs.copyFile(originalPath, targetPath);
    await fs.unlink(originalPath);
    console.log('✅ Restored get-version.ts from backup');
  } catch (error) {
    // バックアップファイルが存在しない場合は何もしない
    if (error.code === 'ENOENT') {
      console.log('ℹ️  No backup found, skipping restore');
    } else {
      throw error;
    }
  }
}

main().catch((error) => {
  console.error('❌ Failed to restore version file:', error);
  process.exit(1);
});
