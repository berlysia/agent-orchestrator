#!/bin/bash

# コンパイルスクリプト
# WHY: ビルド失敗時もバックアップファイルを確実に復元するため
# WHY: package.json の && チェーンでは失敗時に後続処理が実行されない

set -e

# クリーンアップ関数：ビルド成功・失敗に関わらず実行
cleanup() {
  pnpm restore:version
}

# EXIT時に必ずクリーンアップを実行（成功時も失敗時も）
trap cleanup EXIT

# ビルド処理
rm -rf dist
pnpm generate:version
pnpm build
chmod +x dist/cli/index.js
pnpm generate:schema
