import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  defaultScalafmtTimeoutMs,
  resolveScalafmtResolution,
  runScalafmtWithTimeout
} from '../scalafmtCore';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0013: binary resolution order prefers configured path over all others', () => {
  const resolution = resolveScalafmtResolution({
    workspaceRoot: '/repo',
    formatterPath: '/custom/scalafmt',
    hasWorkspaceBinary: true,
    hasGlobalBinary: true,
    useDocker: true,
    filePath: '/repo/src/Main.scala',
    workspaceRelativeFilePath: 'src/Main.scala'
  });

  assert.ok(resolution);
  assert.equal(resolution?.command, '/custom/scalafmt');
});

test('FR-0013: binary resolution falls back through workspace binary, global, then docker opt-in', () => {
  const workspaceBin = resolveScalafmtResolution({
    workspaceRoot: '/repo',
    hasWorkspaceBinary: true,
    hasGlobalBinary: true,
    useDocker: true,
    filePath: '/repo/src/Main.scala',
    workspaceRelativeFilePath: 'src/Main.scala'
  });
  const global = resolveScalafmtResolution({
    workspaceRoot: '/repo',
    hasWorkspaceBinary: false,
    hasGlobalBinary: true,
    useDocker: true,
    filePath: '/repo/src/Main.scala',
    workspaceRelativeFilePath: 'src/Main.scala'
  });
  const docker = resolveScalafmtResolution({
    workspaceRoot: '/repo',
    hasWorkspaceBinary: false,
    hasGlobalBinary: false,
    useDocker: true,
    filePath: '/repo/src/Main.scala',
    workspaceRelativeFilePath: 'src/Main.scala'
  });

  assert.equal(workspaceBin?.command, '/repo/.scalafmt-bin');
  assert.equal(global?.command, 'scalafmt');
  assert.equal(docker?.command, 'docker');
});

test('FR-0013: timeout cancels formatting and returns timeout status', async () => {
  const result = await runScalafmtWithTimeout(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { stdout: 'formatted', stderr: '', exitCode: 0 };
    },
    100
  );

  assert.equal(result.status, 'timeout');
});

test('FR-0013: successful execution returns formatted stdout', async () => {
  const result = await runScalafmtWithTimeout(
    async () => ({ stdout: 'formatted', stderr: '', exitCode: 0 }),
    5000
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.stdout, 'formatted');
});

test('FR-0013: default timeout is 5 seconds when not configured', () => {
  assert.equal(defaultScalafmtTimeoutMs({}), 5000);
  assert.equal(defaultScalafmtTimeoutMs({ timeoutMs: 1200 }), 1200);
});

test('FR-0013: missing .scalafmt.conf prompt and format provider wiring are present', () => {
  const featureSource = readSource('src/scalafmtFeature.ts');
  assert.equal(featureSource.includes('No .scalafmt.conf found.'), true);
  assert.equal(featureSource.includes('registerDocumentFormattingEditProvider'), true);
  assert.equal(featureSource.includes('onWillSaveTextDocument'), true);
});
