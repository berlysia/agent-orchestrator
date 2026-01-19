import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * バージョン情報を取得する
 *
 * WHY: 開発時（TypeScript直接実行）のために動的にバージョンを取得
 * WHY: ビルド時には静的なVERSION定数に置き換えられる
 */
export function getVersion(): string {
  // package.jsonのバージョンを取得
  let pkgVersion: string;
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const projectRoot = join(dirname(currentFile), '..', '..', '..');
    const packageJsonPath = join(projectRoot, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    pkgVersion = packageJson.version;
  } catch {
    // package.jsonの読み取りに失敗した場合のフォールバック
    return '0.1.0-dev';
  }

  // 現在のコミットに対応するGitタグを取得
  try {
    const gitTag = execSync('git describe --tags --exact-match', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // タグがvX.Y.Z形式の場合はv接頭辞を削除
    const tagVersion = gitTag.startsWith('v') ? gitTag.slice(1) : gitTag;

    // タグがpackage.jsonのバージョンと一致する場合
    if (tagVersion === pkgVersion) {
      return pkgVersion;
    }
  } catch {
    // タグがない場合は何もしない
  }

  // Gitコマンドでコミットハッシュを取得
  try {
    const commitHash = execSync('git rev-parse --short HEAD', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    return commitHash;
  } catch {
    // Gitが利用できない場合はpackage.jsonのバージョンに-devを付けて返す
    return `${pkgVersion}-dev`;
  }
}
