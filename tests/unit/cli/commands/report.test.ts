import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createReportCommand } from '../../../../src/cli/commands/report.ts';

describe('report command', () => {
  describe('createReportCommand', () => {
    it('should create a command with correct name', () => {
      const command = createReportCommand();
      assert.strictEqual(command.name(), 'report');
    });

    it('should have correct description', () => {
      const command = createReportCommand();
      assert.strictEqual(
        command.description(),
        'Generate monitoring report',
      );
    });

    it('should have optional rootSessionId argument', () => {
      const command = createReportCommand();
      const args = command.registeredArguments;
      assert.strictEqual(args.length, 1);
      const arg = args[0];
      assert(arg, 'Expected argument to exist');
      assert.strictEqual(arg.name(), 'rootSessionId');
      assert.strictEqual(arg.required, false);
      assert.strictEqual(arg.description, 'Root session ID (default: most recent)');
    });

    it('should have --stdout option', () => {
      const command = createReportCommand();
      const stdoutOption = command.options.find((opt) => opt.long === '--stdout');
      assert(stdoutOption, 'Should have --stdout option');
      assert.strictEqual(stdoutOption.description, 'Output to stdout instead of file');
    });

    it('should have --config option', () => {
      const command = createReportCommand();
      const configOption = command.options.find((opt) => opt.long === '--config');
      assert(configOption, 'Should have --config option');
      assert.strictEqual(configOption.description, 'Path to configuration file');
    });
  });
});
