import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import './vscode-mock';
import { syncMavenClasspathWithJdk, syncSbtClasspathWithJdk } from '../dependencySyncOrchestrator';
import * as mavenProvider from '../mavenProvider';
import * as sbtProvider from '../sbtProvider';
import * as jdkResolver from '../jdkResolver';
import * as scalaLiteCache from '../scalaLiteCache';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0049: dependency sync orchestrator persists sync status and JDK state files', () => {
  const source = readSource('src/dependencySyncOrchestrator.ts');

  assert.equal(source.includes("const SYNC_STATUS_FILE = 'dependency-sync-status.json'"), true);
  assert.equal(source.includes("const JDK_STATE_FILE = 'jdk-modules.json'"), true);
  assert.equal(source.includes('writeDependencySyncFailure'), true);
  assert.equal(source.includes('readDependencySyncStatus'), true);
});

test('FR-0049: Maven sync orchestration composes classpath + JDK resolution and records counts', () => {
  const source = readSource('src/dependencySyncOrchestrator.ts');

  assert.equal(source.includes('resolveMavenClasspath'), true);
  assert.equal(source.includes('resolveSbtClasspath'), true);
  assert.equal(source.includes('resolveJdkModules'), true);
  assert.equal(source.includes('jarsCount'), true);
  assert.equal(source.includes('selectedJdkModuleCount'), true);
  assert.equal(source.includes('availableJdkModuleCount'), true);
  assert.equal(source.includes('syncSbtClasspathWithJdk'), true);
  assert.equal(source.includes('timeoutMs: options.timeoutMs ?? 120_000'), true);
});

test('FR-0049: Maven sync continues with JDK fallback when JDK resolution fails', async () => {
  const workspaceFolder = { name: 'workspace', uri: { fsPath: '/workspace' } } as any;
  const cancellationToken = { isCancellationRequested: false } as any;

  const originalResolveMavenClasspath = (mavenProvider as any).resolveMavenClasspath;
  const originalResolveJdkModules = (jdkResolver as any).resolveJdkModules;
  const originalEnsureScalaLiteCacheDir = (scalaLiteCache as any).ensureScalaLiteCacheDir;

  try {
    (mavenProvider as any).resolveMavenClasspath = async () => ({
      module: {
        artifactId: 'demo-app',
        groupId: 'com.example',
        version: '1.0.0',
        path: '.',
        packaging: 'jar',
        hasScala: true
      },
      jars: ['/cache/a.jar', '/cache/b.jar'],
      outputDirs: ['/workspace/target/classes'],
      cacheFilePath: '/workspace/.scala-lite/classpath-abc123.json'
    });
    (jdkResolver as any).resolveJdkModules = async () => {
      throw new Error('JDK probe failed');
    };
    (scalaLiteCache as any).ensureScalaLiteCacheDir = async () => undefined;

    const status = await syncMavenClasspathWithJdk({
      workspaceFolder,
      module: {
        artifactId: 'demo-app',
        groupId: 'com.example',
        version: '1.0.0',
        path: '.',
        packaging: 'jar',
        hasScala: true
      },
      buildConfig: {
        classpathProvider: 'maven',
        mavenProfiles: [],
        mavenArgs: [],
        sbtArgs: [],
        sbtStrategy: 'auto'
      },
      dependencyConfig: {
        enabled: true,
        includeInWorkspaceSymbol: false,
        indexTestScope: false,
        cacheEnabled: true,
        maxJars: 2000,
        maxIndexTimeSeconds: 120,
        jdkModules: ['java.base', 'java.sql']
      },
      cancellationToken
    });

    assert.equal(status.success, true);
    assert.equal(status.provider, 'maven');
    assert.equal(status.jdkSource, 'none');
    assert.equal(status.selectedJdkModuleCount, 2);
    assert.equal(status.availableJdkModuleCount, 0);
  } finally {
    (mavenProvider as any).resolveMavenClasspath = originalResolveMavenClasspath;
    (jdkResolver as any).resolveJdkModules = originalResolveJdkModules;
    (scalaLiteCache as any).ensureScalaLiteCacheDir = originalEnsureScalaLiteCacheDir;
  }
});

test('FR-0049: SBT sync continues with JDK fallback when JDK resolution fails', async () => {
  const workspaceFolder = { name: 'workspace', uri: { fsPath: '/workspace' } } as any;
  const cancellationToken = { isCancellationRequested: false } as any;

  const originalResolveSbtClasspath = (sbtProvider as any).resolveSbtClasspath;
  const originalResolveJdkModules = (jdkResolver as any).resolveJdkModules;
  const originalEnsureScalaLiteCacheDir = (scalaLiteCache as any).ensureScalaLiteCacheDir;

  try {
    (sbtProvider as any).resolveSbtClasspath = async () => ({
      jars: ['/cache/a.jar'],
      outputDirs: ['/workspace/target/classes'],
      cacheFilePath: '/workspace/.scala-lite/classpath-def456.json',
      strategyUsed: 'coursier'
    });
    (jdkResolver as any).resolveJdkModules = async () => {
      throw new Error('JDK probe failed');
    };
    (scalaLiteCache as any).ensureScalaLiteCacheDir = async () => undefined;

    const status = await syncSbtClasspathWithJdk({
      workspaceFolder,
      buildConfig: {
        classpathProvider: 'sbt',
        mavenProfiles: [],
        mavenArgs: [],
        sbtArgs: [],
        sbtStrategy: 'auto'
      },
      dependencyConfig: {
        enabled: true,
        includeInWorkspaceSymbol: false,
        indexTestScope: false,
        cacheEnabled: true,
        maxJars: 2000,
        maxIndexTimeSeconds: 120,
        jdkModules: ['java.base', 'java.xml']
      },
      cancellationToken
    });

    assert.equal(status.success, true);
    assert.equal(status.provider, 'sbt');
    assert.equal(status.jdkSource, 'none');
    assert.equal(status.selectedJdkModuleCount, 2);
    assert.equal(status.availableJdkModuleCount, 0);
  } finally {
    (sbtProvider as any).resolveSbtClasspath = originalResolveSbtClasspath;
    (jdkResolver as any).resolveJdkModules = originalResolveJdkModules;
    (scalaLiteCache as any).ensureScalaLiteCacheDir = originalEnsureScalaLiteCacheDir;
  }
});
