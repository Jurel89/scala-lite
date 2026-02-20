import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0024: BuildAdapter interface and registry are defined', () => {
  const source = readSource('src/buildAdapters.ts');
  assert.equal(source.includes('export interface BuildAdapter'), true);
  assert.equal(source.includes('detect(workspaceRoot: string): Promise<boolean>;'), true);
  assert.equal(source.includes('runMainCommand(mainClass: string, filePath: string, profile: TaskProfile): string;'), true);
  assert.equal(source.includes('runTestCommand(suiteFQN: string, testName: string | undefined, filePath: string, profile: TaskProfile): string;'), true);
  assert.equal(source.includes('export class BuildAdapterRegistry'), true);
  assert.equal(source.includes('private readonly adapters = new Map<string, BuildAdapter>();'), true);
});

test('FR-0024: sbt/mill/scala-cli/custom adapters are shipped and registered', () => {
  const source = readSource('src/buildAdapters.ts');
  assert.equal(source.includes('class SbtAdapter implements BuildAdapter'), true);
  assert.equal(source.includes('class MillAdapter implements BuildAdapter'), true);
  assert.equal(source.includes('class ScalaCliAdapter implements BuildAdapter'), true);
  assert.equal(source.includes('class CustomAdapter implements BuildAdapter'), true);
  assert.equal(source.includes("defaultRegistry.register(new SbtAdapter());"), true);
  assert.equal(source.includes("defaultRegistry.register(new MillAdapter());"), true);
  assert.equal(source.includes("defaultRegistry.register(new ScalaCliAdapter());"), true);
  assert.equal(source.includes("defaultRegistry.register(new CustomAdapter());"), true);
});

test('FR-0024: run main/test features route through adapter registry', () => {
  const runMainSource = readSource('src/runMainFeature.ts');
  const runTestSource = readSource('src/runTestFeature.ts');

  assert.equal(runMainSource.includes('getBuildAdapterRegistry().resolveFor(buildTool, profile)'), true);
  assert.equal(runMainSource.includes('adapter.runMainCommand'), true);

  assert.equal(runTestSource.includes('getBuildAdapterRegistry().resolveFor(buildTool, profile)'), true);
  assert.equal(runTestSource.includes('.runTestCommand('), true);
});

test('FR-0024: adapter output parser support is wired for diagnostic parsing', () => {
  const source = readSource('src/buildAdapters.ts');
  assert.equal(source.includes('parseErrors(output: string): vscode.Diagnostic[];'), true);
  assert.equal(source.includes('parseBuildOutputLine'), true);
  assert.equal(source.includes('diagnosticsFromOutput'), true);
});
