import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0045: Maven provider uses fast-xml-parser (not regex XML parsing)', () => {
  const source = readSource('src/mavenProvider.ts');

  assert.equal(source.includes("from 'fast-xml-parser'"), true);
  assert.equal(source.includes('new XMLParser'), true);
  assert.equal(source.includes('removeNSPrefix: true'), true);
});

test('FR-0045: Maven module discovery includes recursion depth guard and module sorting', () => {
  const source = readSource('src/mavenProvider.ts');

  assert.equal(source.includes('if (depth > 5)'), true);
  assert.equal(source.includes('project.modules?.module'), true);
  assert.equal(source.includes('sort((left, right)'), true);
});
