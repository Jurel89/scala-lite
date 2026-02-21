import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('IN-0007: package.json defines napi targets and native build scripts', () => {
  const packageJson = JSON.parse(readSource('package.json')) as {
    scripts: Record<string, string>;
    napi: {
      name: string;
      triples: {
        defaults: boolean;
        additional: string[];
      };
    };
  };

  assert.equal(typeof packageJson.scripts['native:build:napi'], 'string');
  assert.equal(packageJson.napi.name, 'scala-lite-engine');
  assert.equal(packageJson.napi.triples.defaults, false);
  assert.deepEqual(packageJson.napi.triples.additional, [
    'x86_64-unknown-linux-gnu',
    'x86_64-apple-darwin',
    'aarch64-apple-darwin',
    'x86_64-pc-windows-msvc'
  ]);
});

test('IN-0007: native-build workflow uses on-demand triggers and 4-platform matrix', () => {
  const workflow = readSource('.github/workflows/native-build.yml');

  assert.equal(workflow.includes('workflow_dispatch:'), true);
  assert.equal(workflow.includes('workflow_call:'), true);
  assert.equal(workflow.includes('contents: read'), true);

  assert.equal(workflow.includes('x86_64-unknown-linux-gnu'), true);
  assert.equal(workflow.includes('x86_64-apple-darwin'), true);
  assert.equal(workflow.includes('aarch64-apple-darwin'), true);
  assert.equal(workflow.includes('x86_64-pc-windows-msvc'), true);

  assert.equal(workflow.includes('npx napi build --platform --release --cargo-cwd native/scala-lite-engine --features napi'), true);
  assert.equal(workflow.includes('actions/upload-artifact@v4'), true);
  assert.equal(workflow.includes('name: native-${{ matrix.target }}'), true);
});

test('TC-0005: release workflow downloads and verifies native binary artifacts before packaging', () => {
  const workflow = readSource('.github/workflows/release.yml');

  assert.equal(workflow.includes('uses: ./.github/workflows/native-build.yml'), true);
  assert.equal(workflow.includes('needs: build-native'), true);
  assert.equal(workflow.includes('actions/download-artifact@v4'), true);
  assert.equal(workflow.includes('pattern: native-*'), true);
  assert.equal(workflow.includes('native/scala-lite-engine/bindings/scala-lite-engine.linux-x64.node'), true);
  assert.equal(workflow.includes('native/scala-lite-engine/bindings/scala-lite-engine.darwin-x64.node'), true);
  assert.equal(workflow.includes('native/scala-lite-engine/bindings/scala-lite-engine.darwin-arm64.node'), true);
  assert.equal(workflow.includes('native/scala-lite-engine/bindings/scala-lite-engine.win32-x64.node'), true);
  assert.equal(workflow.includes('Log VSIX size and bundled native files'), true);
});

test('TC-0005: vscodeignore keeps compiled native bindings and excludes Rust source/build artifacts', () => {
  const vscodeIgnore = readSource('.vscodeignore');

  assert.equal(vscodeIgnore.includes('!native/scala-lite-engine/bindings/*.node'), true);
  assert.equal(vscodeIgnore.includes('native/scala-lite-engine/src/**'), true);
  assert.equal(vscodeIgnore.includes('native/scala-lite-engine/target/**'), true);
  assert.equal(vscodeIgnore.includes('native/scala-lite-engine/Cargo.toml'), true);
  assert.equal(vscodeIgnore.includes('native/scala-lite-engine/Cargo.lock'), true);
});
