import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0057: fetch dependency sources command asks for explicit confirmation before download', () => {
  const source = readSource('src/extension.ts');

  assert.equal(source.includes('This will download dependency sources and javadocs for your classpath artifacts. Continue?'), true);
  assert.equal(source.includes('modal: true'), true);
  assert.equal(source.includes('if (confirmation !== continueAction)'), true);
  assert.equal(source.includes('Fetching dependency sources...'), true);
});
