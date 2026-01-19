# GitHub連携 実装計画（ドラフト）

## 背景/目的

- Orchestratorの実行結果をGitHub上で追跡できるようにし、レビュー/判断/再実行の体験を統一する。
- 既存の内部成果物（Worker/Judgeの出力）をPR/コメント/チェックとして可視化し、開発フローの接続点を明確化する。
- **実装は別タスクで行う**（本ドキュメントは計画のみ）。

## 対象ユーザー

- Agent Orchestratorを運用する開発者/メンテナ
- CI/レビュー担当者（PRの状態や判定結果を確認する人）

## スコープ

- PR作成/更新の最小機能（タイトル・本文・ラベル/メタ情報の反映）
- PR/Issueコメントの投稿（要約・ログリンク）
- Checks/Statusesの記録（Judge結果の可視化）
- Actions結果参照（Workflow Runの取得）

## 非スコープ

- マージ/リリースの自動化
- GitHub Projects/Wiki/Discussionsの統合
- Actionsの実行制御（今回は参照のみ）

## 段階的ロードマップ

### フェーズ1: PR作成（最小実装）

- 成果物:
  - PR作成のAPI呼び出し定義と最小入力モデル
  - PR作成結果の取り回し（PR URLを保存）
  - 失敗時の分類（認証・リモートなし・既存PRなど）

### フェーズ2: PR管理/更新・コメント

- 成果物:
  - 既存PR更新（本文・ラベルの差し替え）
  - 実行ログ要約のコメント投稿
  - 既存PR検出ロジック（PR既存時の更新分岐）

### フェーズ3: Checks/Actions統合

- 成果物:
  - Judge結果をChecks/Statusesとして登録
  - PRに紐づくActions結果の取得と記録
  - 失敗時の再試行/バックオフの運用基準

## 依存関係

- 既存コード参照（必ず明記する）:
  - `src/core/orchestrator/integration-operations.ts` の **PR作成 TODO**
  - `src/types/integration.ts` の `IntegrationFinalResult.prUrl`
  - `src/types/config.ts` の `integration.method`
- GitHub APIへの認証方式（PAT / GitHub App）
- `.agent` or 環境変数でのトークン管理方針

## リスク/留意点

- エッジケース（計画に必ず言及する）:
  - リモートなし（Git未設定/URL取得不可）
  - 認証トークン未設定（環境変数欠如）
  - レート制限（Secondary Rate Limit含む）
  - PR既存（作成ではなく更新へ分岐）
- エラー時のリトライとバックオフ方針を先に定義する必要がある。
- GitHub APIの権限不足/スコープ不足の検知とユーザー通知を明示する。
