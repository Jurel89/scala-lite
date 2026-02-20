import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('PF-0002: no setInterval in activation path', () => {
  const extensionSource = readSource('src/extension.ts');
  assert.equal(extensionSource.includes('setInterval('), false);
});

test('PF-0002: no setTimeout in activation path', () => {
  const extensionSource = readSource('src/extension.ts');
  assert.equal(extensionSource.includes('setTimeout('), false);
});

test('PF-0002: no file watchers registered in default mode', () => {
  const extensionSource = readSource('src/extension.ts');
  assert.equal(extensionSource.includes('createFileSystemWatcher('), false);
});