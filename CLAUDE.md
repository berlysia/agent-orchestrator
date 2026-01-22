# CLAUDE.md

## Commands

**CRITICAL: Use `pnpm typecheck` (not `tsc`)**. Direct tsc execution is blocked.

| Task | Command |
|------|---------|
| Type check | `pnpm typecheck` |
| Build | `pnpm build` |
| Test | `pnpm test` / `pnpm test:e2e` / `pnpm test:all` |
| Single test | `node --test tests/unit/<file>.test.ts` |
| Lint | `pnpm lint` |
| Format | `pnpm format` |
| Dev mode | `pnpm dev` |

**Type check workflow**: Make changes → `pnpm typecheck` → Focus on FIRST error (`2>&1 | head -50`)

## Architecture

Agent Orchestrator: Multi-agent tool with Planner/Worker/Judge architecture.

**Key Principles**:
- **Layers**: CLI → Adapters → Core → Types (unidirectional, never reverse)
- **Error handling**: `Result<T, E>` from `option-t`, never throw
- **External I/O**: Effects pattern (GitEffects, RunnerEffects, etc.)
- **ID safety**: Branded Types (`TaskId`, `WorkerId`, `RunId`)
- **Concurrency**: CAS with mkdir-based locks in `.locks/<taskId>/`

See [docs/architecture.md](docs/architecture.md) for task states, storage structure, and implementation details.

## Adding Code

| Area | Steps |
|------|-------|
| Task Store | Define in `interface.ts` → Implement in `file-store.ts` → Test in `tests/unit/` |
| VCS | Define in `GitEffects` → Implement in `*-git-effects.ts` |
| CLI Command | Add in `commands/` → Register in `index.ts` → Add E2E test |
| Orchestrator | Modify `src/core/orchestrator/*.ts` |

## Testing

- Framework: `node:test` + `node:assert` (not Jest/Vitest)
- Unit tests: `tests/unit/`
- E2E tests: `tests/e2e/`
- Fixtures: `tests/fixtures/hello-world/`

## References

- [Architecture](docs/architecture.md)
- [Setup Guide](docs/SETUP.md)
- [Config Schema](.agent/config-schema.json)
- [ADR 001: CAS Implementation](docs/decisions/001-cas-implementation-approach.md)
