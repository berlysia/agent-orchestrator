#!/usr/bin/env node

import { Command } from 'commander';
import { createInitCommand } from './commands/init.ts';
import { createRunCommand } from './commands/run.ts';
import { createStatusCommand } from './commands/status.ts';
import { createStopCommand } from './commands/stop.ts';

const program = new Command();

program
  .name('agent')
  .description('Multi-agent collaborative development orchestrator')
  .version('0.1.0');

// Register subcommands
program.addCommand(createInitCommand());
program.addCommand(createRunCommand());
program.addCommand(createStatusCommand());
program.addCommand(createStopCommand());

program.parse(process.argv);
