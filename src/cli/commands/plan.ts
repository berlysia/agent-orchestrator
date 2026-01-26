import { Command } from 'commander';
import { loadConfig } from '../utils/load-config.ts';
import { PlanningSessionEffectsImpl } from '../../core/orchestrator/planning-session-effects-impl.ts';
import { PlannerSessionEffectsImpl } from '../../core/orchestrator/planner-session-effects-impl.ts';
import { createRunnerEffects } from '../../core/runner/runner-effects-impl.ts';
import { createPlanningOperations } from '../../core/orchestrator/planning-operations.ts';
import { PlanningSessionStatus } from '../../types/planning-session.ts';
import { isErr } from 'option-t/plain_result';
import { promptFreeText, promptSelect, promptYesNo } from '../utils/prompt.ts';

/**
 * `agent plan` コマンドの実装
 *
 * 対話的プランニングモードでユーザーと対話しながら計画を作成する。
 */
export function createPlanCommand(): Command {
  const planCommand = new Command('plan')
    .description('Interactive planning mode for task clarification and design')
    .argument('[instruction]', 'Initial task instruction (required for new session)')
    .option('--resume [sessionId]', 'Resume an existing planning session')
    .option('--config <path>', 'Path to configuration file')
    .action(async (instruction: string | undefined, options) => {
      try {
        if (options.resume) {
          // セッション再開
          await executeResume({
            sessionId: typeof options.resume === 'string' ? options.resume : undefined,
            configPath: options.config,
          });
        } else {
          // 新規セッション
          if (!instruction) {
            console.error('Error: instruction is required for new planning session');
            console.error('Usage: agent plan "<instruction>"');
            process.exit(1);
          }
          await executeNewPlan({
            instruction,
            configPath: options.config,
          });
        }
      } catch (error) {
        console.error('Planning failed:', error);
        process.exit(1);
      }
    });

  return planCommand;
}

/**
 * 新規プランニングセッション実行
 */
