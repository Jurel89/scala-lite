import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0053: hover provider includes provenance labels and dependency source-state messaging', () => {
  const source = readSource('src/hoverInfoFeature.ts');

  assert.equal(source.includes('resolveWorkspaceFolderForPath'), true);
  assert.equal(source.includes('provenanceLabelForSymbol'), true);
  assert.equal(source.includes("vscode.l10n.t('Origin')"), true);
  assert.equal(source.includes("vscode.l10n.t('Workspace')"), true);
  assert.equal(source.includes("vscode.l10n.t('Dependency')"), true);
  assert.equal(source.includes("vscode.l10n.t('JDK')"), true);
  assert.equal(source.includes('Sources available — Cmd+click to navigate.'), true);
  assert.equal(source.includes('No sources available —'), true);
  assert.equal(source.includes("commandLink('scalaLite.fetchDependencySources')"), true);
});

test('FR-0053: low-confidence hover offers sync classpath action when dependency index cache is missing', () => {
  const source = readSource('src/hoverInfoFeature.ts');

  assert.equal(source.includes('resolveWorkspaceFolderForDocument'), true);
  assert.equal(source.includes("mode === 'C'"), true);
  assert.equal(source.includes('readDependencyConfigFromWorkspaceConfig'), true);
  assert.equal(source.includes('hasDependencyIndexCache'), true);
  assert.equal(source.includes('Classpath not synced —'), true);
  assert.equal(source.includes("commandLink('scalaLite.syncClasspath', workspaceFolder.uri.toString())"), true);
});
