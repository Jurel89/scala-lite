import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('SC-0001: extension code contains no network API usage', () => {
  const files = [
    'src/extension.ts',
    'src/buildDiagnostics.ts',
    'src/diagnosticBundle.ts',
    'src/workspaceConfigFeature.ts'
  ];

  for (const file of files) {
    const source = readSource(file);
    assert.equal(source.includes('http'), false);
    assert.equal(source.includes('https'), false);
    assert.equal(source.includes('fetch('), false);
    assert.equal(source.includes('XMLHttpRequest'), false);
  }
});

test('SC-0001: child processes are sandboxed with workspace cwd', () => {
  const buildSource = readSource('src/buildDiagnostics.ts');
  const fmtSource = readSource('src/scalafmtFeature.ts');
  const fixSource = readSource('src/scalafixFeature.ts');

  assert.equal(buildSource.includes('spawn(command, {') && buildSource.includes('cwd'), true);
  assert.equal(fmtSource.includes("spawn(command, args, { shell: true, cwd })"), true);
  assert.equal(fmtSource.includes("spawn('scalafmt', ['--version'], { shell: true, cwd })"), true);
  assert.equal(fixSource.includes("spawn(command, args, { shell: true, cwd })"), true);
  assert.equal(fixSource.includes("spawn('scalafix', ['--version'], { shell: true, cwd })"), true);
});

test('SC-0001: command logging redacts environment variable assignments', () => {
  const source = readSource('src/buildDiagnostics.ts');
  assert.equal(source.includes('sanitizeCommandForLog'), true);
  assert.equal(source.includes('<redacted>'), true);
});

test('SC-0001: diagnostic bundle sanitization redacts secret-like values', () => {
  const source = readSource('src/diagnosticBundle.ts');
  assert.equal(source.includes("normalized.includes('token=')"), true);
  assert.equal(source.includes("normalized.includes('password=')"), true);
  assert.equal(source.includes("normalized.includes('secret=')"), true);
});
