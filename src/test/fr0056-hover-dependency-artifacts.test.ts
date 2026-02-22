import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0056: hover includes dependency artifact section with source/javadoc open links', () => {
  const source = readSource('src/hoverInfoFeature.ts');

  assert.equal(source.includes('readDependencyAttachmentForPath'), true);
  assert.equal(source.includes('Dependency Artifacts'), true);
  assert.equal(source.includes('scalaLite.openDependencyAttachment'), true);
  assert.equal(source.includes('Open sources jar'), true);
  assert.equal(source.includes('Open javadoc jar'), true);
  assert.equal(source.includes('escapeMarkdown(preferred.symbolName)'), true);
  assert.equal(source.includes('escapeMarkdown(symbolName)'), true);
});

test('FR-0056: extension registers dependency attachment open command', () => {
  const source = readSource('src/extension.ts');

  assert.equal(source.includes("COMMAND_OPEN_DEPENDENCY_ATTACHMENT = 'scalaLite.openDependencyAttachment'"), true);
  assert.equal(source.includes('Dependency artifact not found: {0}'), true);
  assert.equal(source.includes('revealFileInOS'), true);
});
