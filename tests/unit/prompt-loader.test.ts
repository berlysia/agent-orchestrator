/**
 * Prompt Loader Tests
 *
 * ADR-026: プロンプト外部化
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createPromptLoader,
  resetDefaultPromptLoader,
} from '../../src/core/runner/prompt-loader.ts';
import { BUILTIN_PROMPTS } from '../../src/core/runner/builtin-prompts.ts';
import { PromptSource, AgentRole } from '../../src/types/prompt.ts';

describe('PromptLoader', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-loader-test-'));
    resetDefaultPromptLoader();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('loadPrompt', () => {
    it('should return builtin prompt when no custom prompt exists', async () => {
      const loader = createPromptLoader();
      const result = await loader.loadPrompt(AgentRole.WORKER);

      assert.ok(result.ok, 'Expected successful result');
      assert.strictEqual(result.val.source, PromptSource.BUILTIN);
      assert.strictEqual(result.val.content, BUILTIN_PROMPTS[AgentRole.WORKER]);
    });

    it('should return project prompt when it exists', async () => {
      // Create project prompt
      const promptsDir = path.join(tempDir, '.agent', 'prompts');
      await fs.mkdir(promptsDir, { recursive: true });
      const customContent = '# Custom Worker Prompt\n\nThis is a custom prompt.';
      await fs.writeFile(path.join(promptsDir, 'worker.md'), customContent);

      const loader = createPromptLoader();
      const result = await loader.loadPrompt(AgentRole.WORKER, tempDir);

      assert.ok(result.ok, 'Expected successful result');
      assert.strictEqual(result.val.source, PromptSource.PROJECT);
      assert.strictEqual(result.val.content, customContent);
    });

    it('should load all agent roles', async () => {
      const loader = createPromptLoader();
      const roles: AgentRole[] = [
        AgentRole.PLANNER,
        AgentRole.WORKER,
        AgentRole.JUDGE,
        AgentRole.LEADER,
      ];

      for (const role of roles) {
        const result = await loader.loadPrompt(role);
        assert.ok(result.ok, `Expected successful result for ${role}`);
        assert.strictEqual(result.val.source, PromptSource.BUILTIN);
        assert.ok(result.val.content.length > 0, `Expected non-empty content for ${role}`);
      }
    });

    it('should cache prompts', async () => {
      const loader = createPromptLoader({ cacheEnabled: true });

      const result1 = await loader.loadPrompt(AgentRole.WORKER);
      const result2 = await loader.loadPrompt(AgentRole.WORKER);

      assert.ok(result1.ok && result2.ok);
      // loadedAt should be the same (cached)
      assert.strictEqual(result1.val.loadedAt, result2.val.loadedAt);
    });

    it('should not cache when disabled', async () => {
      const loader = createPromptLoader({ cacheEnabled: false });

      const result1 = await loader.loadPrompt(AgentRole.WORKER);
      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));
      const result2 = await loader.loadPrompt(AgentRole.WORKER);

      assert.ok(result1.ok && result2.ok);
      // loadedAt should be different (not cached)
      assert.notStrictEqual(result1.val.loadedAt, result2.val.loadedAt);
    });

    it('should return builtin when externalization is disabled', async () => {
      // Create project prompt
      const promptsDir = path.join(tempDir, '.agent', 'prompts');
      await fs.mkdir(promptsDir, { recursive: true });
      await fs.writeFile(path.join(promptsDir, 'worker.md'), '# Custom');

      const loader = createPromptLoader({ enabled: false });
      const result = await loader.loadPrompt(AgentRole.WORKER, tempDir);

      assert.ok(result.ok, 'Expected successful result');
      assert.strictEqual(result.val.source, PromptSource.BUILTIN);
    });
  });

  describe('expandVariables', () => {
    it('should expand all variables', () => {
      const loader = createPromptLoader();
      const template = 'Task: {task}\nIteration: {iteration}/{max_iterations}';
      const variables = {
        task: 'Implement feature X',
        iteration: 1,
        max_iterations: 3,
      };

      const result = loader.expandVariables(template, variables);

      assert.strictEqual(result, 'Task: Implement feature X\nIteration: 1/3');
    });

    it('should handle missing variables', () => {
      const loader = createPromptLoader();
      const template = 'Task: {task}\nContext: {context}';
      const variables = {
        task: 'Test task',
      };

      const result = loader.expandVariables(template, variables);

      // {context} should remain unexpanded
      assert.strictEqual(result, 'Task: Test task\nContext: {context}');
    });

    it('should expand multiple occurrences', () => {
      const loader = createPromptLoader();
      const template = '{task} - {task} - {task}';
      const variables = { task: 'X' };

      const result = loader.expandVariables(template, variables);

      assert.strictEqual(result, 'X - X - X');
    });
  });

  describe('clearCache', () => {
    it('should clear cached prompts', async () => {
      const loader = createPromptLoader({ cacheEnabled: true });

      const result1 = await loader.loadPrompt(AgentRole.WORKER);
      loader.clearCache();
      const result2 = await loader.loadPrompt(AgentRole.WORKER);

      assert.ok(result1.ok && result2.ok);
      // loadedAt should be different after cache clear
      assert.notStrictEqual(result1.val.loadedAt, result2.val.loadedAt);
    });
  });
});
