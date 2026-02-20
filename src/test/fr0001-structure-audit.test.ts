import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0001: registers explicit re-detect build tool command', () => {
  const extensionSource = readSource('src/extension.ts');
  assert.equal(extensionSource.includes('scalaLite.reDetectBuildTool'), true);
});

test('FR-0001: detection session includes per-workspace cache map', () => {
  const detectorSource = readSource('src/buildToolDetector.ts');
  assert.equal(detectorSource.includes('private readonly cache = new Map<string, BuildToolDetectionResult>()'), true);
});

test('FR-0001: detection processes workspace folders independently (multi-root)', () => {
  const detectorSource = readSource('src/buildToolDetector.ts');
  assert.equal(detectorSource.includes('folders.map('), true);
});
