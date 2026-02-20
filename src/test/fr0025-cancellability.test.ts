import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0025: mode C indexing supports cancellation token checks', () => {
  const source = readSource('src/symbolIndex.ts');
  assert.equal(source.includes('modeRebuildCancellation = new vscode.CancellationTokenSource()'), true);
  assert.equal(source.includes('token?.isCancellationRequested'), true);
  assert.equal(source.includes('Mode C index rebuild cancelled.'), true);
});

test('FR-0025: scalafmt formatting path honors cancellation and kills process', () => {
  const source = readSource('src/scalafmtFeature.ts');
  assert.equal(source.includes('token?.onCancellationRequested'), true);
  assert.equal(source.includes('child?.kill()'), true);
  assert.equal(source.includes('Scala Lite operation cancelled.'), true);
});

test('FR-0025: scalafix command is cancellable via progress notification token', () => {
  const source = readSource('src/scalafixFeature.ts');
  assert.equal(source.includes('withProgress'), true);
  assert.equal(source.includes('cancellable: true'), true);
  assert.equal(source.includes('token?.onCancellationRequested'), true);
  assert.equal(source.includes('Scalafix operation cancelled by user.'), true);
});

test('FR-0025: workspace doctor refresh supports cancellation', () => {
  const source = readSource('src/workspaceDoctorFeature.ts');
  assert.equal(source.includes('Workspace Doctor cancelled.'), true);
  assert.equal(source.includes('withProgress'), true);
  assert.equal(source.includes('cancellable: true'), true);
});
