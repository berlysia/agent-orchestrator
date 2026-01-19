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
  formatFeedbackForLog,
  buildFinalCompletionPrompt,
  parseFinalCompletionJudgement,
  detectCircularDependencies,
  validateTaskDependencies,
  TaskTypeEnum,
  type TaskBreakdown,
  type TaskQualityJudgement,
  type FinalCompletionJudgement,
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

      it('should include previous full response when provided', () => {
        const judgement: TaskQualityJudgement = {
          isAcceptable: false,
          issues: ['Context field incomplete'],
          suggestions: [],
        };
        const previousFullResponse = 'Based on my analysis...\n```json\n[{"id":"task-1"}]\n```';

        const feedback = formatFeedbackForRetry(judgement, undefined, previousFullResponse);

        assert(feedback.includes('Previous Response'));
        assert(feedback.includes('Based on my analysis'));
      });

      it('should fallback to JSON output if full response not provided', () => {
        const judgement: TaskQualityJudgement = {
          isAcceptable: false,
          issues: ['Issue'],
          suggestions: [],
        };
        const previousOutput = '[{"id":"task-1"}]';

        const feedback = formatFeedbackForRetry(judgement, previousOutput, undefined);

        assert(feedback.includes('Previous Output'));
        assert(feedback.includes('task-1'));
      });
    });

    describe('formatFeedbackForLog', () => {
      it('should abbreviate previous response section', () => {
        const feedbackWithResponse = `Issues:
1. Problem

Previous Response (for reference and modification):
\`\`\`
Long response text...
\`\`\``;

        const abbreviated = formatFeedbackForLog(feedbackWithResponse);

        assert(abbreviated.includes('Issues'));
        assert(abbreviated.includes('<< Previous Response Omitted'));
        assert(!abbreviated.includes('Long response text'));
      });

      it('should handle feedback without previous response', () => {
        const feedbackWithoutResponse = `Issues:
1. Problem
Suggestions:
1. Fix it`;

        const abbreviated = formatFeedbackForLog(feedbackWithoutResponse);

        assert.strictEqual(abbreviated, feedbackWithoutResponse);
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

  describe('Final Completion Judgement', () => {
    describe('buildFinalCompletionPrompt', () => {
      it('should include user instruction and task lists', () => {
        const userInstruction = 'Build a TODO app';
        const completedTasks = ['Implement user authentication', 'Create database schema'];
        const failedTasks = ['Add email notifications'];

        const prompt = buildFinalCompletionPrompt(userInstruction, completedTasks, failedTasks);

        assert(prompt.includes(userInstruction));
        assert(prompt.includes('COMPLETED TASKS'));
        assert(prompt.includes('FAILED TASKS'));
        assert(prompt.includes('Implement user authentication'));
        assert(prompt.includes('Add email notifications'));
      });

      it('should handle empty task lists', () => {
        const userInstruction = 'Build a TODO app';
        const completedTasks: string[] = [];
        const failedTasks: string[] = [];

        const prompt = buildFinalCompletionPrompt(userInstruction, completedTasks, failedTasks);

        assert(prompt.includes('(No tasks completed)'));
        assert(prompt.includes('(No tasks failed)'));
      });

      it('should include evaluation criteria', () => {
        const prompt = buildFinalCompletionPrompt('test', [], []);

        assert(prompt.includes('isComplete'));
        assert(prompt.includes('missingAspects'));
        assert(prompt.includes('additionalTaskSuggestions'));
        assert(prompt.includes('completionScore'));
      });
    });

    describe('parseFinalCompletionJudgement', () => {
      it('should parse valid complete judgement', () => {
        const output = JSON.stringify({
          isComplete: true,
          missingAspects: [],
          additionalTaskSuggestions: [],
          completionScore: 100,
        });

        const result = parseFinalCompletionJudgement(output);

        assert.strictEqual(result.isComplete, true);
        assert.deepStrictEqual(result.missingAspects, []);
        assert.deepStrictEqual(result.additionalTaskSuggestions, []);
        assert.strictEqual(result.completionScore, 100);
      });

      it('should parse valid incomplete judgement', () => {
        const output = JSON.stringify({
          isComplete: false,
          missingAspects: ['Email notifications not implemented'],
          additionalTaskSuggestions: ['Implement email notification system'],
          completionScore: 75,
        });

        const result = parseFinalCompletionJudgement(output);

        assert.strictEqual(result.isComplete, false);
        assert.strictEqual(result.missingAspects.length, 1);
        assert.strictEqual(result.additionalTaskSuggestions.length, 1);
        assert.strictEqual(result.completionScore, 75);
      });

      it('should parse judgement in markdown code block', () => {
        const output = `Here is the evaluation:
\`\`\`json
{
  "isComplete": false,
  "missingAspects": ["Documentation missing"],
  "additionalTaskSuggestions": ["Add API documentation"],
  "completionScore": 80
}
\`\`\``;

        const result = parseFinalCompletionJudgement(output);

        assert.strictEqual(result.isComplete, false);
        assert.strictEqual(result.missingAspects[0], 'Documentation missing');
      });

      it('should return default (complete) on parse error', () => {
        const output = 'This is not valid JSON';

        const result = parseFinalCompletionJudgement(output);

        assert.strictEqual(result.isComplete, true);
        assert.deepStrictEqual(result.missingAspects, []);
        assert.deepStrictEqual(result.additionalTaskSuggestions, []);
      });

      it('should return default (complete) on validation error', () => {
        const output = JSON.stringify({
          isComplete: 'not a boolean',
          missingAspects: 'not an array',
        });

        const result = parseFinalCompletionJudgement(output);

        assert.strictEqual(result.isComplete, true);
      });

      it('should handle missing optional completionScore', () => {
        const output = JSON.stringify({
          isComplete: true,
          missingAspects: [],
          additionalTaskSuggestions: [],
        });

        const result = parseFinalCompletionJudgement(output);

        assert.strictEqual(result.isComplete, true);
        assert.strictEqual(result.completionScore, undefined);
      });
    });
  });

  describe('Dependency Validation', () => {
    describe('detectCircularDependencies', () => {
      it('should detect simple circular dependency', () => {
        const tasks: TaskBreakdown[] = [
          {
            id: 'task-1',
            description: 'Task 1',
            branch: 'feature/1',
            scopePaths: ['src/'],
            acceptance: 'Done',
            type: TaskTypeEnum.IMPLEMENTATION,
            estimatedDuration: 1,
            context: 'Context',
            dependencies: ['task-2'],
          },
          {
            id: 'task-2',
            description: 'Task 2',
            branch: 'feature/2',
            scopePaths: ['src/'],
            acceptance: 'Done',
            type: TaskTypeEnum.IMPLEMENTATION,
            estimatedDuration: 1,
            context: 'Context',
            dependencies: ['task-1'],
          },
        ];

        const cycles = detectCircularDependencies(tasks);
        assert.strictEqual(cycles.length, 1);
        assert(cycles[0].includes('task-1'));
        assert(cycles[0].includes('task-2'));
      });

      it('should detect three-way circular dependency', () => {
        const tasks: TaskBreakdown[] = [
          {
            id: 'task-1',
            description: 'Task 1',
            branch: 'feature/1',
            scopePaths: ['src/'],
            acceptance: 'Done',
            type: TaskTypeEnum.IMPLEMENTATION,
            estimatedDuration: 1,
            context: 'Context',
            dependencies: ['task-2'],
          },
          {
            id: 'task-2',
            description: 'Task 2',
            branch: 'feature/2',
            scopePaths: ['src/'],
            acceptance: 'Done',
            type: TaskTypeEnum.IMPLEMENTATION,
            estimatedDuration: 1,
            context: 'Context',
            dependencies: ['task-3'],
          },
          {
            id: 'task-3',
            description: 'Task 3',
            branch: 'feature/3',
            scopePaths: ['src/'],
            acceptance: 'Done',
            type: TaskTypeEnum.IMPLEMENTATION,
            estimatedDuration: 1,
            context: 'Context',
            dependencies: ['task-1'],
          },
        ];

        const cycles = detectCircularDependencies(tasks);
        assert.strictEqual(cycles.length, 1);
        assert(cycles[0].includes('task-1'));
        assert(cycles[0].includes('task-2'));
        assert(cycles[0].includes('task-3'));
      });

      it('should not detect cycles in valid dependencies', () => {
        const tasks: TaskBreakdown[] = [
          {
            id: 'task-1',
            description: 'Task 1',
            branch: 'feature/1',
            scopePaths: ['src/'],
            acceptance: 'Done',
            type: TaskTypeEnum.IMPLEMENTATION,
            estimatedDuration: 1,
            context: 'Context',
            dependencies: [],
          },
          {
            id: 'task-2',
            description: 'Task 2',
            branch: 'feature/2',
            scopePaths: ['src/'],
            acceptance: 'Done',
            type: TaskTypeEnum.IMPLEMENTATION,
            estimatedDuration: 1,
            context: 'Context',
            dependencies: ['task-1'],
          },
          {
            id: 'task-3',
            description: 'Task 3',
            branch: 'feature/3',
            scopePaths: ['src/'],
            acceptance: 'Done',
            type: TaskTypeEnum.IMPLEMENTATION,
            estimatedDuration: 1,
            context: 'Context',
            dependencies: ['task-1', 'task-2'],
          },
        ];

        const cycles = detectCircularDependencies(tasks);
        assert.strictEqual(cycles.length, 0);
      });
    });

    describe('validateTaskDependencies', () => {
      it('should detect non-existent dependency', () => {
        const tasks: TaskBreakdown[] = [
          {
            id: 'task-1',
            description: 'Task 1',
            branch: 'feature/1',
            scopePaths: ['src/'],
            acceptance: 'Done',
            type: TaskTypeEnum.IMPLEMENTATION,
            estimatedDuration: 1,
            context: 'Context',
            dependencies: ['task-999'],
          },
        ];

        const errors = validateTaskDependencies(tasks);
        assert.strictEqual(errors.length, 1);
        assert(errors[0].includes('non-existent task'));
        assert(errors[0].includes('task-999'));
      });

      it('should detect both circular and non-existent dependencies', () => {
        const tasks: TaskBreakdown[] = [
          {
            id: 'task-1',
            description: 'Task 1',
            branch: 'feature/1',
            scopePaths: ['src/'],
            acceptance: 'Done',
            type: TaskTypeEnum.IMPLEMENTATION,
            estimatedDuration: 1,
            context: 'Context',
            dependencies: ['task-2', 'task-999'],
          },
          {
            id: 'task-2',
            description: 'Task 2',
            branch: 'feature/2',
            scopePaths: ['src/'],
            acceptance: 'Done',
            type: TaskTypeEnum.IMPLEMENTATION,
            estimatedDuration: 1,
            context: 'Context',
            dependencies: ['task-1'],
          },
        ];

        const errors = validateTaskDependencies(tasks);
        assert.strictEqual(errors.length, 2);
        assert(errors.some((e) => e.includes('Circular dependencies')));
        assert(errors.some((e) => e.includes('non-existent task')));
      });

      it('should return empty array for valid dependencies', () => {
        const tasks: TaskBreakdown[] = [
          {
            id: 'task-1',
            description: 'Task 1',
            branch: 'feature/1',
            scopePaths: ['src/'],
            acceptance: 'Done',
            type: TaskTypeEnum.IMPLEMENTATION,
            estimatedDuration: 1,
            context: 'Context',
            dependencies: [],
          },
          {
            id: 'task-2',
            description: 'Task 2',
            branch: 'feature/2',
            scopePaths: ['src/'],
            acceptance: 'Done',
            type: TaskTypeEnum.IMPLEMENTATION,
            estimatedDuration: 1,
            context: 'Context',
            dependencies: ['task-1'],
          },
        ];

        const errors = validateTaskDependencies(tasks);
        assert.strictEqual(errors.length, 0);
      });
    });
  });
});
