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
# Build
pnpm build

# Lint
pnpm lint

# Format
pnpm format
```

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
