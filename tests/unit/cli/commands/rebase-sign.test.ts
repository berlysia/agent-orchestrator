import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRebaseSignCommand } from '../../../../src/cli/commands/rebase-sign.ts';

describe('rebase-sign command', () => {
  describe('createRebaseSignCommand', () => {
    it('should create a command with correct name', () => {
      const command = createRebaseSignCommand();
      assert.strictEqual(command.name(), 'rebase-sign');
    });

    it('should have correct description', () => {
      const command = createRebaseSignCommand();
      assert.strictEqual(
        command.description(),
        'Rebase a branch with GPG signing for all commits',
      );
    });

    it('should have --base option', () => {
      const command = createRebaseSignCommand();
      const baseOption = command.options.find((opt) => opt.long === '--base');
      assert(baseOption, 'Should have --base option');
      assert.strictEqual(baseOption.description, 'Base branch to rebase onto (default: auto-detect main/master)');
    });

    it('should have --branch option', () => {
      const command = createRebaseSignCommand();
      const branchOption = command.options.find((opt) => opt.long === '--branch');
      assert(branchOption, 'Should have --branch option');
      assert.strictEqual(branchOption.description, 'Branch to rebase (default: current branch)');
    });

    it('should have --dry-run option', () => {
      const command = createRebaseSignCommand();
      const dryRunOption = command.options.find((opt) => opt.long === '--dry-run');
      assert(dryRunOption, 'Should have --dry-run option');
      assert.strictEqual(dryRunOption.description, 'Show what would be done without executing');
    });
  });
});
