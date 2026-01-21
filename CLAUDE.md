# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### TypeScript Type Checking

**CRITICAL: This project uses `tsgo` instead of `tsc` for type checking.**

- ❌ **DO NOT use `tsc`, `npx tsc`, or `pnpm exec tsc`** - The project blocks direct tsc usage
- ✅ **Use `pnpm typecheck`** - Type check entire project (src/ and tests/)
- ✅ **Use `pnpm build`** - Build src/ directory only (also performs type checking)

**Type Checking Individual Files:**

DO NOT run type check commands on individual files. TypeScript projects have complex cross-file dependencies, and checking individual files produces misleading errors.

**Correct workflow:**
1. Make your changes
2. Run `pnpm typecheck` to check the entire project
3. Review errors - focus on FIRST error (use `2>&1 | head -50`)

### Build & Test

```bash
# Type check entire project
pnpm typecheck

# Build TypeScript (src/ only, output to dist/)
pnpm build

# Complete build flow (version generation, build, schema generation)
pnpm compile

# Run unit tests
pnpm test

# Run E2E tests
pnpm test:e2e

# Run all tests
pnpm test:all
```

### Code Quality

```bash
# Lint with oxlint
pnpm lint

# Format with prettier
pnpm format

# Check formatting
pnpm format:check
```

### CLI Development

```bash
# Run with auto-reload during development
pnpm dev

# Test CLI directly
node dist/cli/index.js <command>
```

### Running Single Tests

```bash
# Run specific test file
node --test tests/unit/file-store.test.ts
node --test tests/e2e/cli-basic.test.ts
```

## Architecture Overview

Agent Orchestrator is a multi-agent collaborative development tool with Planner/Worker/Judge architecture.

### Core Design Principles

**Functional Programming First**

- Classes only for Errors
- Pure functions for business logic
- Factory functions for instance creation
- Effects interfaces for external I/O (VCS, Runner, PlannerSession)

**Type Safety with Runtime Validation**

- Zod schemas for runtime validation
- Branded Types (`TaskId`, `WorkerId`, `RunId`, etc.) prevent ID confusion
- Result type (`option-t`) for explicit error handling - NO throwing errors

**Separation of Concerns**

- **Core** (`src/core/`): Business logic (Task Store, Runner, Orchestrator)
- **Adapters** (`src/adapters/`): External integrations (VCS with Git/Worktree)
- **CLI** (`src/cli/`): User interface layer
- **Types** (`src/types/`): Shared type definitions

### Key Architectural Concepts

**1. Worktree-based Parallelization**

- 1 Task = 1 Branch = 1 Worktree
- Workers run in parallel (default: 3) in isolated directories
- Task state is shared (in agent-coord repo), work directories are isolated

**2. CAS Concurrency Control**

- Optimistic locking with Compare-And-Swap (version-based)
- Prevents multiple Workers from claiming the same task
- Implementation: mkdir-based locks in `.locks/<taskId>/`

**3. Planner/Worker/Judge Cycle**

- **Planner**: Decomposes instructions into tasks (Claude/Codex agents)
- **Worker**: Implements tasks in isolated worktrees (Claude/Codex agents)
- **Judge**: Validates completion with 3-level decision making
  - Success → DONE
  - Continuation needed → NEEDS_CONTINUATION (Worker retries)
  - Replanning needed → REPLACED_BY_REPLAN (Planner re-decomposes)
  - Complete failure → BLOCKED (manual intervention required)
- **Integration**: Determines if tasks require integration (PR/command output)

**4. Task State Machine**

```
READY → RUNNING → Judge → success=true → DONE
   ↓       ↓                    ↓
   ↓    CANCELLED        shouldContinue=true
   ↓                             ↓
   ↓                    NEEDS_CONTINUATION → (loops back to RUNNING)
   ↓                             ↓
BLOCKED ← !shouldContinue    shouldReplan=true
           && !shouldReplan       ↓
                           REPLACED_BY_REPLAN → New tasks created (READY)
```

States:

- **READY**: Not yet executed, waiting for worker assignment
- **RUNNING**: Worker is executing
- **NEEDS_CONTINUATION**: Executed but incomplete (Judge determined continuation needed)
- **DONE**: Completed
- **BLOCKED**: Cannot execute due to errors or dependencies, requires manual intervention
- **CANCELLED**: User interrupted
- **REPLACED_BY_REPLAN**: Task was too large/complex, replaced by new sub-tasks from Planner

**5. Effects Pattern for External I/O**

All external I/O (Git, Runner, PlannerSession) is abstracted through Effects interfaces:

```typescript
// Interface definition
interface GitEffects {
  getCurrentBranch(repoPath: RepoPath): Promise<string>;
  // ...
}

// Implementation injection
async function someOperation(effects: GitEffects) {
  const branch = await effects.getCurrentBranch(repoPath);
  // ...
}
```

This enables:

- Testability (mock implementations)
- Separation of pure logic from I/O
- Explicit dependencies

**6. Result Type Error Handling**

NO throwing errors - use Result type from `option-t`:

