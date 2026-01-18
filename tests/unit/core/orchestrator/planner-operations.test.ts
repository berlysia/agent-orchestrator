import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseAgentOutput, buildPlanningPrompt } from '../../../../src/core/orchestrator/planner-operations.ts';

describe('Planner Operations', () => {
  describe('buildPlanningPrompt', () => {
    it('should include user instruction in prompt', () => {
      const userInstruction = 'Build a TODO app';
      const prompt = buildPlanningPrompt(userInstruction);

      assert(prompt.includes(userInstruction));
      assert(prompt.includes('task planner'));
      assert(prompt.includes('JSON array'));
    });
  });

  describe('parseAgentOutput', () => {
    it('should parse valid JSON array', () => {
      const output = JSON.stringify([
        {
          description: 'Implement user authentication',
          branch: 'feature/auth',
          scopePaths: ['src/auth/'],
          acceptance: 'Users can login and logout',
        },
      ]);

      const result = parseAgentOutput(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].description, 'Implement user authentication');
      assert.strictEqual(result[0].branch, 'feature/auth');
      assert.deepStrictEqual(result[0].scopePaths, ['src/auth/']);
      assert.strictEqual(result[0].acceptance, 'Users can login and logout');
    });

    it('should extract JSON from markdown code blocks', () => {
      const output = `Here is the task breakdown:

\`\`\`json
[
  {
    "description": "Add login form",
    "branch": "feature/login-ui",
    "scopePaths": ["src/components/"],
    "acceptance": "Login form is displayed"
  }
]
\`\`\`

This is the recommended approach.`;

      const result = parseAgentOutput(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].description, 'Add login form');
    });

    it('should handle invalid output gracefully', () => {
      const output = 'This is not JSON';

      const result = parseAgentOutput(output);

      assert.strictEqual(result.length, 0);
    });

    it('should filter out invalid task breakdown items', () => {
      const output = JSON.stringify([
        {
          description: 'Valid task',
          branch: 'feature/valid',
          scopePaths: ['src/'],
          acceptance: 'Task is valid',
        },
        {
          description: 'Invalid task - missing branch',
          scopePaths: ['src/'],
          acceptance: 'This should be filtered out',
        },
        {
          description: 123, // Invalid type
          branch: 'feature/invalid',
          scopePaths: ['src/'],
          acceptance: 'Invalid description type',
        },
      ]);

      const result = parseAgentOutput(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].description, 'Valid task');
    });

    it('should wrap single object in array', () => {
      const output = JSON.stringify({
        description: 'Single task',
        branch: 'feature/single',
        scopePaths: ['src/'],
        acceptance: 'Task is single',
      });

      const result = parseAgentOutput(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].description, 'Single task');
    });

    it('should handle empty output', () => {
      const output = '';

      const result = parseAgentOutput(output);

      assert.strictEqual(result.length, 0);
    });

    it('should parse JSON without code blocks', () => {
      const output = `[
        {
          "description": "Create database schema",
          "branch": "feature/db-schema",
          "scopePaths": ["db/migrations/"],
          "acceptance": "Schema is created and tested"
        },
        {
          "description": "Implement API endpoints",
          "branch": "feature/api",
          "scopePaths": ["src/api/"],
          "acceptance": "Endpoints are functional"
        }
      ]`;

      const result = parseAgentOutput(output);

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].description, 'Create database schema');
      assert.strictEqual(result[1].description, 'Implement API endpoints');
    });
  });
});
