import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createFinalizeCommand } from '../../../../src/cli/commands/finalize.ts';

describe('finalize command', () => {
  describe('createFinalizeCommand', () => {
    it('should create a command with correct name', () => {
      const command = createFinalizeCommand();
      assert.strictEqual(command.name(), 'finalize');
    });

    it('should have correct description', () => {
      const command = createFinalizeCommand();
      assert.strictEqual(
        command.description(),
        'Finalize integration branch: rebase with GPG signing and merge into base',
      );
    });

    it('should have --base option', () => {
      const command = createFinalizeCommand();
      const baseOption = command.options.find((opt) => opt.long === '--base');
      assert(baseOption, 'Should have --base option');
      assert.strictEqual(baseOption.description, 'Base branch to rebase onto (default: auto-detect main/master)');
    });

    it('should have --branch option', () => {
      const command = createFinalizeCommand();
      const branchOption = command.options.find((opt) => opt.long === '--branch');
      assert(branchOption, 'Should have --branch option');
      assert.strictEqual(branchOption.description, 'Branch to finalize (default: current branch)');
    });

    it('should have --no-merge option', () => {
      const command = createFinalizeCommand();
      const noMergeOption = command.options.find((opt) => opt.long === '--no-merge');
      assert(noMergeOption, 'Should have --no-merge option');
      assert.strictEqual(noMergeOption.description, 'Skip merging into base branch after rebase');
    });

    it('should have --dry-run option', () => {
      const command = createFinalizeCommand();
      const dryRunOption = command.options.find((opt) => opt.long === '--dry-run');
      assert(dryRunOption, 'Should have --dry-run option');
      assert.strictEqual(dryRunOption.description, 'Show what would be done without executing');
    });
  });
});
