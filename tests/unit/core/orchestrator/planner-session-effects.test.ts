import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'fs';
import path from 'path';
import { PlannerSessionEffectsImpl } from '../../../../src/core/orchestrator/planner-session-effects-impl.ts';
import { createPlannerSession } from '../../../../src/types/planner-session.ts';
import type { TaskBreakdown } from '../../../../src/core/orchestrator/planner-operations.ts';

const TEST_COORD_REPO = path.join(process.cwd(), '.tmp', 'test-planner-sessions');

describe('PlannerSessionEffects', () => {
  let sessionEffects: PlannerSessionEffectsImpl;

  beforeEach(async () => {
    sessionEffects = new PlannerSessionEffectsImpl(TEST_COORD_REPO);
    // クリーンな状態から開始
    await fs.rm(TEST_COORD_REPO, { recursive: true, force: true });
  });

  afterEach(async () => {
    // テスト後クリーンアップ
    await fs.rm(TEST_COORD_REPO, { recursive: true, force: true });
  });

  describe('ensureSessionsDir', () => {
    it('should create planner-sessions directory', async () => {
      const result = await sessionEffects.ensureSessionsDir();

      assert(result.ok, 'ensureSessionsDir should succeed');

      // ディレクトリが存在することを確認
      const sessionsDir = path.join(TEST_COORD_REPO, 'planner-sessions');
      const stat = await fs.stat(sessionsDir);
      assert(stat.isDirectory(), 'planner-sessions should be a directory');
    });

    it('should not fail if directory already exists', async () => {
      // 1回目
      const result1 = await sessionEffects.ensureSessionsDir();
      assert(result1.ok, 'First call should succeed');

      // 2回目
      const result2 = await sessionEffects.ensureSessionsDir();
      assert(result2.ok, 'Second call should also succeed');
    });
  });

  describe('saveSession', () => {
    it('should save session to file', async () => {
      const session = createPlannerSession('session-1', 'Build a TODO app');
      session.conversationHistory.push({
        role: 'user',
        content: 'Build a TODO app',
        timestamp: new Date().toISOString(),
      });

      const result = await sessionEffects.saveSession(session);

      assert(result.ok, 'saveSession should succeed');

      // ファイルが作成されたことを確認
      const sessionPath = path.join(TEST_COORD_REPO, 'planner-sessions', 'session-1.json');
      const stat = await fs.stat(sessionPath);
      assert(stat.isFile(), 'Session file should exist');

      // 内容を確認
      const content = await fs.readFile(sessionPath, 'utf-8');
      const saved = JSON.parse(content);
      assert.strictEqual(saved.sessionId, 'session-1');
      assert.strictEqual(saved.instruction, 'Build a TODO app');
      assert.strictEqual(saved.conversationHistory.length, 1);
    });

    it('should update updatedAt timestamp', async () => {
      const session = createPlannerSession('session-2', 'Test instruction');
      const originalUpdatedAt = session.updatedAt;

      // 少し待機してタイムスタンプが異なることを保証
      await new Promise((resolve) => setTimeout(resolve, 10));

      const result = await sessionEffects.saveSession(session);
      assert(result.ok, 'saveSession should succeed');

      // 保存されたセッションを読み込んで確認
      const loadResult = await sessionEffects.loadSession('session-2');
      assert(loadResult.ok, 'loadSession should succeed');

      if (!loadResult.ok) return; // Type guard
      const loaded = loadResult.val;
      assert.notStrictEqual(loaded.updatedAt, originalUpdatedAt, 'updatedAt should be updated');
    });
  });

  describe('loadSession', () => {
    it('should load saved session', async () => {
      const original = createPlannerSession('session-3', 'Original instruction');
      original.conversationHistory.push({
        role: 'user',
        content: 'User message',
        timestamp: new Date().toISOString(),
      });
      original.conversationHistory.push({
        role: 'assistant',
        content: 'Assistant response',
        timestamp: new Date().toISOString(),
      });

      await sessionEffects.saveSession(original);

      const loadResult = await sessionEffects.loadSession('session-3');

      assert(loadResult.ok, 'loadSession should succeed');
      if (!loadResult.ok) return; // Type guard

      const loaded = loadResult.val;
      assert.strictEqual(loaded.sessionId, 'session-3');
      assert.strictEqual(loaded.instruction, 'Original instruction');
      assert.strictEqual(loaded.conversationHistory.length, 2);
      assert.strictEqual(loaded.conversationHistory[0].role, 'user');
      assert.strictEqual(loaded.conversationHistory[0].content, 'User message');
      assert.strictEqual(loaded.conversationHistory[1].role, 'assistant');
      assert.strictEqual(loaded.conversationHistory[1].content, 'Assistant response');
    });

    it('should fail if session does not exist', async () => {
      const result = await sessionEffects.loadSession('nonexistent');

      assert(!result.ok, 'loadSession should fail for nonexistent session');
    });

    it('should validate session data with Zod', async () => {
      await sessionEffects.ensureSessionsDir();

      // 不正なデータを直接書き込み
      const sessionPath = path.join(TEST_COORD_REPO, 'planner-sessions', 'invalid.json');
      await fs.writeFile(
        sessionPath,
        JSON.stringify({
          sessionId: 'invalid',
          // instructionが欠落
          conversationHistory: 'not an array', // 不正な型
        }),
        'utf-8',
      );

      const result = await sessionEffects.loadSession('invalid');

      assert(!result.ok, 'loadSession should fail for invalid data');
    });
  });

  describe('sessionExists', () => {
    it('should return true for existing session', async () => {
      const session = createPlannerSession('session-4', 'Test');
      await sessionEffects.saveSession(session);

      const result = await sessionEffects.sessionExists('session-4');

      assert(result.ok, 'sessionExists should succeed');
      if (!result.ok) return; // Type guard

      assert.strictEqual(result.val, true, 'Session should exist');
    });

    it('should return false for nonexistent session', async () => {
      const result = await sessionEffects.sessionExists('nonexistent');

      assert(result.ok, 'sessionExists should succeed');
      if (!result.ok) return; // Type guard

      assert.strictEqual(result.val, false, 'Session should not exist');
    });
  });

  describe('session workflow', () => {
    it('should support save-load-update-load workflow', async () => {
      // 初期セッションを作成
      const session = createPlannerSession('workflow-test', 'Build an app');
      session.conversationHistory.push({
        role: 'user',
        content: 'Initial request',
        timestamp: new Date().toISOString(),
      });

      // 保存
      const saveResult1 = await sessionEffects.saveSession(session);
      assert(saveResult1.ok, 'First save should succeed');

      // 読み込み
      const loadResult = await sessionEffects.loadSession('workflow-test');
      assert(loadResult.ok, 'Load should succeed');
      if (!loadResult.ok) return;

      const loaded = loadResult.val;

      // 会話履歴を追加
      loaded.conversationHistory.push({
        role: 'assistant',
        content: 'Generated tasks',
        timestamp: new Date().toISOString(),
      });

      const taskBreakdown: TaskBreakdown = {
        id: 'task-1',
        description: 'Test task',
        branch: 'feature/test',
        scopePaths: ['src/'],
        acceptance: 'Task completed',
        type: 'implementation',
        estimatedDuration: 2.0,
        context: 'Test context',
        dependencies: [],
      };
      loaded.generatedTasks.push(taskBreakdown);

      // 再保存
      const saveResult2 = await sessionEffects.saveSession(loaded);
      assert(saveResult2.ok, 'Second save should succeed');

      // 再読み込み
      const loadResult2 = await sessionEffects.loadSession('workflow-test');
      assert(loadResult2.ok, 'Second load should succeed');
      if (!loadResult2.ok) return;

      const final = loadResult2.val;
      assert.strictEqual(final.conversationHistory.length, 2, 'Should have 2 messages');
      assert.strictEqual(final.generatedTasks.length, 1, 'Should have 1 task');
      assert.strictEqual(final.generatedTasks[0].id, 'task-1');
    });
  });
});
