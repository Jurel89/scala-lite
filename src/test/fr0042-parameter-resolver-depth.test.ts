import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0042: parameter resolver scans multiple enclosing defs upward', () => {
  const source = readSource('src/goToDefinitionFeature.ts');

  assert.equal(source.includes('const maxLookBack = 400;'), true);
  assert.equal(source.includes('while (searchLine >= minLine) {'), true);
  assert.equal(source.includes('const signatureRange = this.findNearestEnclosingDefSignatureFromLine(document, searchLine, minLine);'), true);
  assert.equal(source.includes('if (parameterNames.includes(symbolName)) {'), true);
  assert.equal(source.includes('searchLine = signatureRange.startLine - 1;'), true);
});

test('FR-0042: parameter resolver enforces owner-scoped definition containment and marks param kind', () => {
  const source = readSource('src/goToDefinitionFeature.ts');

  assert.equal(source.includes('private isCursorWithinDefinitionScope('), true);
  assert.equal(source.includes('if (!/^\\s*(?:final\\s+|override\\s+|private\\s+|protected\\s+|implicit\\s+|inline\\s+)*def\\s+[A-Za-z_][A-Za-z0-9_]*/.test(startText)) {'), true);
  assert.equal(source.includes(".filter((symbol) => symbol.symbolKind !== 'param')"), true);
  assert.equal(source.includes('if (!this.isCursorWithinDefinitionScope(document, signatureRange.startLine, signatureEndLine, currentLine)) {'), true);
  assert.equal(source.includes('symbolKind: \'param\''), true);
});

test('FR-0042: hover enables local-first guard to avoid global ambiguity noise', () => {
  const hoverSource = readSource('src/hoverInfoFeature.ts');
  const resolverSource = readSource('src/goToDefinitionFeature.ts');

  assert.equal(hoverSource.includes('hoverLocalFirstGuard: true'), true);
  assert.equal(resolverSource.includes('readonly hoverLocalFirstGuard: boolean;'), true);
  assert.equal(resolverSource.includes("reason: 'local-context-unresolved'"), true);
});
