import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  BundleInfo,
  createDiagnosticBundleBuffer
} from './diagnosticBundleCore';
import { getNativeEngineStatus } from './nativeEngineState';

function sanitizeObject(value: unknown): unknown {
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (
      normalized.includes('token=') ||
      normalized.includes('password=') ||
      normalized.includes('secret=') ||
      normalized.includes('apikey=') ||
      normalized.includes('api_key=')
    ) {
      return '<redacted>';
    }
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeObject(item));
  }

  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey.includes('token') || normalizedKey.includes('secret') || normalizedKey.includes('password') || normalizedKey.includes('apikey')) {
        output[key] = '<redacted>';
      } else {
        output[key] = sanitizeObject(item);
      }
    }
    return output;
  }

  return value;
}

async function readWorkspaceConfig(): Promise<unknown> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return {};
  }

  const file = vscode.Uri.joinPath(folder.uri, '.vscode', 'scala-lite.json');
  try {
    const raw = await vscode.workspace.fs.readFile(file);
    return JSON.parse(Buffer.from(raw).toString('utf8'));
  } catch {
    return {};
  }
}

export async function createDiagnosticBundle(
  logs: readonly string[],
  extensionVersion: string
): Promise<vscode.Uri> {
  const info: BundleInfo = {
    extensionVersion,
    vscodeVersion: vscode.version,
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    nativeEngineStatus: getNativeEngineStatus()
  };

  const workspaceConfig = await readWorkspaceConfig();
  const sanitizedConfig = sanitizeObject(workspaceConfig);

  const workspaceDoctor = {
    status: 'not-run',
    message: 'Workspace Doctor has not been executed in this build.'
  };

  const buffer = await createDiagnosticBundleBuffer({
    sanitizedConfig,
    logs,
    workspaceDoctor,
    environment: info
  });

  const bundlePath = path.join(os.tmpdir(), `scala-lite-diagnostic-${Date.now()}.zip`);
  const bundleUri = vscode.Uri.file(bundlePath);
  await vscode.workspace.fs.writeFile(bundleUri, buffer);

  return bundleUri;
}