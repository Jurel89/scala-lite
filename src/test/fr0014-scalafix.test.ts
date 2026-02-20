import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  defaultScalafixTimeoutMs,
  parseScalafixOutputLine,
  resolveScalafixResolution,
  runScalafixWithTimeout
} from '../scalafixCore';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0014: binary resolution order prefers configured path over workspace/global/docker', () => {
  const resolution = resolveScalafixResolution({
    workspaceRoot: '/repo',
    linterPath: '/custom/scalafix',
    hasWorkspaceBinary: true,
    hasGlobalBinary: true,
    useDocker: true,
    filePath: '/repo/src/Main.scala',
    workspaceRelativeFilePath: 'src/Main.scala',
    configPath: '/repo/.scalafix.conf'
  });

  assert.ok(resolution);
  assert.equal(resolution?.command, '/custom/scalafix');
});

test('FR-0014: resolution supports docker fallback with workspace mount', () => {
  const docker = resolveScalafixResolution({
    workspaceRoot: '/repo',
    hasWorkspaceBinary: false,
    hasGlobalBinary: false,
    useDocker: true,
    filePath: '/repo/src/Main.scala',
    workspaceRelativeFilePath: 'src/Main.scala',
    configPath: '/repo/.scalafix.conf'
  });

  assert.equal(docker?.command, 'docker');
  assert.equal(docker?.args.includes('/repo:/workspace'), true);
});

test('FR-0014: parses warning output and marks fixable diagnostics', () => {
  const parsed = parseScalafixOutputLine('[warning] src/main/scala/App.scala:12:5: ExplicitResultTypes is fixable with rewrite');
  assert.ok(parsed);
  assert.equal(parsed?.filePath, 'src/main/scala/App.scala');
  assert.equal(parsed?.line, 12);
  assert.equal(parsed?.column, 5);
  assert.equal(parsed?.fixable, true);
});

test('FR-0014: timeout cancels execution and returns timeout status', async () => {
  const result = await runScalafixWithTimeout(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { stdout: 'rewritten', stderr: '', exitCode: 0 };
    },
    100
  );

  assert.equal(result.status, 'timeout');
});

test('FR-0014: default timeout is 10 seconds when not configured', () => {
  assert.equal(defaultScalafixTimeoutMs({}), 10000);
  assert.equal(defaultScalafixTimeoutMs({ timeoutMs: 2200 }), 2200);
});

test('FR-0014: on-demand command and fix CodeLens wiring are present without background loops', () => {
  const source = readSource('src/scalafixFeature.ts');
  assert.equal(source.includes('scalaLite.runScalafix'), true);
  assert.equal(source.includes("title: '🔧 Fix'"), true);
  assert.equal(source.includes('workspace.applyEdit'), true);
  assert.equal(source.includes('setInterval('), false);
  assert.equal(source.includes('createFileSystemWatcher('), false);
});
