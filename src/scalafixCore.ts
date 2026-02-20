export interface ScalafixConfig {
  readonly path?: string;
  readonly useDocker?: boolean;
  readonly timeoutMs?: number;
}

export interface ScalafixResolutionInput {
  readonly workspaceRoot: string;
  readonly linterPath?: string;
  readonly hasWorkspaceBinary: boolean;
  readonly hasGlobalBinary: boolean;
  readonly useDocker: boolean;
  readonly filePath: string;
  readonly workspaceRelativeFilePath: string;
  readonly configPath?: string;
}

export type ScalafixResolution = {
  readonly command: string;
  readonly args: string[];
};

export function resolveScalafixResolution(input: ScalafixResolutionInput): ScalafixResolution | undefined {
  const stdinArgs = ['--stdin', `--assume-filename=${input.filePath}`];
  const configArgs = input.configPath ? ['--config', input.configPath] : [];

  if (input.linterPath) {
    return {
      command: input.linterPath,
      args: [...stdinArgs, ...configArgs]
    };
  }

  if (input.hasWorkspaceBinary) {
    return {
      command: `${input.workspaceRoot}/.scalafix-bin`,
      args: [...stdinArgs, ...configArgs]
    };
  }

  if (input.hasGlobalBinary) {
    return {
      command: 'scalafix',
      args: [...stdinArgs, ...configArgs]
    };
  }

  if (input.useDocker) {
    const dockerArgs = [
      'run',
      '--rm',
      '-i',
      '-v',
      `${input.workspaceRoot}:/workspace`,
      '-w',
      '/workspace',
      'scalacenter/scalafix',
      '--stdin',
      `--assume-filename=/workspace/${input.workspaceRelativeFilePath}`
    ];

    if (input.configPath) {
      dockerArgs.push('--config', '/workspace/.scalafix.conf');
    }

    return {
      command: 'docker',
      args: dockerArgs
    };
  }

  return undefined;
}

export interface ScalafixIssue {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly fixable: boolean;
}

const warningPattern = /^\[warning\]\s+(.+?):(\d+):(?:(\d+):)?\s*(.+)$/;
const genericPattern = /^(.+?):(\d+):(?:(\d+):)?\s*(?:warning|error):\s*(.+)$/i;

export function parseScalafixOutputLine(line: string): ScalafixIssue | undefined {
  const warningMatch = line.match(warningPattern);
  if (warningMatch) {
    const message = warningMatch[4].trim();
    return {
      filePath: warningMatch[1],
      line: Number(warningMatch[2]),
      column: warningMatch[3] ? Number(warningMatch[3]) : 1,
      message,
      fixable: /fixable|autofix|rewrite/i.test(message)
    };
  }

  const genericMatch = line.match(genericPattern);
  if (genericMatch) {
    const message = genericMatch[4].trim();
    return {
      filePath: genericMatch[1],
      line: Number(genericMatch[2]),
      column: genericMatch[3] ? Number(genericMatch[3]) : 1,
      message,
      fixable: /fixable|autofix|rewrite/i.test(message)
    };
  }

  return undefined;
}

export interface ScalafixExecutionResult {
  readonly status: 'ok' | 'timeout' | 'error';
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string;
}

export interface ScalafixExecutorOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type ScalafixExecutor = () => Promise<ScalafixExecutorOutput>;

export async function runScalafixWithTimeout(
  executor: ScalafixExecutor,
  timeoutMs: number
): Promise<ScalafixExecutionResult> {
  const effectiveTimeoutMs = Math.max(100, timeoutMs);

  const timeoutPromise = new Promise<ScalafixExecutionResult>((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ status: 'timeout' });
      clearTimeout(timeout);
    }, effectiveTimeoutMs);
  });

  const executionPromise = executor().then((result) => {
    if (result.exitCode !== 0) {
      return {
        status: 'error',
        error: result.stderr || `Scalafix exited with code ${result.exitCode}`
      } as ScalafixExecutionResult;
    }

    return {
      status: 'ok',
      stdout: result.stdout,
      stderr: result.stderr
    } as ScalafixExecutionResult;
  });

  return Promise.race([executionPromise, timeoutPromise]);
}

export function defaultScalafixTimeoutMs(config: ScalafixConfig): number {
  return config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : 10_000;
}
