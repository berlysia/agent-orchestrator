import { spawn, type SpawnOptions } from 'node:child_process';

/**
 * プロセス実行結果
 */
export interface ProcessResult {
  /** 終了コード */
  exitCode: number | null;
  /** シグナル（強制終了時） */
  signal: NodeJS.Signals | null;
  /** stdout出力 */
  stdout: string;
  /** stderr出力 */
  stderr: string;
  /** 実行時間（ミリ秒） */
  duration: number;
  /** タイムアウトで終了したか */
  timedOut: boolean;
}

/**
 * プロセス実行オプション
 */
export interface ProcessRunnerOptions {
  /** 作業ディレクトリ */
  cwd?: string;
  /** 環境変数 */
  env?: Record<string, string>;
  /** タイムアウト（ミリ秒）。0でタイムアウトなし */
  timeout?: number;
  /** stdout/stderrをリアルタイムでストリーミングするか */
  streaming?: boolean;
  /** stdoutコールバック */
  onStdout?: (data: string) => void;
  /** stderrコールバック */
  onStderr?: (data: string) => void;
  /** errorコールバック */
  onError?: (error: Error) => void;
}

/**
 * プロセス実行ラッパー
 *
 * コマンドを実行し、stdout/stderrをキャプチャし、タイムアウト制御を行う。
 */
export class ProcessRunner {
  /**
   * コマンドを実行する
   *
   * @param command 実行するコマンド
   * @param args コマンド引数
   * @param options 実行オプション
   * @returns プロセス実行結果
   */
  async run(
    command: string,
    args: string[] = [],
    options: ProcessRunnerOptions = {},
  ): Promise<ProcessResult> {
    const startTime = Date.now();
    const { cwd, env, timeout = 0, streaming = false, onStdout, onStderr, onError } = options;

    const spawnOptions: SpawnOptions = {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      shell: false,
    };

    const abortController = new AbortController();
    let timeoutId: NodeJS.Timeout | undefined;

    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        abortController.abort();
      }, timeout);
    }

    return new Promise<ProcessResult>((resolve, reject) => {
      const childProcess = spawn(command, args, {
        ...spawnOptions,
        signal: abortController.signal,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // stdout capture
      childProcess.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        stdout += text;
        if (streaming && onStdout) {
          onStdout(text);
        }
      });

      // stderr capture
      childProcess.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        stderr += text;
        if (streaming && onStderr) {
          onStderr(text);
        }
      });

      // Process error handling
      childProcess.on('error', (error: Error) => {
        if (timeoutId) clearTimeout(timeoutId);

        // AbortErrorの場合はタイムアウトとして処理
        if (error.name === 'AbortError') {
          timedOut = true;
          const duration = Date.now() - startTime;
          resolve({
            exitCode: null,
            signal: 'SIGTERM',
            stdout,
            stderr,
            duration,
            timedOut: true,
          });
        } else {
          if (onError) {
            onError(error);
          }
          reject(error);
        }
      });

      // Process exit handling
      childProcess.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (timeoutId) clearTimeout(timeoutId);

        const duration = Date.now() - startTime;

        resolve({
          exitCode: code,
          signal,
          stdout,
          stderr,
          duration,
          timedOut,
        });
      });
    });
  }
}
