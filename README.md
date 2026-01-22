# Agent Orchestrator

Multi-agent collaborative development tool with Planner/Worker/Judge architecture.

## Features

- **Multi-agent orchestration**: Planner designs tasks, Workers implement, Judge validates
- **Worktree-based parallelization**: Parallel task execution using Git worktrees
- **CAS concurrency control**: Optimistic concurrency using Compare-And-Swap
- **SDK integration**: Claude Agent SDK and OpenAI Codex SDK support
- **GitHub integration**: Automatic Pull Request creation

## Requirements

- Node.js >= 24.13.0
- pnpm >= 9.15.4
- Git with worktree support

## Quick Start (User Setup)

### Installation

```bash
pnpm install
pnpm compile
```

### Basic Usage

```bash
# Initialize project
node dist/cli/index.js init --app-repo . --agent-coord ../agent-coord

# Run tasks
node dist/cli/index.js run "your instruction here"

# Check status
node dist/cli/index.js status

# Stop execution
node dist/cli/index.js stop
```

Optional: Set up a shell alias for convenience:

```bash
alias agent='node /path/to/agent-orchestorator/dist/cli/index.js'
```

## Development Setup

### Build & Test

```bash
# Type check (src/ and tests/)
pnpm typecheck

# Build TypeScript (src/ only, output to dist/)
pnpm build

# Complete build flow (version generation, build, schema generation)
pnpm compile

# Run tests
pnpm test              # Unit tests
pnpm test:e2e          # E2E tests

# Lint
pnpm lint

# Format
pnpm format
```

### Project Structure

```
src/
  core/          # Core logic (Task Store, Runner, Orchestrator)
  cli/           # CLI entry points
  adapters/      # External integrations (VCS, GitHub)
  types/         # Type definitions
tests/           # Test code
```

## Documentation

- [Architecture](docs/architecture.md)
- [Dogfooding Setup Guide](docs/SETUP.md)
- [GitHub Integration](docs/github-integration.md)

## License

MIT
