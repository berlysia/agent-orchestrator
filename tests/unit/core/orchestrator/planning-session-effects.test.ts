import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'fs';
import path from 'path';
import { PlanningSessionEffectsImpl } from '../../../../src/core/orchestrator/planning-session-effects-impl.ts';
import {
  createPlanningSession,
  PlanningSessionStatus,
} from '../../../../src/types/planning-session.ts';

describe('PlanningSessionEffectsImpl', () => {
  const testDir = path.join(process.cwd(), '.tmp', 'test-planning-session-effects');
  let effects: PlanningSessionEffectsImpl;

  beforeEach(async () => {
    // テスト用ディレクトリをクリーンアップ
    await fs.rm(testDir, { recursive: true, force: true });
    await fs.mkdir(testDir, { recursive: true });

    effects = new PlanningSessionEffectsImpl(testDir);
  });

  afterEach(async () => {
    // クリーンアップ
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('ensureSessionsDir', () => {
    it('should create planning-sessions directory', async () => {
      const result = await effects.ensureSessionsDir();
      assert.ok(result.ok);

      const sessionsDir = path.join(testDir, 'planning-sessions');
      const stats = await fs.stat(sessionsDir);
      assert.ok(stats.isDirectory());
    });
  });

  describe('saveSession and loadSession', () => {
    it('should save and load a planning session', async () => {
      const session = createPlanningSession('test-session-1', 'Test instruction');

      // 保存
      const saveResult = await effects.saveSession(session);
      assert.ok(saveResult.ok);

      // 読み込み
      const loadResult = await effects.loadSession('test-session-1');
      assert.ok(loadResult.ok);

      if (loadResult.ok) {
        assert.strictEqual(loadResult.val.sessionId, 'test-session-1');
        assert.strictEqual(loadResult.val.instruction, 'Test instruction');
        assert.strictEqual(loadResult.val.status, PlanningSessionStatus.DISCOVERY);
      }
    });

    it('should automatically update updatedAt on save', async () => {
      const session = createPlanningSession('test-session-2', 'Test instruction');
      const originalUpdatedAt = session.updatedAt;

      // 少し待つ
      await new Promise((resolve) => setTimeout(resolve, 10));

      // 保存
      await effects.saveSession(session);

      // 読み込み
      const loadResult = await effects.loadSession('test-session-2');
      assert.ok(loadResult.ok);

      if (loadResult.ok) {
        // updatedAtが更新されていることを確認
        assert.notStrictEqual(loadResult.val.updatedAt, originalUpdatedAt);
      }
    });

    it('should return error for non-existent session', async () => {
      const loadResult = await effects.loadSession('non-existent');
      assert.ok(!loadResult.ok);
    });

    it('should handle invalid JSON gracefully', async () => {
      // 無効なJSONを直接書き込む
      const sessionsDir = path.join(testDir, 'planning-sessions');
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(
        path.join(sessionsDir, 'invalid.json'),
        'invalid json',
        'utf-8',
      );

      const loadResult = await effects.loadSession('invalid');
      assert.ok(!loadResult.ok);
    });
  });

  describe('sessionExists', () => {
    it('should return true for existing session', async () => {
      const session = createPlanningSession('existing-session', 'Test instruction');
      await effects.saveSession(session);

      const existsResult = await effects.sessionExists('existing-session');
      assert.ok(existsResult.ok);
      if (existsResult.ok) {
        assert.strictEqual(existsResult.val, true);
      }
    });

    it('should return false for non-existent session', async () => {
      const existsResult = await effects.sessionExists('non-existent');
      assert.ok(existsResult.ok);
      if (existsResult.ok) {
        assert.strictEqual(existsResult.val, false);
      }
    });
  });

  describe('listSessions', () => {
    it('should return empty array when no sessions exist', async () => {
      const listResult = await effects.listSessions();
      assert.ok(listResult.ok);
      if (listResult.ok) {
        assert.strictEqual(listResult.val.length, 0);
      }
    });

    it('should list all sessions in descending order by createdAt', async () => {
      // 複数のセッションを作成（時間差をつける）
      const session1 = createPlanningSession('session-1', 'First instruction');
      await effects.saveSession(session1);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const session2 = createPlanningSession('session-2', 'Second instruction');
      await effects.saveSession(session2);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const session3 = createPlanningSession('session-3', 'Third instruction');
      await effects.saveSession(session3);

      // 一覧取得
      const listResult = await effects.listSessions();
      assert.ok(listResult.ok);

      if (listResult.ok) {
        assert.strictEqual(listResult.val.length, 3);

        // 降順でソートされていることを確認
        assert.strictEqual(listResult.val[0]?.sessionId, 'session-3');
        assert.strictEqual(listResult.val[1]?.sessionId, 'session-2');
        assert.strictEqual(listResult.val[2]?.sessionId, 'session-1');

        // サマリー内容の確認
        assert.strictEqual(listResult.val[0]?.instruction, 'Third instruction');
        assert.strictEqual(listResult.val[0]?.status, PlanningSessionStatus.DISCOVERY);
        assert.strictEqual(listResult.val[0]?.questionCount, 0);
        assert.strictEqual(listResult.val[0]?.decisionCount, 0);
      }
    });

    it('should skip invalid session files', async () => {
      // 正常なセッション
      const session = createPlanningSession('valid-session', 'Valid instruction');
      await effects.saveSession(session);

      // 無効なJSONファイルを作成
      const sessionsDir = path.join(testDir, 'planning-sessions');
      await fs.writeFile(path.join(sessionsDir, 'invalid.json'), 'invalid json', 'utf-8');

      // 一覧取得（無効なファイルはスキップされる）
      const listResult = await effects.listSessions();
      assert.ok(listResult.ok);

      if (listResult.ok) {
        assert.strictEqual(listResult.val.length, 1);
        assert.strictEqual(listResult.val[0]?.sessionId, 'valid-session');
      }
    });
  });

  describe('appendLog', () => {
    it('should create log file and append content', async () => {
      const logPath = path.join(testDir, 'logs', 'session-1', 'discovery.log');
      const content = 'Test log entry\n';

      const appendResult = await effects.appendLog(logPath, content);
      assert.ok(appendResult.ok);

      // ログファイルが作成されたことを確認
      const logContent = await fs.readFile(logPath, 'utf-8');
      assert.strictEqual(logContent, content);
    });

    it('should append to existing log file', async () => {
      const logPath = path.join(testDir, 'logs', 'session-2', 'design.log');

      // 1回目の追記
      await effects.appendLog(logPath, 'First entry\n');

      // 2回目の追記
      await effects.appendLog(logPath, 'Second entry\n');

      // ログファイルの内容を確認
      const logContent = await fs.readFile(logPath, 'utf-8');
      assert.strictEqual(logContent, 'First entry\nSecond entry\n');
    });
  });
});
