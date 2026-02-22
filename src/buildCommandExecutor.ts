import { spawn } from 'node:child_process';
import * as vscode from 'vscode';

export interface BuildCommandOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly cancellationToken?: vscode.CancellationToken;
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
}

export interface BuildCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly combinedOutput: string;
  readonly timedOut: boolean;
  readonly wasCancelled: boolean;
  readonly durationMs: number;
}

const SENSITIVE_OUTPUT_PATTERNS: readonly RegExp[] = [
  /(password\s*[=:]\s*)([^\s]+)/ig,
  /(token\s*[=:]\s*)([^\s]+)/ig,
  /(authorization\s*[=:]\s*)([^\s]+)/ig,
  /(secret\s*[=:]\s*)([^\s]+)/ig,
  /(aws_secret_access_key\s*[=:]\s*)([^\s]+)/ig
];

export function redactSensitiveOutput(raw: string): string {
  let sanitized = raw;
  for (const pattern of SENSITIVE_OUTPUT_PATTERNS) {
    sanitized = sanitized.replace(pattern, '$1<redacted>');
  }

  return sanitized;
}

export async function executeBuildCommand(options: BuildCommandOptions): Promise<BuildCommandResult> {
  const startedAt = Date.now();

  return new Promise<BuildCommandResult>((resolve, reject) => {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let wasCancelled = false;
    let settled = false;

    const finish = (exitCode: number): void => {
      if (settled) {
        return;
      }

      settled = true;
      const safeStdout = redactSensitiveOutput(stdout);
      const safeStderr = redactSensitiveOutput(stderr);
      resolve({
        exitCode,
        stdout: safeStdout,
        stderr: safeStderr,
        combinedOutput: `${safeStdout}${safeStderr ? `\n${safeStderr}` : ''}`.trim(),
        timedOut,
        wasCancelled,
        durationMs: Date.now() - startedAt
      });
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
      }
    }, Math.max(1, options.timeoutMs));

    const cancellationDisposable = options.cancellationToken?.onCancellationRequested(() => {
      wasCancelled = true;
      try {
        child.kill('SIGKILL');
      } catch {
      }
    });

    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      stdout += text;
      options.onStdout?.(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      options.onStderr?.(text);
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      cancellationDisposable?.dispose();
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timeoutHandle);
      cancellationDisposable?.dispose();
      finish(code ?? 1);
    });
  });
}
