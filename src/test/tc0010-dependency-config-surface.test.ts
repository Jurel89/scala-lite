import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readJson<T>(relativePath: string): T {
  const filePath = path.resolve(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

test('TC-0010: package.json contributes dependency and build settings', () => {
  const packageJson = readJson<{
    contributes: {
      configuration: {
        properties: Record<string, unknown>;
      };
    };
  }>('package.json');

  const properties = packageJson.contributes.configuration.properties;

  assert.equal(typeof properties['scalaLite.deps.enabled'], 'object');
  assert.equal(typeof properties['scalaLite.deps.includeInWorkspaceSymbol'], 'object');
  assert.equal(typeof properties['scalaLite.deps.indexTestScope'], 'object');
  assert.equal(typeof properties['scalaLite.deps.indexCaps.maxJars'], 'object');
  assert.equal(typeof properties['scalaLite.deps.indexCaps.maxIndexTimeSeconds'], 'object');
  assert.equal(typeof properties['scalaLite.deps.cache.enabled'], 'object');
  assert.equal(typeof properties['scalaLite.deps.jdkModules'], 'object');
  assert.equal(typeof properties['scalaLite.build.classpathProvider'], 'object');
  assert.equal(typeof properties['scalaLite.build.jdkHome'], 'object');
  assert.equal(typeof properties['scalaLite.build.maven.profiles'], 'object');
  assert.equal(typeof properties['scalaLite.build.maven.args'], 'object');
  assert.equal(typeof properties['scalaLite.build.maven.wrapperPath'], 'object');
  assert.equal(typeof properties['scalaLite.build.sbt.args'], 'object');
  assert.equal(typeof properties['scalaLite.build.sbt.strategy'], 'object');
});

test('TC-0010: schema includes deps and build sections', () => {
  const schema = readJson<{
    properties: Record<string, unknown>;
  }>('schema/scala-lite.schema.json');

  assert.equal(typeof schema.properties.deps, 'object');
  assert.equal(typeof schema.properties.build, 'object');
});