async function executeNewPlan(params: {
  instruction: string;
  configPath?: string;
}): Promise<void> {
  const { instruction, configPath } = params;

  // 設定ファイルを読み込み
  const config = await loadConfig(configPath);

  console.log(`📋 Configuration loaded`);
  console.log(`   App Repo: ${config.appRepoPath}`);
  console.log(`   Agent Coord: ${config.agentCoordPath}\n`);

  // Effectsを初期化
  const planningSessionEffects = new PlanningSessionEffectsImpl(config.agentCoordPath);
  const plannerSessionEffects = new PlannerSessionEffectsImpl(config.agentCoordPath);
  const runnerEffects = createRunnerEffects({
    coordRepoPath: config.agentCoordPath,
    timeout: 0,
  });

  // Planning Operationsを初期化
  const operations = createPlanningOperations({
    planningSessionEffects,
    plannerSessionEffects,
    runnerEffects,
    appRepoPath: config.appRepoPath,
    agentType: config.agents.planner.type,
    plannerModel: config.agents.planner.model,
  });

  // Discovery Phase: セッション開始
  console.log(`🔍 Starting Discovery Phase...\n`);
  const sessionResult = await operations.startNewSession(instruction);

  if (isErr(sessionResult)) {
    console.error(`\n❌ Failed to start session: ${sessionResult.err.message}`);
    process.exit(1);
  }

  let session = sessionResult.val;
  console.log(`✅ Session created: ${session.sessionId}\n`);

  // Discovery Phase: 質問に回答
  console.log(`📝 Please answer the following questions:\n`);
  for (const question of session.questions) {
    console.log(`\n${question.question}`);

    let answer: string | null;
    if (question.options && question.options.length > 0) {
      // 選択肢がある場合
      answer = await promptSelect(
        'Select an option:',
        question.options.map((opt) => ({ label: opt, value: opt })),
      );
    } else {
      // 自由入力
      answer = await promptFreeText('Your answer:');
    }

    const answerResult = await operations.answerQuestion(session, question.id, answer);
    if (isErr(answerResult)) {
      console.error(`\n❌ Failed to record answer: ${answerResult.err.message}`);
      process.exit(1);
    }
    session = answerResult.val;
  }

  // Design Phase: 遷移
  console.log(`\n🎨 Transitioning to Design Phase...\n`);
  const designResult = await operations.transitionToDesignPhase(session);

  if (isErr(designResult)) {
    console.error(`\n❌ Failed to transition to Design Phase: ${designResult.err.message}`);
    process.exit(1);
  }

  session = designResult.val;
  console.log(`✅ Design Phase started\n`);

  // Design Phase: 決定点を記録
  console.log(`🎯 Please make the following design decisions:\n`);
  for (const decision of session.decisionPoints) {
    console.log(`\n--- ${decision.title} ---`);
    console.log(decision.description);
    console.log('');

    // 選択肢を表示
    decision.options.forEach((opt, idx) => {
      console.log(`Option ${idx + 1}: ${opt.label}`);
      console.log(`  Pros: ${opt.pros.join(', ')}`);
      console.log(`  Cons: ${opt.cons.join(', ')}`);
      console.log('');
    });

    const selectedOption = await promptSelect(
      'Select an option:',
      decision.options.map((opt) => ({ label: opt.label, value: opt.label })),
    );

    const rationale = await promptFreeText('Why did you choose this? (optional, press Enter to skip):');

    const recordResult = await operations.recordDecision(
      session,
      decision.id,
      selectedOption,
      rationale || undefined,
    );

    if (isErr(recordResult)) {
      console.error(`\n❌ Failed to record decision: ${recordResult.err.message}`);
      process.exit(1);
    }
    session = recordResult.val;
  }

  // Review Phase: 遷移
  console.log(`\n📊 Transitioning to Review Phase...\n`);
  const reviewResult = await operations.transitionToReviewPhase(session);

  if (isErr(reviewResult)) {
    console.error(`\n❌ Failed to transition to Review Phase: ${reviewResult.err.message}`);
    process.exit(1);
  }

  session = reviewResult.val;
  console.log(`✅ Review Phase started\n`);

  // Review Phase: 承認/拒否
  console.log(`\n📋 Plan Summary:\n`);
  console.log(`Instruction: ${session.instruction}\n`);

  console.log(`Questions & Answers:`);
  session.questions.forEach((q, i) => {
    console.log(`  ${i + 1}. ${q.question}`);
    console.log(`     Answer: ${q.answer ?? 'Skipped'}`);
  });

  console.log(`\nDesign Decisions:`);
  session.decisionPoints.forEach((d, i) => {
    console.log(`  ${i + 1}. ${d.title}`);
    console.log(`     Selected: ${d.selectedOption ?? 'Not decided'}`);
    if (d.rationale) {
      console.log(`     Rationale: ${d.rationale}`);
    }
  });

  const approve = await promptYesNo('\n✅ Do you approve this plan?');

  if (approve) {
    // 承認
    const approveResult = await operations.approvePlan(session);
    if (isErr(approveResult)) {
      console.error(`\n❌ Failed to approve plan: ${approveResult.err.message}`);
      process.exit(1);
    }
    session = approveResult.val;

    console.log(`\n✅ Plan approved!`);
    console.log(`   Planning Session: ${session.sessionId}`);
    console.log(`   Planner Session: ${session.plannerSessionId}`);
    console.log(
      `\nNext step: Run "agent run --session ${session.plannerSessionId}" to execute the plan`,
    );
  } else {
    // 拒否
    const reason = await promptFreeText('Why did you reject this plan?');
    const rejectResult = await operations.rejectPlan(session, reason);

    if (isErr(rejectResult)) {
      console.error(`\n❌ Failed to reject plan: ${rejectResult.err.message}`);
      process.exit(1);
    }
    session = rejectResult.val;

    if (session.status === PlanningSessionStatus.CANCELLED) {
      console.log(`\n❌ Plan rejected 3 times. Session cancelled.`);
      console.log(`   Session: ${session.sessionId}`);
    } else {
      console.log(`\n⚠️  Plan rejected. Returning to Design Phase...`);
      console.log(`   Session: ${session.sessionId}`);
      console.log(
        `   Run "agent plan --resume ${session.sessionId}" to continue from Design Phase`,
      );
    }
  }
}

/**
 * セッション再開実行
 */
async function executeResume(params: {
  sessionId?: string;
  configPath?: string;
}): Promise<void> {
  const { sessionId, configPath } = params;

  // 設定ファイルを読み込み
  const config = await loadConfig(configPath);

  // Effectsを初期化
  const planningSessionEffects = new PlanningSessionEffectsImpl(config.agentCoordPath);

  if (!sessionId) {
    // セッション一覧を表示
    console.log(`\n📋 Planning Sessions:\n`);

    const listResult = await planningSessionEffects.listSessions();
    if (isErr(listResult)) {
      console.error(`\n❌ Failed to list sessions: ${listResult.err.message}`);
      process.exit(1);
    }

    const sessions = listResult.val;
    if (sessions.length === 0) {
      console.log('No planning sessions found.');
      return;
    }

    sessions.forEach((session, idx) => {
      console.log(`${idx + 1}. ${session.sessionId}`);
      console.log(`   Instruction: ${session.instruction}`);
      console.log(`   Status: ${session.status}`);
      console.log(`   Created: ${new Date(session.createdAt).toLocaleString()}`);
      console.log('');
    });

    console.log(`\nTo resume a session, run: agent plan --resume <sessionId>`);
    return;
  }

  // セッション再開（Phase 3では簡略化版として一覧表示のみ実装）
  console.log(`\nResuming session: ${sessionId}`);
  console.log('Note: Session resume functionality is not yet fully implemented.');
  console.log('Please use the session ID with other commands as needed.');
}
