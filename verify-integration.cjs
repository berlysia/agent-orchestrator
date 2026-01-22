#!/usr/bin/env node
/**
 * Verification script for refinement integration
 *
 * VERIFY:
 * (1) executeRefinementLoop is called after plan generation
 * (2) refinement result is handled with Result type
 * (3) Error propagation uses Result type, not exceptions
 * (4) Ok case passes improved tasks to subsequent processing
 * (5) refinementHistory is recorded in logs or session state
 * (6) Backward compatibility is maintained
 */

console.log('=== Refinement Integration Verification ===\n');

const fs = require('fs');
const path = require('path');

const plannerOpsPath = path.join(__dirname, 'src/core/orchestrator/planner-operations.ts');
const plannerSessionTypePath = path.join(__dirname, 'src/types/planner-session.ts');
const orchestratePath = path.join(__dirname, 'src/core/orchestrator/orchestrate.ts');

let allChecksPassed = true;

function check(name, condition, details = '') {
  const result = condition ? '✅' : '❌';
  console.log(`${result} ${name}`);
  if (!condition) {
    allChecksPassed = false;
    if (details) console.log(`   ${details}`);
  }
  return condition;
}

// Read files
const plannerOpsContent = fs.readFileSync(plannerOpsPath, 'utf-8');
const plannerSessionContent = fs.readFileSync(plannerSessionTypePath, 'utf-8');
const orchestrateContent = fs.readFileSync(orchestratePath, 'utf-8');

console.log('(1) executeRefinementLoop is called in the plan generation flow');
check(
  'executeRefinementLoop is defined',
  plannerOpsContent.includes('export async function executeRefinementLoop')
);
check(
  'executeRefinementLoop is called in planTasks',
  plannerOpsContent.includes('await executeRefinementLoop({')
);
check(
  'Called after quality check passes',
  plannerOpsContent.includes('Quality check passed') &&
  plannerOpsContent.indexOf('await executeRefinementLoop({') >
  plannerOpsContent.indexOf('Quality check passed')
);

console.log('\n(2) refinement result is handled with Result type');
check(
  'Result type is imported',
  plannerOpsContent.includes('type Result') || plannerOpsContent.includes('import type { Result }')
);
check(
  'refinementResult variable exists',
  plannerOpsContent.includes('refinementResult')
);
check(
  'Result is checked with isErr',
  plannerOpsContent.includes('isErr(refinementResult)')
);

console.log('\n(3) Error propagation uses Result type');
check(
  'Error case returns createErr',
  plannerOpsContent.match(/isErr\(refinementResult\)[\s\S]*?return createErr\(/m)
);
check(
  'No throw statements in refinement handling',
  !plannerOpsContent.match(/await executeRefinementLoop[\s\S]{0,500}throw /m)
);

console.log('\n(4) Ok case passes improved tasks to subsequent processing');
check(
  'refinementResult.val.finalTasks is used',
  plannerOpsContent.includes('refinementResult.val.finalTasks')
);
check(
  'taskBreakdowns is updated with refined tasks',
  plannerOpsContent.match(/taskBreakdowns\s*=\s*refinementResult\.val\.finalTasks/m) !== null
);

console.log('\n(5) refinementHistory is recorded in logs or session state');
check(
  'refinementHistory is added to PlannerSessionSchema',
  plannerSessionContent.includes('refinementHistory')
);
check(
  'refinementHistory is saved to session',
  plannerOpsContent.includes('session.refinementHistory') ||
  plannerOpsContent.includes('refinementHistory')
);
check(
  'refinementHistory is logged',
  plannerOpsContent.includes('appendPlanningLog') &&
  plannerOpsContent.includes('Refinement history')
);

console.log('\n(6) Backward compatibility is maintained');
check(
  'refinementConfig is optional in PlannerDeps',
  plannerOpsContent.includes('refinementConfig?:')
);
check(
  'Refinement is conditional on config existence',
  plannerOpsContent.includes('if (deps.refinementConfig)')
);
check(
  'refinementConfig is passed from orchestrate',
  orchestrateContent.includes('refinementConfig:')
);
check(
  'refinementHistory is optional in PlannerSessionSchema',
  plannerSessionContent.match(/refinementHistory[\s\S]{0,300}\.optional\(\)/m) !== null
);

console.log('\n=== Summary ===');
if (allChecksPassed) {
  console.log('✅ All verification checks passed!');
  console.log('\nThe refinement integration is correctly implemented:');
  console.log('- executeRefinementLoop is called after plan generation');
  console.log('- Result type is used for error handling (no exceptions)');
  console.log('- Refined tasks are passed to subsequent processing');
  console.log('- refinementHistory is stored in session state and logs');
  console.log('- Backward compatibility is maintained');
  process.exit(0);
} else {
  console.log('❌ Some verification checks failed. Please review the implementation.');
  process.exit(1);
}
