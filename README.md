# Agent Orchestrator

Multi-agent collaborative development tool with Planner/Worker/Judge architecture.

## Features

- **Multi-agent orchestration**: Planner designs tasks, Workers implement, Judge validates
- **Worktree-based parallelization**: Parallel task execution using Git worktrees
- **CAS concurrency control**: Optimistic concurrency using Compare-And-Swap
- **SDK integration**: Claude Agent SDK and OpenAI Codex SDK support

## Requirements

- Node.js >= 18.0.0
- pnpm >= 9.15.4
- Git with worktree support

## Installation

```bash
pnpm install
```

## Development

```bash
# Type check
pnpm build

# Run tests
node --test tests/unit/**/*.test.ts

# Lint
pnpm lint

# Format
pnpm format
```

## Implementation Status

### ✅ Completed (2026-01-18)

- **Epic 1: Project Foundation**
  - TypeScript development environment setup
  - Type definitions (Task, Run, Check, Config)
- **Epic 2: Task Store**
  - JSON file-based task storage
  - CRUD operations with CAS (Compare-And-Swap) concurrency control
  - mkdir-based locking mechanism
- **Epic 3: VCS Adapter**
  - Git basic operations wrapper (simple-git)
  - Worktree management (child_process)
- **Epic 4: Runner**
  - Process execution infrastructure (ProcessRunner, LogWriter)
  - Agent execution interfaces (ClaudeRunner, CodexRunner, Runner integration)
- **Epic 5: Orchestrator**
  - Task scheduler with concurrency control
  - Planner/Worker/Judge state machine
  - Full orchestration cycle (Planner→Worker→Judge)

### 🚧 In Progress

- Epic 6: CLI commands
- Epic 7: Integration tests and documentation

## Architecture

See [docs/architecture.md](docs/architecture.md) for detailed architecture documentation.

## Project Structure

```
src/
  core/          # Core logic (Task Store, Runner, Orchestrator)
  cli/           # CLI entry points
  adapters/      # External integrations (VCS, GitHub)
  types/         # Type definitions
tests/           # Test code
```

## License

MIT
