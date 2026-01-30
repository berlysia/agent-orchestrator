# Simple Test Plan

このプランは L1-L2 レベルのテスト用に設計された単純なタスク構成です。

## Task 1: Create greeting module

- **Branch**: feature/greeting
- **Description**: Create src/greeting.ts with a simple greet function that returns a greeting message
- **Scope**: src/greeting.ts
- **Acceptance**:
  - File `src/greeting.ts` exists
  - Exports a `greet(name: string): string` function
  - Returns "Hello, {name}!" format

## Context

This is a minimal implementation task for testing the leader execution flow.
No dependencies on other tasks.
Single file modification.
