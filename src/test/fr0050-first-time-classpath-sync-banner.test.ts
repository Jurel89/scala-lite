import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0050: first-time dependency sync banner is gated and persisted in workspace state', () => {
  const source = readSource('src/extension.ts');

  assert.equal(source.includes("const DEPENDENCY_SYNC_BANNER_DISMISSED_KEY = 'scalaLite.deps.syncBanner.dismissed'"), true);
  assert.equal(source.includes('getDependencyWorkspaceFolderCandidates'), true);
  assert.equal(source.includes('maybeShowFirstTimeDependencySyncBanner'), true);
  assert.equal(source.includes('hasDependencyIndexCache(folder)'), true);
  assert.equal(source.includes('Dependency navigation available. Sync classpath to enable go-to-definition for libraries.'), true);
  assert.equal(source.includes("vscode.l10n.t('Not Now')"), true);
  assert.equal(source.includes('vscode.l10n.t("Don\'t Ask Again")'), true);
  assert.equal(source.includes('context.workspaceState.update(DEPENDENCY_SYNC_BANNER_DISMISSED_KEY, true)'), true);
  assert.equal(source.includes('await vscode.commands.executeCommand(COMMAND_SYNC_CLASSPATH, folderToSync.uri)'), true);
});
