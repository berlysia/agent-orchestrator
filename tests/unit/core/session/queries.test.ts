import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'fs';
import path from 'path';
import { listSessionsByRootId } from '../../../../src/core/session/queries.ts';
import { PlannerSessionEffectsImpl } from '../../../../src/core/orchestrator/planner-session-effects-impl.ts';
import { createPlannerSession, SessionStatus } from '../../../../src/types/planner-session.ts';

const TEST_COORD_REPO = path.join(process.cwd(), '.tmp', 'test-session-queries');

describe('Session queries', () => {
  let sessionEffects: PlannerSessionEffectsImpl;

  beforeEach(async () => {
    sessionEffects = new PlannerSessionEffectsImpl(TEST_COORD_REPO);
    // クリーンな状態から開始
    await fs.rm(TEST_COORD_REPO, { recursive: true, force: true });
    await sessionEffects.ensureSessionsDir();
  });

  afterEach(async () => {
    // テスト後クリーンアップ
    await fs.rm(TEST_COORD_REPO, { recursive: true, force: true });
  });

  describe('listSessionsByRootId', () => {
    describe('(1) 該当する全セッションを返す', () => {
      it('should return single session when no chain exists', async () => {
        // 単一セッション（連鎖なし）
        const rootSession = createPlannerSession('root-session-1', 'Build a TODO app');
        await sessionEffects.saveSession(rootSession);

        const result = await listSessionsByRootId('root-session-1', sessionEffects);

        assert(result.ok, 'listSessionsByRootId should succeed');
        if (!result.ok) return;

        const sessions = result.val;
        assert.strictEqual(sessions.length, 1, 'Should return 1 session');
        assert.strictEqual(sessions[0]?.sessionId, 'root-session-1');
      });

      it('should return all sessions in a chain with parentSessionId', async () => {
        // ルートセッション
        const rootSession = createPlannerSession('root-session-2', 'Initial instruction');
        rootSession.createdAt = '2024-01-01T00:00:00.000Z';
        await sessionEffects.saveSession(rootSession);

        // 子セッション1（continue）
        const childSession1 = createPlannerSession('child-session-1', 'Continue instruction 1');
        childSession1.parentSessionId = 'root-session-2';
        childSession1.rootSessionId = 'root-session-2';
        childSession1.createdAt = '2024-01-01T00:01:00.000Z';
        await sessionEffects.saveSession(childSession1);

        // 子セッション2（さらにcontinue）
        const childSession2 = createPlannerSession('child-session-2', 'Continue instruction 2');
        childSession2.parentSessionId = 'child-session-1';
        childSession2.rootSessionId = 'root-session-2';
        childSession2.createdAt = '2024-01-01T00:02:00.000Z';
        await sessionEffects.saveSession(childSession2);

        const result = await listSessionsByRootId('root-session-2', sessionEffects);

        assert(result.ok, 'listSessionsByRootId should succeed');
        if (!result.ok) return;

        const sessions = result.val;
        assert.strictEqual(sessions.length, 3, 'Should return 3 sessions in chain');

        // セッションIDを確認（作成日時の昇順でソート済み）
        const sessionIds = sessions.map((s) => s.sessionId);
        assert.deepStrictEqual(
          sessionIds,
          ['root-session-2', 'child-session-1', 'child-session-2'],
          'Sessions should be sorted by createdAt',
        );
      });

      it('should return sessions with only rootSessionId set (no parentSessionId)', async () => {
        // ルートセッション
        const rootSession = createPlannerSession('root-session-3', 'Initial instruction');
        await sessionEffects.saveSession(rootSession);

        // rootSessionIdのみ設定された子セッション（古いデータ構造を想定）
        const childSession = createPlannerSession('child-session-3', 'Continue instruction');
        childSession.rootSessionId = 'root-session-3';
        // parentSessionIdは設定しない（null/undefined）
        await sessionEffects.saveSession(childSession);

        const result = await listSessionsByRootId('root-session-3', sessionEffects);

        assert(result.ok, 'listSessionsByRootId should succeed');
        if (!result.ok) return;

        const sessions = result.val;
        assert.strictEqual(sessions.length, 2, 'Should return 2 sessions');

        const sessionIds = sessions.map((s) => s.sessionId);
        assert.ok(sessionIds.includes('root-session-3'), 'Should include root session');
        assert.ok(sessionIds.includes('child-session-3'), 'Should include child session');
      });
    });

    describe('(2) parentSessionIdによる連鎖を正しく追跡する', () => {
      it('should track deep parent chain correctly', async () => {
        // 深い連鎖を作成: root -> child1 -> child2 -> child3
        const rootSession = createPlannerSession('deep-root', 'Root instruction');
        rootSession.createdAt = '2024-01-01T00:00:00.000Z';
        await sessionEffects.saveSession(rootSession);

        const child1 = createPlannerSession('deep-child-1', 'Continue 1');
        child1.parentSessionId = 'deep-root';
        child1.rootSessionId = 'deep-root';
        child1.createdAt = '2024-01-01T00:01:00.000Z';
        await sessionEffects.saveSession(child1);

        const child2 = createPlannerSession('deep-child-2', 'Continue 2');
        child2.parentSessionId = 'deep-child-1';
        child2.rootSessionId = 'deep-root';
        child2.createdAt = '2024-01-01T00:02:00.000Z';
        await sessionEffects.saveSession(child2);

        const child3 = createPlannerSession('deep-child-3', 'Continue 3');
        child3.parentSessionId = 'deep-child-2';
        child3.rootSessionId = 'deep-root';
        child3.createdAt = '2024-01-01T00:03:00.000Z';
        await sessionEffects.saveSession(child3);

        const result = await listSessionsByRootId('deep-root', sessionEffects);

        assert(result.ok, 'listSessionsByRootId should succeed');
        if (!result.ok) return;

        const sessions = result.val;
        assert.strictEqual(sessions.length, 4, 'Should return 4 sessions in deep chain');

        const sessionIds = sessions.map((s) => s.sessionId);
        assert.deepStrictEqual(
          sessionIds,
          ['deep-root', 'deep-child-1', 'deep-child-2', 'deep-child-3'],
          'Sessions should be in correct order',
        );
      });

      it('should handle chain where only parentSessionId is set (rootSessionId missing)', async () => {
        // parentSessionIdのみで連鎖を追跡する場合
        const rootSession = createPlannerSession('parent-only-root', 'Root instruction');
        await sessionEffects.saveSession(rootSession);

        const child1 = createPlannerSession('parent-only-child-1', 'Continue 1');
        child1.parentSessionId = 'parent-only-root';
        // rootSessionIdは設定しない
        await sessionEffects.saveSession(child1);

        const child2 = createPlannerSession('parent-only-child-2', 'Continue 2');
        child2.parentSessionId = 'parent-only-child-1';
        // rootSessionIdは設定しない
        await sessionEffects.saveSession(child2);

        const result = await listSessionsByRootId('parent-only-root', sessionEffects);

        assert(result.ok, 'listSessionsByRootId should succeed');
        if (!result.ok) return;

        const sessions = result.val;
        assert.strictEqual(sessions.length, 3, 'Should return 3 sessions tracked by parentSessionId');

        const sessionIds = sessions.map((s) => s.sessionId);
        assert.ok(sessionIds.includes('parent-only-root'), 'Should include root');
        assert.ok(sessionIds.includes('parent-only-child-1'), 'Should include child 1');
        assert.ok(sessionIds.includes('parent-only-child-2'), 'Should include child 2');
      });

      it('should not include sessions from different chains', async () => {
        // 2つの独立した連鎖を作成
        const rootA = createPlannerSession('root-a', 'Root A');
        await sessionEffects.saveSession(rootA);

        const childA = createPlannerSession('child-a', 'Child A');
        childA.parentSessionId = 'root-a';
        childA.rootSessionId = 'root-a';
        await sessionEffects.saveSession(childA);

        const rootB = createPlannerSession('root-b', 'Root B');
        await sessionEffects.saveSession(rootB);

        const childB = createPlannerSession('child-b', 'Child B');
        childB.parentSessionId = 'root-b';
        childB.rootSessionId = 'root-b';
        await sessionEffects.saveSession(childB);

        // root-aの連鎖を取得
        const resultA = await listSessionsByRootId('root-a', sessionEffects);
        assert(resultA.ok, 'listSessionsByRootId should succeed');
        if (!resultA.ok) return;

        const sessionsA = resultA.val;
        assert.strictEqual(sessionsA.length, 2, 'Should return only sessions from chain A');

        const sessionIdsA = sessionsA.map((s) => s.sessionId);
        assert.ok(sessionIdsA.includes('root-a'), 'Should include root-a');
        assert.ok(sessionIdsA.includes('child-a'), 'Should include child-a');
        assert.ok(!sessionIdsA.includes('root-b'), 'Should not include root-b');
        assert.ok(!sessionIdsA.includes('child-b'), 'Should not include child-b');
      });
    });

    describe('(3) 失敗セッションも含めて取得する', () => {
      it('should include failed sessions in the chain', async () => {
        const rootSession = createPlannerSession('failed-root', 'Root instruction');
        rootSession.status = SessionStatus.COMPLETED;
        await sessionEffects.saveSession(rootSession);

        const failedChild = createPlannerSession('failed-child', 'Failed instruction');
        failedChild.parentSessionId = 'failed-root';
        failedChild.rootSessionId = 'failed-root';
        failedChild.status = SessionStatus.FAILED;
        await sessionEffects.saveSession(failedChild);

        const recoveredChild = createPlannerSession('recovered-child', 'Recovered instruction');
        recoveredChild.parentSessionId = 'failed-child';
        recoveredChild.rootSessionId = 'failed-root';
        recoveredChild.status = SessionStatus.COMPLETED;
        await sessionEffects.saveSession(recoveredChild);

        const result = await listSessionsByRootId('failed-root', sessionEffects);

        assert(result.ok, 'listSessionsByRootId should succeed');
        if (!result.ok) return;

        const sessions = result.val;
        assert.strictEqual(sessions.length, 3, 'Should return all sessions including failed ones');

        const sessionIds = sessions.map((s) => s.sessionId);
        assert.ok(sessionIds.includes('failed-child'), 'Should include failed session');

        // 失敗セッションのステータスを確認
        const failedSession = sessions.find((s) => s.sessionId === 'failed-child');
        assert.strictEqual(failedSession?.status, SessionStatus.FAILED, 'Failed session should have FAILED status');
      });

      it('should include sessions with different statuses', async () => {
        const rootSession = createPlannerSession('status-root', 'Root instruction');
        rootSession.status = SessionStatus.COMPLETED;
        await sessionEffects.saveSession(rootSession);

        const planningChild = createPlannerSession('planning-child', 'Planning instruction');
        planningChild.parentSessionId = 'status-root';
        planningChild.rootSessionId = 'status-root';
        planningChild.status = SessionStatus.PLANNING;
        await sessionEffects.saveSession(planningChild);

        const executingChild = createPlannerSession('executing-child', 'Executing instruction');
        executingChild.parentSessionId = 'status-root';
        executingChild.rootSessionId = 'status-root';
        executingChild.status = SessionStatus.EXECUTING;
        await sessionEffects.saveSession(executingChild);

        const result = await listSessionsByRootId('status-root', sessionEffects);

        assert(result.ok, 'listSessionsByRootId should succeed');
        if (!result.ok) return;

        const sessions = result.val;
        assert.strictEqual(sessions.length, 3, 'Should return sessions with all statuses');

        const statuses = sessions.map((s) => s.status);
        assert.ok(statuses.includes(SessionStatus.COMPLETED), 'Should include COMPLETED status');
        assert.ok(statuses.includes(SessionStatus.PLANNING), 'Should include PLANNING status');
        assert.ok(statuses.includes(SessionStatus.EXECUTING), 'Should include EXECUTING status');
      });
    });

    describe('(4) セッションが存在しない場合は空配列を返す', () => {
      it('should return empty array when no sessions exist', async () => {
        const result = await listSessionsByRootId('nonexistent-root', sessionEffects);

        assert(result.ok, 'listSessionsByRootId should succeed');
        if (!result.ok) return;

        const sessions = result.val;
        assert.strictEqual(sessions.length, 0, 'Should return empty array');
      });

      it('should return empty array when rootSessionId exists but has no children', async () => {
        // 他のセッションは存在するが、指定したrootSessionIdには属さない
        const otherRoot = createPlannerSession('other-root', 'Other root');
        await sessionEffects.saveSession(otherRoot);

        const otherChild = createPlannerSession('other-child', 'Other child');
        otherChild.parentSessionId = 'other-root';
        otherChild.rootSessionId = 'other-root';
        await sessionEffects.saveSession(otherChild);

        // 存在しないrootSessionIdで検索
        const result = await listSessionsByRootId('nonexistent-root', sessionEffects);

        assert(result.ok, 'listSessionsByRootId should succeed');
        if (!result.ok) return;

        const sessions = result.val;
        assert.strictEqual(sessions.length, 0, 'Should return empty array for nonexistent root');
      });
    });

    describe('Edge cases and robustness', () => {
      it('should handle circular references gracefully', async () => {
        // 循環参照を作成（実際にはデータ整合性エラーだが、robustに処理）
        const session1 = createPlannerSession('circular-1', 'Session 1');
        session1.parentSessionId = 'circular-2'; // circular-2への参照
        await sessionEffects.saveSession(session1);

        const session2 = createPlannerSession('circular-2', 'Session 2');
        session2.parentSessionId = 'circular-1'; // 循環参照
        await sessionEffects.saveSession(session2);

        // circular-1をrootとして検索
        const result = await listSessionsByRootId('circular-1', sessionEffects);

        assert(result.ok, 'listSessionsByRootId should succeed');
        if (!result.ok) return;

        const sessions = result.val;
        // 循環参照を検出して処理を停止するため、circular-1のみが返される
        // circular-2はcircular-1を親として持つため、circular-1に属すると判定される
        assert.strictEqual(sessions.length, 2, 'Should handle circular reference and include both sessions');

        const sessionIds = sessions.map((s) => s.sessionId).sort();
        assert.deepStrictEqual(sessionIds, ['circular-1', 'circular-2'].sort());
      });

      it('should handle missing parent session gracefully', async () => {
        // 親セッションが存在しない場合
        const orphanSession = createPlannerSession('orphan-session', 'Orphan');
        orphanSession.parentSessionId = 'missing-parent';
        orphanSession.rootSessionId = 'root-session';
        await sessionEffects.saveSession(orphanSession);

        const result = await listSessionsByRootId('root-session', sessionEffects);

        assert(result.ok, 'listSessionsByRootId should succeed');
        if (!result.ok) return;

        const sessions = result.val;
        // rootSessionIdが一致するため、orphanSessionも含まれる
        assert.strictEqual(sessions.length, 1, 'Should include orphan session');
        assert.strictEqual(sessions[0]?.sessionId, 'orphan-session');
      });

      it('should return sessions sorted by createdAt in ascending order', async () => {
        // タイムスタンプをずらして作成
        const root = createPlannerSession('time-root', 'Root');
        root.createdAt = '2024-01-01T00:00:00.000Z';
        await sessionEffects.saveSession(root);

        // 待機して確実に異なるタイムスタンプを取得
        await new Promise((resolve) => setTimeout(resolve, 10));

        const child3 = createPlannerSession('time-child-3', 'Child 3');
        child3.parentSessionId = 'time-root';
        child3.rootSessionId = 'time-root';
        child3.createdAt = '2024-01-01T00:03:00.000Z';
        await sessionEffects.saveSession(child3);

        const child1 = createPlannerSession('time-child-1', 'Child 1');
        child1.parentSessionId = 'time-root';
        child1.rootSessionId = 'time-root';
        child1.createdAt = '2024-01-01T00:01:00.000Z';
        await sessionEffects.saveSession(child1);

        const child2 = createPlannerSession('time-child-2', 'Child 2');
        child2.parentSessionId = 'time-root';
        child2.rootSessionId = 'time-root';
        child2.createdAt = '2024-01-01T00:02:00.000Z';
        await sessionEffects.saveSession(child2);

        const result = await listSessionsByRootId('time-root', sessionEffects);

        assert(result.ok, 'listSessionsByRootId should succeed');
        if (!result.ok) return;

        const sessions = result.val;
        assert.strictEqual(sessions.length, 4, 'Should return all sessions');

        const sessionIds = sessions.map((s) => s.sessionId);
        assert.deepStrictEqual(
          sessionIds,
          ['time-root', 'time-child-1', 'time-child-2', 'time-child-3'],
          'Sessions should be sorted by createdAt in ascending order',
        );
      });
    });
  });
});
