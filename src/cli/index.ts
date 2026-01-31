#!/usr/bin/env node

import { Command } from 'commander';
import { createInitCommand } from './commands/init.ts';
import { createRunCommand } from './commands/run.ts';
import { createPlanCommand } from './commands/plan.ts';
import { createStatusCommand } from './commands/status.ts';
import { createStopCommand } from './commands/stop.ts';
import { createResumeCommand } from './commands/resume.ts';
import { createContinueCommand } from './commands/continue.ts';
import { createInfoCommand } from './commands/info.ts';
import { createIntegrateCommand } from './commands/integrate.ts';
import { createFinalizeCommand } from './commands/finalize.ts';
import { createReportCommand } from './commands/report.ts';
import { createConfigCommand } from './commands/config.ts';
import { createLeadCommand } from './commands/lead.ts';
import { createCleanupBranchesCommand } from './commands/cleanup-branches.ts';
import { createExploreCommand } from './commands/explore.ts';
import { getVersion } from './utils/get-version.ts';

const program = new Command();

program
  .name('agent')
  .description('Multi-agent collaborative development orchestrator')
  .version(getVersion());

// Register subcommands
program.addCommand(createInitCommand());
program.addCommand(createRunCommand());
program.addCommand(createPlanCommand());
program.addCommand(createStatusCommand());
program.addCommand(createStopCommand());
program.addCommand(createResumeCommand());
program.addCommand(createContinueCommand());
program.addCommand(createInfoCommand());
program.addCommand(createIntegrateCommand());
program.addCommand(createFinalizeCommand());
program.addCommand(createReportCommand());
program.addCommand(createConfigCommand());
program.addCommand(createLeadCommand());
program.addCommand(createCleanupBranchesCommand());
program.addCommand(createExploreCommand());

program.parse(process.argv);
