import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  parseAgentOutput,
  parseAgentOutputWithErrors,
  buildPlanningPrompt,
  buildTaskQualityPrompt,
  buildPlanningPromptWithFeedback,
  parseQualityJudgement,
  formatFeedbackForRetry,
  TaskTypeEnum,
  type TaskBreakdown,
  type TaskQualityJudgement,
} from '../../../../src/core/orchestrator/planner-operations.ts';

describe('Planner Operations', () => {
  describe('buildPlanningPrompt', () => {
    it('should include user instruction in prompt', () => {
      const userInstruction = 'Build a TODO app';
      const prompt = buildPlanningPrompt(userInstruction);

      assert(prompt.includes(userInstruction));
      assert(prompt.includes('task planner'));
      assert(prompt.includes('JSON array'));
    });

    it('should include new required fields (type, estimatedDuration, context)', () => {
      const prompt = buildPlanningPrompt('test');

      assert(prompt.includes('type'));
      assert(prompt.includes('estimatedDuration'));
      assert(prompt.includes('context'));
      assert(prompt.includes('implementation'));
      assert(prompt.includes('documentation'));
      assert(prompt.includes('investigation'));
      assert(prompt.includes('integration'));
    });

    it('should include granularity guidelines', () => {
      const prompt = buildPlanningPrompt('test');

      assert(prompt.includes('1-4 hour'));
      assert(prompt.includes('ALL fields are REQUIRED'));
    });
  });

  describe('parseAgentOutput', () => {
    it('should parse valid JSON array with all required fields', () => {
      const output = JSON.stringify([
        {
          id: 'task-1',
          description: 'Implement user authentication',
          branch: 'feature/auth',
          scopePaths: ['src/auth/'],
          acceptance: 'Users can login and logout',
          type: 'implementation',
          estimatedDuration: 3.0,
          context: 'Use bcrypt for password hashing',
          dependencies: [],
        },
      ]);

      const result = parseAgentOutput(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].description, 'Implement user authentication');
      assert.strictEqual(result[0].branch, 'feature/auth');
      assert.deepStrictEqual(result[0].scopePaths, ['src/auth/']);
      assert.strictEqual(result[0].acceptance, 'Users can login and logout');
      assert.strictEqual(result[0].type, 'implementation');
      assert.strictEqual(result[0].estimatedDuration, 3.0);
      assert.strictEqual(result[0].context, 'Use bcrypt for password hashing');
    });

    it('should extract JSON from markdown code blocks', () => {
      const output = `Here is the task breakdown:

\`\`\`json
[
  {
    "id": "task-1",
    "description": "Add login form",
    "branch": "feature/login-ui",
    "scopePaths": ["src/components/"],
    "acceptance": "Login form is displayed",
    "type": "implementation",
    "estimatedDuration": 2.0,
    "context": "Use existing form components",
    "dependencies": []
  }
]
\`\`\`

This is the recommended approach.`;

      const result = parseAgentOutput(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].description, 'Add login form');
      assert.strictEqual(result[0].type, 'implementation');
    });

    it('should handle invalid output gracefully', () => {
      const output = 'This is not JSON';

      const result = parseAgentOutput(output);

      assert.strictEqual(result.length, 0);
    });

    it('should filter out invalid task breakdown items (Zod validation)', () => {
      const output = JSON.stringify([
        {
          id: 'task-1',
          description: 'Valid task',
          branch: 'feature/valid',
          scopePaths: ['src/'],
          acceptance: 'Task is valid',
          type: 'implementation',
          estimatedDuration: 2.0,
          context: 'Valid context',
          dependencies: [],
        },
        {
          id: 'task-2',
          description: 'Invalid task - missing type',
          branch: 'feature/invalid',
          scopePaths: ['src/'],
          acceptance: 'This should be filtered out',
          estimatedDuration: 2.0,
          context: 'Missing type field',
          dependencies: [],
        },
        {
          id: 'task-3',
          description: 'Invalid task - invalid estimatedDuration',
          branch: 'feature/invalid2',
          scopePaths: ['src/'],
          acceptance: 'Invalid duration',
          type: 'implementation',
          estimatedDuration: 10.0, // Exceeds max (8)
          context: 'Duration too high',
          dependencies: [],
        },
      ]);

      const result = parseAgentOutput(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].description, 'Valid task');
    });

    it('should wrap single object in array', () => {
      const output = JSON.stringify({
        id: 'task-1',
        description: 'Single task',
        branch: 'feature/single',
        scopePaths: ['src/'],
        acceptance: 'Task is single',
        type: 'implementation',
        estimatedDuration: 1.5,
        context: 'Single task context',
        dependencies: [],
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
          "id": "task-1",
          "description": "Create database schema",
          "branch": "feature/db-schema",
          "scopePaths": ["db/migrations/"],
          "acceptance": "Schema is created and tested",
          "type": "implementation",
          "estimatedDuration": 3.5,
          "context": "Use existing migration tools",
          "dependencies": []
        },
        {
          "id": "task-2",
          "description": "Implement API endpoints",
          "branch": "feature/api",
          "scopePaths": ["src/api/"],
          "acceptance": "Endpoints are functional",
          "type": "implementation",
          "estimatedDuration": 4.0,
          "context": "Follow REST best practices",
          "dependencies": []
        }
      ]`;

      const result = parseAgentOutput(output);

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].description, 'Create database schema');
      assert.strictEqual(result[1].description, 'Implement API endpoints');
    });

    it('should return errors for tasks with missing required fields', () => {
      const output = JSON.stringify([
        {
          description: 'Task without type',
          branch: 'feature/test',
          scopePaths: ['src/'],
          acceptance: 'Test acceptance',
          // Missing: type, estimatedDuration, context
        },
      ]);

      const result = parseAgentOutputWithErrors(output);

      assert.strictEqual(result.tasks.length, 0);
      assert.strictEqual(result.errors.length > 0, true);
      assert(result.errors[0].includes('type'));
    });

    it('should validate all TaskType enum values', () => {
      const validTypes = ['implementation', 'documentation', 'investigation', 'integration'];

      validTypes.forEach((type) => {
        const output = JSON.stringify([
          {
            id: 'task-1',
            description: `Task with type ${type}`,
            branch: 'feature/test',
            scopePaths: ['src/'],
            acceptance: 'Test',
            type: type,
            estimatedDuration: 2.0,
            context: 'Test context',
            dependencies: [],
          },
        ]);

        const result = parseAgentOutput(output);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].type, type);
      });
    });

    it('should reject invalid task types', () => {
      const output = JSON.stringify([
        {
          description: 'Task with invalid type',
          branch: 'feature/test',
          scopePaths: ['src/'],
          acceptance: 'Test',
          type: 'invalid-type',
          estimatedDuration: 2.0,
          context: 'Test context',
        },
      ]);

      const result = parseAgentOutputWithErrors(output);

      assert.strictEqual(result.tasks.length, 0);
      assert(result.errors.length > 0);
      assert(result.errors[0].includes('type'));
    });

    it('should validate estimatedDuration range (0.5-8)', () => {
      const invalidDurations = [0.3, 0, -1, 10, 100];

      invalidDurations.forEach((duration) => {
        const output = JSON.stringify([
          {
            id: 'task-1',
            description: 'Task',
            branch: 'feature/test',
            scopePaths: ['src/'],
            acceptance: 'Test',
            type: 'implementation',
            estimatedDuration: duration,
            context: 'Test',
            dependencies: [],
          },
        ]);

        const result = parseAgentOutputWithErrors(output);
        assert.strictEqual(result.tasks.length, 0, `Duration ${duration} should be invalid`);
      });

      // Valid durations
      const validDurations = [0.5, 1.0, 4.0, 8.0];
      validDurations.forEach((duration) => {
        const output = JSON.stringify([
          {
            id: 'task-1',
            description: 'Task',
            branch: 'feature/test',
            scopePaths: ['src/'],
            acceptance: 'Test',
            type: 'implementation',
            estimatedDuration: duration,
            context: 'Test',
            dependencies: [],
          },
        ]);

        const result = parseAgentOutput(output);
        assert.strictEqual(result.length, 1, `Duration ${duration} should be valid`);
      });
    });
  });

  describe('Task Quality Evaluation', () => {
    describe('buildTaskQualityPrompt', () => {
      it('should include original instruction and tasks', () => {
        const userInstruction = 'Build a TODO app';
        const tasks: TaskBreakdown[] = [
          {
            id: 'task-1',
            description: 'Implement task list',
            branch: 'feature/task-list',
            scopePaths: ['src/tasks/'],
            acceptance: 'Tasks can be listed',
            type: 'implementation',
            estimatedDuration: 2.0,
            context: 'Use React hooks',
            dependencies: [],
          },
        ];

        const prompt = buildTaskQualityPrompt(userInstruction, tasks);

        assert(prompt.includes(userInstruction));
        assert(prompt.includes('Implement task list'));
        assert(prompt.includes('quality evaluator'));
      });

      it('should include previous feedback when provided', () => {
        const userInstruction = 'Build a TODO app';
        const tasks: TaskBreakdown[] = [
          {
            description: 'Test task',
            branch: 'feature/test',
            scopePaths: ['src/'],
            acceptance: 'Test',
            type: 'implementation',
            estimatedDuration: 1.0,
            context: 'Test context',
          },
        ];
        const feedback = 'Acceptance criteria are too vague';

        const prompt = buildTaskQualityPrompt(userInstruction, tasks, feedback);

        assert(prompt.includes(feedback));
        assert(prompt.includes('PREVIOUS FEEDBACK'));
      });
    });

    describe('parseQualityJudgement', () => {
      it('should parse valid JSON response', () => {
        const output = JSON.stringify({
          isAcceptable: false,
          issues: ['Acceptance criteria too vague'],
          suggestions: ['Add specific test cases'],
          overallScore: 60,
        });

        const result = parseQualityJudgement(output);

        assert.strictEqual(result.isAcceptable, false);
        assert.strictEqual(result.issues.length, 1);
        assert.strictEqual(result.suggestions.length, 1);
        assert.strictEqual(result.overallScore, 60);
      });

      it('should handle markdown code blocks', () => {
        const output = `Here is the evaluation:

\`\`\`json
{
  "isAcceptable": true,
  "issues": [],
  "suggestions": ["Consider adding edge cases"],
  "overallScore": 85
}
\`\`\`

This looks good.`;

        const result = parseQualityJudgement(output);

        assert.strictEqual(result.isAcceptable, true);
        assert.strictEqual(result.overallScore, 85);
      });

      it('should return default (acceptable) on parse error', () => {
        const output = 'This is not valid JSON';

        const result = parseQualityJudgement(output);

        assert.strictEqual(result.isAcceptable, true);
        assert.strictEqual(result.issues.length, 0);
        assert.strictEqual(result.suggestions.length, 0);
      });
    });

    describe('formatFeedbackForRetry', () => {
      it('should format judgement with all fields', () => {
        const judgement: TaskQualityJudgement = {
          isAcceptable: false,
          issues: ['Issue 1', 'Issue 2'],
          suggestions: ['Suggestion 1', 'Suggestion 2'],
          overallScore: 65,
        };

        const feedback = formatFeedbackForRetry(judgement);

        assert(feedback.includes('Overall Quality Score: 65/100'));
        assert(feedback.includes('Issues:'));
        assert(feedback.includes('1. Issue 1'));
        assert(feedback.includes('2. Issue 2'));
        assert(feedback.includes('Suggestions:'));
        assert(feedback.includes('1. Suggestion 1'));
        assert(feedback.includes('2. Suggestion 2'));
      });

      it('should format judgement without score', () => {
        const judgement: TaskQualityJudgement = {
          isAcceptable: false,
          issues: ['Problem found'],
          suggestions: [],
        };

        const feedback = formatFeedbackForRetry(judgement);

        assert(!feedback.includes('Overall Quality Score'));
        assert(feedback.includes('Issues:'));
        assert(feedback.includes('1. Problem found'));
      });
    });

    describe('buildPlanningPromptWithFeedback', () => {
      it('should include feedback in prompt', () => {
        const userInstruction = 'Build a TODO app';
        const feedback = 'Acceptance criteria need more detail';

        const prompt = buildPlanningPromptWithFeedback(userInstruction, feedback);

        assert(prompt.includes(userInstruction));
        assert(prompt.includes(feedback));
        assert(prompt.includes('QUALITY FEEDBACK FROM PREVIOUS ATTEMPT'));
      });
    });
  });
});
