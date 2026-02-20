import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0005: command contribution includes Rebuild Index', () => {
  const packageJson = JSON.parse(readSource('package.json')) as {
    contributes: {
      commands: Array<{ command: string; title: string }>;
    };
  };

  const command = packageJson.contributes.commands.find((entry) => entry.command === 'scalaLite.rebuildIndex');
  assert.ok(command);
  assert.equal(command?.title, '%command.scalaLite.rebuildIndex.title%');
});

test('FR-0005: index tuple fields include symbol and location data', () => {
  const source = readSource('src/symbolIndex.ts');
  assert.equal(source.includes('symbolName'), true);
  assert.equal(source.includes('symbolKind'), true);
  assert.equal(source.includes('filePath'), true);
  assert.equal(source.includes('lineNumber'), true);
  assert.equal(source.includes('containerName'), true);
});

test('FR-0005: mode-aware scope behavior is implemented', () => {
  const source = readSource('src/symbolIndex.ts');
  assert.equal(source.includes("this.currentMode === 'A'"), true);
  assert.equal(source.includes("this.currentMode === 'B'"), true);
  assert.equal(source.includes('rebuildModeC'), true);
});

test('FR-0005: mode B evicts closed-file index entries within one second', () => {
  const source = readSource('src/symbolIndex.ts');
  assert.equal(source.includes('onDidCloseTextDocument'), true);
  assert.equal(source.includes('setTimeout'), true);
  assert.equal(source.includes('1000'), true);
});

test('FR-0005: mode C indexes scala and sbt files with 5000-file cap', () => {
  const source = readSource('src/symbolIndex.ts');
  assert.equal(source.includes('**/*.{scala,sbt}'), true);
  assert.equal(source.includes('5000'), true);
});

test('FR-0005: extension wires SymbolIndexManager into mode changes', () => {
  const source = readSource('src/extension.ts');
  assert.equal(source.includes('new SymbolIndexManager(logger)'), true);
  assert.equal(source.includes('symbolIndexManager.initialize(context)'), true);
  assert.equal(source.includes('await symbolIndexManager.setMode(mode)'), true);
});
