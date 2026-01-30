# Complex Test Plan

このプランは L5-L6 レベルのテスト用に設計された、エスカレーションをトリガーする可能性のある複雑なタスク構成です。

## Task 1: Setup database schema

- **Branch**: feature/db-schema
- **Description**: Define database schema for user management
- **Scope**: src/db/schema.ts
- **Acceptance**:
  - File `src/db/schema.ts` exists
  - Defines `UserSchema` with id, name, email, createdAt fields
  - Exports schema type definitions

## Task 2: Implement repository

- **Branch**: feature/repository
- **Description**: Create user repository implementing CRUD operations
- **Scope**: src/db/repository.ts
- **Depends on**: Task 1
- **Acceptance**:
  - File `src/db/repository.ts` exists
  - Imports schema from `./schema`
  - Exports `UserRepository` class
  - Implements: `create`, `read`, `update`, `delete` methods
  - All methods use proper error handling

## Task 3: Add API endpoint (Ambiguous Requirements)

- **Branch**: feature/api
- **Description**: Create user API
- **Scope**: src/api/
- **Depends on**: Task 2
- **Acceptance**:
  - API endpoint works
  - User operations are accessible

**Note**: This task is intentionally ambiguous to trigger escalation testing.
The acceptance criteria lack specifics about:
- HTTP method (GET, POST, PUT, DELETE?)
- Response format
- Error handling requirements
- Authentication/authorization needs

## Context

This complex plan includes:
1. A chain of dependencies (Task 1 → Task 2 → Task 3)
2. An intentionally ambiguous task (Task 3) for escalation testing
3. Multiple files across different modules

The ambiguous Task 3 should trigger USER escalation when the Judge
determines the acceptance criteria are insufficient for proper evaluation.
