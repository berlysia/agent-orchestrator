# CAS実装方式の選定結果

## 選定日時

2026-01-18

## 選定結果

**mkdirベースロック方式** を採用

## 理由

1. **シンプルな実装**: ファイルシステムのatomic操作（mkdir）を利用、理解しやすい
2. **ローカル環境に十分**: 現在の要件（並列度3以下、ローカル実行）に適合
3. **将来の拡張性**: リモート共有が必要になった際にGit commit方式へ移行可能

## 実装方式

### mkdirベースロック

```typescript
// ロック取得
try {
  await fs.mkdir(lockPath, { recursive: false });
  // ロック取得成功
} catch (err) {
  if (err.code === 'EEXIST') {
    // ロック取得失敗（他プロセスが保持中）
    throw new Error('Lock already held');
  }
  throw err;
}

// ロック解放
await fs.rmdir(lockPath);
```

### CAS更新フロー

1. ロック取得（`mkdir .locks/<taskId>`）
2. タスクJSON読み込み
3. versionチェック
4. 更新処理（version++）
5. JSON書き込み
6. ロック解放

## 将来の移行パス

リモート共有が必要になった場合：

- **Git commit方式** へ移行
- versionフィールドはそのまま利用
- push競合検出によるCAS実現

## 参考

- 計画書: Story 2.1 T0
