import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readJson<T>(relativePath: string): T {
  const filePath = path.resolve(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function readText(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('TC-0013: package contributes dependency commands with localized titles', () => {
  const packageJson = readJson<{
    contributes: {
      commands: Array<{ command: string; title: string; category?: string }>;
    };
  }>('package.json');

  const commands = packageJson.contributes.commands;
  const sync = commands.find((entry) => entry.command === 'scalaLite.syncClasspath');
  const fetch = commands.find((entry) => entry.command === 'scalaLite.fetchDependencySources');
  const status = commands.find((entry) => entry.command === 'scalaLite.dependencyStatus');
  const jdkStatus = commands.find((entry) => entry.command === 'scalaLite.dependencyJdkStatus');
  const reset = commands.find((entry) => entry.command === 'scalaLite.resetDependencyCache');

  assert.equal(sync?.title, '%command.scalaLite.syncClasspath.title%');
  assert.equal(fetch?.title, '%command.scalaLite.fetchDependencySources.title%');
  assert.equal(status?.title, '%command.scalaLite.dependencyStatus.title%');
  assert.equal(jdkStatus?.title, '%command.scalaLite.dependencyJdkStatus.title%');
  assert.equal(reset?.title, '%command.scalaLite.resetDependencyCache.title%');

  assert.equal(typeof sync?.category, 'string');
  assert.equal(typeof fetch?.category, 'string');
  assert.equal(typeof status?.category, 'string');
  assert.equal(typeof jdkStatus?.category, 'string');
  assert.equal(typeof reset?.category, 'string');
});

test('TC-0013: command localization and runtime wiring exist', () => {
  const nls = readJson<Record<string, string>>('package.nls.json');
  const source = readText('src/extension.ts');

  assert.equal(typeof nls['command.scalaLite.syncClasspath.title'], 'string');
  assert.equal(typeof nls['command.scalaLite.fetchDependencySources.title'], 'string');
  assert.equal(typeof nls['command.scalaLite.dependencyStatus.title'], 'string');
  assert.equal(typeof nls['command.scalaLite.dependencyJdkStatus.title'], 'string');
  assert.equal(typeof nls['command.scalaLite.resetDependencyCache.title'], 'string');

  assert.equal(source.includes("COMMAND_SYNC_CLASSPATH = 'scalaLite.syncClasspath'"), true);
  assert.equal(source.includes("COMMAND_FETCH_DEPENDENCY_SOURCES = 'scalaLite.fetchDependencySources'"), true);
  assert.equal(source.includes("COMMAND_DEPENDENCY_STATUS = 'scalaLite.dependencyStatus'"), true);
  assert.equal(source.includes("COMMAND_DEPENDENCY_JDK_STATUS = 'scalaLite.dependencyJdkStatus'"), true);
  assert.equal(source.includes("COMMAND_RESET_DEPENDENCY_CACHE = 'scalaLite.resetDependencyCache'"), true);
});
