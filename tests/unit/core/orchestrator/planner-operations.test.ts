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
  makeRefinementDecision,
  type TaskQualityJudgement,
} from '../../../../src/core/orchestrator/planner-operations.ts';
import type { RefinementConfig } from '../../../../src/types/planner-session.ts';
import { TaskTypeEnum, type TaskBreakdown } from '../../../../src/types/task-breakdown.ts';

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

      assert(prompt.includes('hours'));
      assert(prompt.includes('CRITICAL'));
      assert(prompt.includes('ALL fields are REQUIRED'));
    });

    it('should respect custom maxTaskDuration', () => {
      const prompt = buildPlanningPrompt('test', 2);

      assert(prompt.includes('between 0.5 and 2'));
      assert(prompt.includes('MUST NOT exceed 2 hours'));
    });

    it('should respect custom maxTasks', () => {
      const prompt = buildPlanningPrompt('test', 4, 10);

      assert(prompt.includes('Create 1-10 tasks'));
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
      assert(result[0]);
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
      assert(result[0]);
      assert.strictEqual(result[0].description, 'Add login form');
      assert.strictEqual(result[0].type, 'implementation');
    });

    it('should parse summary field when present', () => {
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
          summary: 'JWT認証の実装',
        },
      ]);

      const result = parseAgentOutput(output);

      assert.strictEqual(result.length, 1);
      assert(result[0]);
      assert.strictEqual(result[0].summary, 'JWT認証の実装');
    });

    it('should handle missing summary field', () => {
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
      assert(result[0]);
      assert.strictEqual(result[0].summary, undefined);
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
      assert(result[0]);
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
      assert(result[0]);
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
      assert(result[0]);
      assert(result[1]);
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
      assert(result.errors[0]);
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
        assert(result[0]);
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
      assert(result.errors[0]);
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

        const prompt = buildTaskQualityPrompt(userInstruction, tasks, false);

        assert(prompt.includes(userInstruction));
        assert(prompt.includes('Implement task list'));
        assert(prompt.includes('quality evaluator'));
      });

      it('should include previous feedback when provided', () => {
        const userInstruction = 'Build a TODO app';
        const tasks: TaskBreakdown[] = [
          {
            id: 'task-1',
            description: 'Test task',
            branch: 'feature/test',
            scopePaths: ['src/'],
            acceptance: 'Test',
            type: 'implementation',
            estimatedDuration: 1.0,
            context: 'Test context',
            dependencies: [],
          },
        ];
        const feedback = 'Acceptance criteria are too vague';

        const prompt = buildTaskQualityPrompt(userInstruction, tasks, false, 4, feedback);

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
        assert(cycles[0]);
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
        assert(cycles[0]);
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
        assert(errors[0]);
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

  describe('Refinement Decision', () => {
    const defaultConfig: RefinementConfig = {
      maxRefinementAttempts: 2,
      refineSuggestionsOnSuccess: false,
      maxSuggestionReplans: 1,
      enableIndividualFallback: true,
      deltaThreshold: 5,
      deltaThresholdPercent: 5,
      taskCountChangeThreshold: 0.3,
      taskCountChangeMinAbsolute: 2,
    };

    describe('makeRefinementDecision', () => {
      it('should accept when quality is OK and no suggestions', () => {
        const result = makeRefinementDecision({
          isAcceptable: true,
          score: 78,
          previousScore: undefined,
          issues: [],
          suggestions: [],
          attemptCount: 0,
          suggestionReplanCount: 0,
          config: defaultConfig,
        });

        assert.strictEqual(result.decision, 'accept');
        assert.strictEqual(result.reason, '品質OK');
      });

      it('should replan when quality is not acceptable', () => {
        const result = makeRefinementDecision({
          isAcceptable: false,
          score: 45,
          previousScore: undefined,
          issues: ['Task context is insufficient'],
          suggestions: ['Add more detail to context'],
          attemptCount: 0,
          suggestionReplanCount: 0,
          config: defaultConfig,
        });

        assert.strictEqual(result.decision, 'replan');
        assert.strictEqual(result.reason, '品質未達');
        assert(result.feedback);
        assert.strictEqual(result.feedback.issues.length, 1);
      });

      it('should reject when max attempts reached and quality is not acceptable', () => {
        const result = makeRefinementDecision({
          isAcceptable: false,
          score: 55,
          previousScore: 50,
          issues: ['Still insufficient'],
          suggestions: [],
          attemptCount: 2, // maxRefinementAttempts = 2
          suggestionReplanCount: 0,
          config: defaultConfig,
        });

        assert.strictEqual(result.decision, 'reject');
        assert.strictEqual(result.reason, '最大試行回数到達');
      });

      it('should accept when max attempts reached and quality is acceptable', () => {
        const result = makeRefinementDecision({
          isAcceptable: true,
          score: 65,
          previousScore: 60,
          issues: [],
          suggestions: ['Minor improvements possible'],
          attemptCount: 2,
          suggestionReplanCount: 0,
          config: defaultConfig,
        });

        assert.strictEqual(result.decision, 'accept');
        assert.strictEqual(result.reason, '最大試行回数到達');
      });

      it('should continue replan when stagnated and quality is not acceptable (改善版)', () => {
        // このテストは以前の問題を改善した挙動を確認:
        // 1回目: 78点で品質OK、suggestionsありでreplan
        // 2回目: 75点に下がり(3点下落)、停滞判定、品質NG
        // → 以前はrejectだったが、試行回数が残っているのでreplan継続

        const result = makeRefinementDecision({
          isAcceptable: false, // 2回目で閾値を下回った
          score: 75,
          previousScore: 78,
          issues: ['Some issues remain'],
          suggestions: [],
          attemptCount: 1,
          suggestionReplanCount: 0,
          config: defaultConfig,
        });

        // 改善が-3点 < deltaThreshold(5)なので停滞判定
        // isAcceptable=falseだが、試行回数が残っているのでreplan継続
        assert.strictEqual(result.decision, 'replan');
        assert.strictEqual(result.reason, '改善停滞（継続）');
        assert.strictEqual(result.currentScore, 75);
        assert.strictEqual(result.previousScore, 78);
        assert(result.feedback); // feedbackが設定される
      });

      it('should reject when max attempts reached even if stagnated', () => {
        // 最大試行回数到達時は停滞判定より先に処理される
        const result = makeRefinementDecision({
          isAcceptable: false,
          score: 75,
          previousScore: 78,
          issues: ['Still not acceptable'],
          suggestions: [],
          attemptCount: 2, // maxRefinementAttempts = 2
          suggestionReplanCount: 0,
          config: defaultConfig,
        });

        // 最大試行回数到達 + 品質NG → reject
        assert.strictEqual(result.decision, 'reject');
        assert.strictEqual(result.reason, '最大試行回数到達');
      });

      it('should accept when stagnated but quality is acceptable', () => {
        // 停滞しても品質OKならaccept
        const result = makeRefinementDecision({
          isAcceptable: true,
          score: 80,
          previousScore: 78,
          issues: [],
          suggestions: [],
          attemptCount: 1,
          suggestionReplanCount: 0,
          config: defaultConfig,
        });

        // 改善が2点 < deltaThreshold(5)なので停滞判定
        // しかしisAcceptable=trueなのでaccept
        assert.strictEqual(result.decision, 'accept');
        assert.strictEqual(result.reason, '改善停滞');
      });

      it('should reject when score is undefined and quality is not acceptable', () => {
        const result = makeRefinementDecision({
          isAcceptable: false,
          score: undefined,
          previousScore: 78,
          issues: ['Parse error in quality check'],
          suggestions: [],
          attemptCount: 1,
          suggestionReplanCount: 0,
          config: defaultConfig,
        });

        assert.strictEqual(result.decision, 'reject');
        assert.strictEqual(result.reason, 'スコア取得失敗');
      });

      it('should accept when score is undefined but quality is acceptable', () => {
        const result = makeRefinementDecision({
          isAcceptable: true,
          score: undefined,
          previousScore: 78,
          issues: [],
          suggestions: [],
          attemptCount: 1,
          suggestionReplanCount: 0,
          config: defaultConfig,
        });

        assert.strictEqual(result.decision, 'accept');
        assert.strictEqual(result.reason, 'スコア取得失敗');
      });

      it('should replan with suggestions when enabled and quality is OK', () => {
        const configWithSuggestions: RefinementConfig = {
          ...defaultConfig,
          refineSuggestionsOnSuccess: true,
          maxSuggestionReplans: 2,
        };

        const result = makeRefinementDecision({
          isAcceptable: true,
          score: 78,
          previousScore: undefined,
          issues: [],
          suggestions: ['Add edge case handling'],
          attemptCount: 0,
          suggestionReplanCount: 0,
          config: configWithSuggestions,
        });

        assert.strictEqual(result.decision, 'replan');
        assert.strictEqual(result.reason, 'suggestions適用');
      });

      it('should accept when suggestions limit reached', () => {
        const configWithSuggestions: RefinementConfig = {
          ...defaultConfig,
          refineSuggestionsOnSuccess: true,
          maxSuggestionReplans: 1,
        };

        const result = makeRefinementDecision({
          isAcceptable: true,
          score: 90,
          previousScore: 78, // 12点改善 >= deltaThreshold(5) で停滞しない
          issues: [],
          suggestions: ['More suggestions'],
          attemptCount: 1,
          suggestionReplanCount: 1, // 既に1回使用済み
          config: configWithSuggestions,
        });

        // suggestionsあるがmaxSuggestionReplans到達なのでaccept
        assert.strictEqual(result.decision, 'accept');
        assert.strictEqual(result.reason, '品質OK');
      });

      it('should detect stagnation with relative threshold (percent)', () => {
        // 相対閾値（5%）で停滞判定するケース
        // 前回90点 → 今回95点 = 5点改善 (絶対値は閾値以上)
        // しかし 5/90 = 5.5% なので相対閾値も超える
        // → 停滞しない

        const result = makeRefinementDecision({
          isAcceptable: true,
          score: 95,
          previousScore: 90,
          issues: [],
          suggestions: [],
          attemptCount: 1,
          suggestionReplanCount: 0,
          config: defaultConfig,
        });

        // 5点改善 >= deltaThreshold(5) かつ 5.5% >= deltaThresholdPercent(5)
        // なので停滞しない → 品質OKでaccept
        assert.strictEqual(result.decision, 'accept');
        assert.strictEqual(result.reason, '品質OK');
      });

      it('should detect stagnation when relative improvement is too small', () => {
        // 絶対値は閾値以上だが相対値が閾値未満のケース
        // 前回30点 → 今回35点 = 5点改善 (絶対値は閾値ちょうど)
        // しかし 5/30 = 16.7% なので相対閾値は超える
        // → 停滞しない

        // 逆パターン: 前回95点 → 今回99点 = 4点改善
        // 4/95 = 4.2% < 5% なので停滞
        const result = makeRefinementDecision({
          isAcceptable: true,
          score: 99,
          previousScore: 95,
          issues: [],
          suggestions: [],
          attemptCount: 1,
          suggestionReplanCount: 0,
          config: defaultConfig,
        });

        // 4点改善 < deltaThreshold(5) なので停滞判定（OR条件）
        assert.strictEqual(result.decision, 'accept');
        assert.strictEqual(result.reason, '改善停滞');
      });

      it('should continue replan when improvement is sufficient', () => {
        const result = makeRefinementDecision({
          isAcceptable: false,
          score: 65,
          previousScore: 50,
          issues: ['Still needs work'],
          suggestions: [],
          attemptCount: 1,
          suggestionReplanCount: 0,
          config: defaultConfig,
        });

        // 15点改善 >= deltaThreshold(5) かつ 30% >= deltaThresholdPercent(5)
        // なので停滞しない → 品質未達でreplan
        assert.strictEqual(result.decision, 'replan');
        assert.strictEqual(result.reason, '品質未達');
      });
    });
  });
});
