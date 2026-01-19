import readline from 'readline/promises';

/**
 * 失敗タスクの処理方法
 * - retry: worktreeをクリーンにして最初からやり直す
 * - continue: 既存worktreeの状態を維持してエージェントに続行を依頼
 * - skip: このタスクをスキップ
 */
export type FailedTaskHandling = 'retry' | 'continue' | 'skip';

/**
 * ユーザーに選択肢を提示して入力を待つ
 *
 * @param question 質問文
 * @param choices 選択肢の配列（例: ['1', '2', '3']）
 * @returns ユーザーの入力（choicesのいずれかが保証される）
 */
async function promptChoice(question: string, choices: string[]): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const answer = await rl.question(question);
      const trimmed = answer.trim();

      if (choices.includes(trimmed)) {
        return trimmed;
      }

      console.log(`Invalid input. Please choose one of: ${choices.join(', ')}`);
    }
  } finally {
    rl.close();
  }
}

/**
 * 失敗タスクの処理方法をユーザーに確認
 *
 * @param taskId タスクID
 * @param taskDescription タスクの説明（受け入れ基準など）
 * @returns ユーザーが選択した処理方法
 */
export async function promptFailedTaskHandling(
  taskId: string,
  taskDescription: string,
): Promise<FailedTaskHandling> {
  console.log(`\n⚠️  Task [${taskId}] が失敗または停止しています:`);
  console.log(`   ${taskDescription}`);
  console.log(`\nどうしますか？`);
  console.log(`  1. リトライ（worktreeをクリーンにして最初からやり直す）`);
  console.log(`  2. 続きから引き継ぐ（既存worktreeの状態を維持して続行）`);
  console.log(`  3. スキップ（このタスクを飛ばす）`);

  const choice = await promptChoice('選択してください (1/2/3): ', ['1', '2', '3']);

  switch (choice) {
    case '1':
      return 'retry';
    case '2':
      return 'continue';
    case '3':
      return 'skip';
    default:
      throw new Error('Unreachable');
  }
}

/**
 * yes/no の確認プロンプト
 *
 * @param question 質問文
 * @returns trueならyes、falseならno
 */
export async function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const answer = await rl.question(`${question} (y/n): `);
      const trimmed = answer.trim().toLowerCase();

      if (trimmed === 'y' || trimmed === 'yes') {
        return true;
      }
      if (trimmed === 'n' || trimmed === 'no') {
        return false;
      }

      console.log('Invalid input. Please enter "y" or "n".');
    }
  } finally {
    rl.close();
  }
}