```typescript
import type { Result } from 'option-t/plain_result';
import { createOk, createErr } from 'option-t/plain_result/result';

function operation(): Result<Data, Error> {
  if (success) {
    return createOk(data);
  }
  return createErr(new SomeError('reason'));
}

// Usage
const result = operation();
if (!result.ok) {
  console.error(result.err.message);
  return;
}
const data = result.val;
```

**7. Branded Types**

Prevent ID confusion with branded types:

```typescript
type TaskId = Brand<'TaskId', string>;
type WorkerId = Brand<'WorkerId', string>;

// Compile error - TaskId and WorkerId are incompatible
const taskId: TaskId = workerId; // ❌
```

### Directory Layout

```
src/
  core/
    task-store/         # Task state CRUD + CAS operations
    runner/             # Agent execution (Claude/Codex SDK)
    orchestrator/       # Planner/Worker/Judge orchestration
    config/             # Config models

  adapters/
    vcs/                # Git/Worktree operations (simple-git + child_process)

  cli/
    commands/           # CLI commands (init, run, status, stop, resume, continue, info)
    utils/              # CLI utilities

  types/                # Shared type definitions

tests/
  unit/                 # Unit tests (node:test)
  e2e/                  # E2E tests (CLI integration)
  fixtures/             # Test fixtures
```

### Storage Structure (agent-coord repo)

```
agent-coord/
  tasks/<taskId>.json       # Task state
  runs/<runId>.json         # Worker execution logs/metadata
  checks/<checkId>.json     # CI/lint results (future)
  .locks/<taskId>/          # CAS lock directories
```

### Configuration (.agent/config.json)

```json
{
  "$schema": "./config-schema.json",
  "appRepoPath": ".",
  "agentCoordPath": "../agent-orchestorator-coord",
  "maxWorkers": 3,
  "agents": {
    "planner": { "type": "claude", "model": "claude-opus-4-5" },
    "worker": { "type": "claude", "model": "claude-sonnet-4-5" },
    "judge": { "type": "claude", "model": "claude-haiku-4-5" }
  },
  "checks": { "enabled": true, "failureMode": "block" },
  "integration": { "method": "auto" },
  "planning": {
    "maxQualityRetries": 5,
    "qualityThreshold": 60,
    "strictContextValidation": false
  },
  "replanning": {
    "enabled": true,
    "maxIterations": 3,
    "timeoutSeconds": 300
  }
}
```

## Implementation Notes

### When Adding New Task Store Operations

1. Define pure function in `src/core/task-store/interface.ts`
2. Return `Result<T, TaskStoreError>` - never throw
3. Implement in `src/core/task-store/file-store.ts`
4. Add unit tests in `tests/unit/file-store.test.ts`

### When Adding New VCS Operations

1. Define in `GitEffects` interface (`src/adapters/vcs/git-effects.ts`)
2. Implement in `simple-git-effects.ts` or `spawn-git-effects.ts`
3. Use Effects pattern - inject dependencies

### When Adding New CLI Commands

1. Create command file in `src/cli/commands/`
2. Register in `src/cli/index.ts`
3. Load config with `loadConfig()` from `src/cli/utils/load-config.ts`
4. Add E2E test in `tests/e2e/`

### When Modifying Orchestrator Logic

- **Planner operations**: `src/core/orchestrator/planner-operations.ts`
- **Worker operations**: `src/core/orchestrator/worker-operations.ts`
- **Judge operations**: `src/core/orchestrator/judge-operations.ts`
- **Replanning operations**: `src/core/orchestrator/replanning-operations.ts` (Judge-triggered task re-decomposition)
- **Scheduler operations**: `src/core/orchestrator/scheduler-operations.ts`
- **Integration operations**: `src/core/orchestrator/integration-operations.ts`
- **Main flow**: `src/core/orchestrator/orchestrate.ts`

### Testing Strategy

- **Unit tests**: Pure functions, TaskStore CRUD/CAS operations
- **E2E tests**: CLI commands with temporary Git repos
- **Test framework**: `node:test` + `node:assert` (no Vitest/Jest for CLI code)
- **Fixtures**: `tests/fixtures/hello-world/` (sample TypeScript project)

## Known Limitations & Future Work

### Current State

✅ Planner agent integration (Claude/Codex)
✅ Worker execution with automatic log saving to `runs/`
✅ CLI output shows log file paths for monitoring
✅ CAS-based task claiming
✅ Worktree-based parallelization
✅ Judge agent integration with 3-level decision making
✅ Automatic task replanning for failed tasks (Planner re-decomposition)
✅ Infinite loop prevention (max replanning iterations: 3)

### Planned Enhancements

- Enhanced Judge prompts for better accuracy
- GitHub Integration (PR creation, status updates) - see `docs/plans/github-integration-*.md`
- Improved error recovery and retry logic
- Task dependency graph visualization

## Reference Documents

- [Architecture Details](docs/architecture.md)
- [Setup Guide for Dogfooding](docs/SETUP.md)
- [Initial Development Plan](docs/plans/initial-plan.md)
- [Phase 2 Improvement Plan](docs/plans/improvement-plan.md)
- [ADR 001: CAS Implementation](docs/decisions/001-cas-implementation-approach.md)
