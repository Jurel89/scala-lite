import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0023: package contributes schema validation for .vscode/scala-lite.json', () => {
  const packageJson = JSON.parse(readSource('package.json')) as {
    contributes: {
      jsonValidation: Array<{ fileMatch: string[]; url: string }>;
    };
  };

  const validation = packageJson.contributes.jsonValidation.find((entry) =>
    entry.fileMatch.includes('/.vscode/scala-lite.json')
  );

  assert.ok(validation);
  assert.equal(validation?.url, './schema/scala-lite.schema.json');
});

test('FR-0023: schema includes required top-level configuration keys', () => {
  const schema = JSON.parse(readSource('schema/scala-lite.schema.json')) as {
    properties: Record<string, unknown>;
  };

  const requiredKeys = [
    'mode',
    'moduleFolder',
    'profiles',
    'activeProfile',
    'ignorePatterns',
    'unsafeMode',
    'budgets',
    'diagnostics',
    'formatter',
    'linter',
    'logLevel',
    'testFrameworkHints'
  ];

  for (const key of requiredKeys) {
    assert.equal(Boolean(schema.properties[key]), true);
  }
});

test('FR-0023: open configuration command is contributed and localized', () => {
  const packageJson = JSON.parse(readSource('package.json')) as {
    contributes: {
      commands: Array<{ command: string; title: string }>;
    };
  };

  const command = packageJson.contributes.commands.find((entry) => entry.command === 'scalaLite.openConfiguration');
  assert.ok(command);
  assert.equal(command?.title, '%command.scalaLite.openConfiguration.title%');

  const nls = JSON.parse(readSource('package.nls.json')) as Record<string, string>;
  assert.equal(nls['command.scalaLite.openConfiguration.title'], 'Open Configuration');
});

test('FR-0023: workspace config feature reloads on save and warns on unknown keys', () => {
  const source = readSource('src/workspaceConfigFeature.ts');
  assert.equal(source.includes('onDidSaveTextDocument'), true);
  assert.equal(source.includes('Unknown config key(s) in .vscode/scala-lite.json'), true);
  assert.equal(source.includes('Scala Lite configuration reloaded.'), true);
});

test('FR-0023: extension wires workspace config feature registration', () => {
  const source = readSource('src/extension.ts');
  assert.equal(source.includes('registerWorkspaceConfigFeature'), true);
  assert.equal(source.includes('getDefaultBuildTool: getPrimaryDetectedBuildTool'), true);
});

test('FR-0023: defaults and key catalog are defined for config bootstrap and validation', () => {
  const source = readSource('src/workspaceConfig.ts');
  assert.equal(source.includes('buildDefaultWorkspaceConfig'), true);
  assert.equal(source.includes("mode: 'C'"), true);
  assert.equal(source.includes('WORKSPACE_CONFIG_TOP_LEVEL_KEYS'), true);
  assert.equal(source.includes('openOrCreateWorkspaceConfig'), true);
});

test('FR-0023: settings UI default mode is C', () => {
  const packageJson = readSource('package.json');
  assert.equal(packageJson.includes('"scalaLite.mode"'), true);
  assert.equal(packageJson.includes('"default": "C"'), true);
});
