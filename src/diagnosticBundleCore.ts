import JSZip from 'jszip';

export interface BundleInfo {
  readonly extensionVersion: string;
  readonly vscodeVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly nodeVersion: string;
}

export interface DiagnosticBundleContent {
  readonly sanitizedConfig: unknown;
  readonly logs: readonly string[];
  readonly workspaceDoctor: unknown;
  readonly environment: BundleInfo;
}

export async function createDiagnosticBundleBuffer(content: DiagnosticBundleContent): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('sanitized-config.json', JSON.stringify(content.sanitizedConfig, null, 2));
  zip.file('logs.txt', content.logs.join('\n'));
  zip.file('workspace-doctor.json', JSON.stringify(content.workspaceDoctor, null, 2));
  zip.file('environment.json', JSON.stringify(content.environment, null, 2));

  return zip.generateAsync({ type: 'nodebuffer' });
}