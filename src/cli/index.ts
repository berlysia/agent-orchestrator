#!/usr/bin/env node

import { Command } from 'commander';
import { createInitCommand } from './commands/init.ts';
import { createRunCommand } from './commands/run.ts';
import { createStatusCommand } from './commands/status.ts';
import { createStopCommand } from './commands/stop.ts';
import { createResumeCommand } from './commands/resume.ts';
import { createContinueCommand } from './commands/continue.ts';
import { createInfoCommand } from './commands/info.ts';
import { createIntegrateCommand } from './commands/integrate.ts';
import { createFinalizeCommand } from './commands/finalize.ts';
import { createReportCommand } from './commands/report.ts';
import { getVersion } from './utils/get-version.ts';

const program = new Command();

program
  .name('agent')
  .description('Multi-agent collaborative development orchestrator')
  .version(getVersion());

// Register subcommands
program.addCommand(createInitCommand());
program.addCommand(createRunCommand());
program.addCommand(createStatusCommand());
program.addCommand(createStopCommand());
program.addCommand(createResumeCommand());
program.addCommand(createContinueCommand());
program.addCommand(createInfoCommand());
program.addCommand(createIntegrateCommand());
program.addCommand(createFinalizeCommand());
program.addCommand(createReportCommand());

program.parse(process.argv);
