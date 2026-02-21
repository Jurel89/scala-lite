import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { createDiagnosticBundleBuffer } from '../diagnosticBundleCore';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0021: diagnostic bundle contains required components', async () => {
  const buffer = await createDiagnosticBundleBuffer({
    sanitizedConfig: { logLevel: 'INFO' },
    logs: ['[14:32:05] [INFO] [ACTIVATE] Activated'],
    workspaceDoctor: { status: 'not-run' },
    environment: {
      extensionVersion: '0.0.1',
      vscodeVersion: '1.0.0',
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: 'v22.0.0',
      nativeEngineStatus: 'fallback'
    }
  });

  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files);
  assert.equal(names.includes('sanitized-config.json'), true);
  assert.equal(names.includes('logs.txt'), true);
  assert.equal(names.includes('workspace-doctor.json'), true);
  assert.equal(names.includes('environment.json'), true);
});

test('FR-0021: diagnostic bundle implementation performs no network calls', () => {
  const source = readSource('src/diagnosticBundle.ts');
  assert.equal(source.includes('http'), false);
  assert.equal(source.includes('https'), false);
  assert.equal(source.includes('fetch('), false);
});
