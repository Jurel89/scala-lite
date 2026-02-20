export interface ScalafmtConfig {
  readonly path?: string;
  readonly useDocker?: boolean;
  readonly timeoutMs?: number;
  readonly formatOnSave?: boolean;
}

export interface ScalafmtResolutionInput {
  readonly workspaceRoot: string;
  readonly formatterPath?: string;
  readonly hasWorkspaceBinary: boolean;
  readonly hasGlobalBinary: boolean;
  readonly useDocker: boolean;
  readonly filePath: string;
  readonly workspaceRelativeFilePath: string;
}

export type ScalafmtResolution =
  | {
      readonly kind: 'binary';
      readonly command: string;
      readonly args: string[];
    }
  | {
      readonly kind: 'docker';
      readonly command: 'docker';
      readonly args: string[];
    };

export function resolveScalafmtResolution(input: ScalafmtResolutionInput): ScalafmtResolution | undefined {
  const stdinArgs = ['--stdin', `--assume-filename=${input.filePath}`];

  if (input.formatterPath) {
    return {
      kind: 'binary',
      command: input.formatterPath,
      args: stdinArgs
    };
  }

  if (input.hasWorkspaceBinary) {
    return {
      kind: 'binary',
      command: `${input.workspaceRoot}/.scalafmt-bin`,
      args: stdinArgs
    };
  }

  if (input.hasGlobalBinary) {
    return {
      kind: 'binary',
      command: 'scalafmt',
      args: stdinArgs
    };
  }

  if (input.useDocker) {
    return {
      kind: 'docker',
      command: 'docker',
      args: [
        'run',
        '--rm',
        '-i',
        '-v',
        `${input.workspaceRoot}:/workspace`,
        '-w',
        '/workspace',
        'scalameta/scalafmt',
        '--stdin',
        `--assume-filename=/workspace/${input.workspaceRelativeFilePath}`
      ]
    };
  }

  return undefined;
}

export interface ScalafmtExecutionResult {
  readonly status: 'ok' | 'timeout' | 'error';
  readonly stdout?: string;
  readonly error?: string;
}

export interface ScalafmtExecutorOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type ScalafmtExecutor = () => Promise<ScalafmtExecutorOutput>;

export async function runScalafmtWithTimeout(
  executor: ScalafmtExecutor,
  timeoutMs: number
): Promise<ScalafmtExecutionResult> {
  const effectiveTimeoutMs = Math.max(100, timeoutMs);

  const timeoutPromise = new Promise<ScalafmtExecutionResult>((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ status: 'timeout' });
      clearTimeout(timeout);
    }, effectiveTimeoutMs);
  });

  const executionPromise = executor().then((result) => {
    if (result.exitCode !== 0) {
      return {
        status: 'error',
        error: result.stderr || `Scalafmt exited with code ${result.exitCode}`
      } as ScalafmtExecutionResult;
    }

    return {
      status: 'ok',
      stdout: result.stdout
    } as ScalafmtExecutionResult;
  });

  return Promise.race([executionPromise, timeoutPromise]);
}

export function defaultScalafmtTimeoutMs(config: ScalafmtConfig): number {
  return config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : 5000;
}

export function defaultScalafmtConfContent(): string {
  return 'version = "3.8.1"\nmaxColumn = 100\n';
}