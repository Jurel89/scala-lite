import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0012: command contribution includes Generate Debug Configuration', () => {
  const packageJson = readSource('package.json');
  assert.equal(packageJson.includes('"scalaLite.generateDebugConfiguration"'), true);
  assert.equal(packageJson.includes('"scalaLite.debugMainEntry"'), true);
});

test('FR-0012: launch.json generation uses java attach configurations', () => {
  const source = readSource('src/runMainFeature.ts');
  assert.equal(source.includes('function upsertLaunchJsonTemplates()'), true);
  assert.equal(source.includes("request: 'attach'"), true);
  assert.equal(source.includes('Scala Lite: sbt Run (Attach)'), true);
  assert.equal(source.includes('Scala Lite: sbt Test (Attach)'), true);
  assert.equal(source.includes('Scala Lite: scala-cli Run (Attach)'), true);
  assert.equal(source.includes("preLaunchTask: 'sbt -jvm-debug 5005 runMain'"), false);
});

test('FR-0012: debug codelens is provided next to run codelens', () => {
  const source = readSource('src/runMainFeature.ts');
  assert.equal(source.includes("title: '🛠 Debug'"), true);
  assert.equal(source.includes('COMMAND_DEBUG_MAIN_ENTRY'), true);
  assert.equal(source.includes('return [runCodeLens, debugCodeLens, copyCodeLens];'), true);
});

test('FR-0012: missing java debug adapter prompts install action', () => {
  const source = readSource('src/runMainFeature.ts');
  assert.equal(source.includes("JAVA_DEBUG_EXTENSION_ID = 'vscjava.vscode-java-debug'"), true);
  assert.equal(source.includes("Java Debug Adapter extension required."), true);
  assert.equal(source.includes("workbench.extensions.installExtension"), true);
  assert.equal(source.includes('waitForExtensionAvailable'), true);
  assert.equal(source.includes('Reload Window'), true);
});

test('FR-0012: launch.json handling avoids overwriting invalid existing files', () => {
  const source = readSource('src/runMainFeature.ts');
  assert.equal(source.includes('isFileNotFoundError'), true);
  assert.equal(source.includes('contains invalid JSON'), true);
  assert.equal(source.includes('Unable to read existing .vscode/launch.json'), true);
});

test('FR-0012: debug command starts attach debugging after launching process', () => {
  const source = readSource('src/runMainFeature.ts');
  assert.equal(source.includes('toDebugCommand('), true);
  assert.equal(source.includes('vscode.debug.startDebugging'), true);
  assert.equal(source.includes("attachDebugConfiguration('Scala Lite: Attach Main')"), true);
});

test('FR-0012: command titles are localized in package.nls.json', () => {
  const nls = readSource('package.nls.json');
  assert.equal(nls.includes('command.scalaLite.debugMainEntry.title'), true);
  assert.equal(nls.includes('command.scalaLite.generateDebugConfiguration.title'), true);
});
