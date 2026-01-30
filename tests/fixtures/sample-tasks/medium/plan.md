# Medium Test Plan

このプランは L3-L4 レベルのテスト用に設計された、依存関係を持つタスク構成です。

## Task 1: Create data types

- **Branch**: feature/types
- **Description**: Define User interface in src/types.ts with basic user properties
- **Scope**: src/types.ts
- **Acceptance**:
  - File `src/types.ts` exists
  - Exports `User` interface with `id`, `name`, `email` properties
  - All properties have proper TypeScript types

## Task 2: Create user service

- **Branch**: feature/user-service
- **Description**: Implement user service using the User type
- **Scope**: src/services/user.ts
- **Depends on**: Task 1
- **Acceptance**:
  - File `src/services/user.ts` exists
  - Imports `User` from `../types`
  - Exports `UserService` class with `getUser(id: string): User | null` method
  - Uses the User type correctly

## Context

This plan tests dependency handling where Task 2 depends on Task 1.
The dependency chain must be respected during execution.
Task 2 cannot start until Task 1 is completed.
